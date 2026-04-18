/**
 * E2E: storage-level failure surfaces as `502 storage_unavailable`, and no
 * Supabase row is written.
 *
 * The dual-write ordering in `/format` puts chrono BEFORE supabase
 * (see `src/routes/format.ts`): a storage failure must short-circuit before
 * we touch the index. This test configures the chrono fixture to return a
 * 503 on PUT and asserts:
 *
 *   - 502 `storage_unavailable` at the HTTP layer.
 *   - `indexState.pages` stays empty.
 *   - `indexState.sequences` *did* advance (nextSequence happens before
 *     storage by design — that's a known minor wart in the orderly failure
 *     model, worth pinning here so a future refactor that "fixes" it
 *     surfaces in a test diff rather than surprising prod).
 */
import "./fixture-env.ts"; // MUST be first

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import {
  authHeaders,
  bootE2E,
  mountFullApp,
  type E2EHarness,
} from "./fixture-helpers.ts";
import {
  resetFixtureState,
  setChronoPutOverride,
  setPlannerOverride,
} from "./fixture-server.ts";

const USER_ID = "66666666-6666-6666-6666-666666666666";

let H!: E2EHarness;

beforeAll(async () => {
  H = await bootE2E(USER_ID);
});

afterAll(() => {
  H.disposeJwks();
});

beforeEach(() => {
  resetFixtureState();
  H.indexState.sequences.clear();
  H.indexState.pages.length = 0;
});

describe("E2E: storage failure surfaces as 502", () => {
  test("chrono 503 on PUT → 502 storage_unavailable, no pages row written", async () => {
    setPlannerOverride(() => ({
      content_type: "daily_brief_v1",
      title: "Doomed brief",
      spec_id: "executive-broadsheet",
      top_priorities: [],
      timeline: [],
      watchlist: [],
      notes: [],
    }));

    setChronoPutOverride(() => {
      // Any 5xx with a JSON error envelope maps to
      // `StorageError{code:"unavailable"}` in `chrono.ts`.
      return Response.json(
        { error: { code: "upstream_down" } },
        { status: 503 },
      );
    });

    const app = mountFullApp();
    const res = await app.request("/format", {
      method: "POST",
      headers: await authHeaders(H.keypair, USER_ID),
      body: JSON.stringify({ content: "any input" }),
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "storage_unavailable" });

    // Most important: no page row landed.
    expect(H.indexState.pages.length).toBe(0);

    // nextSequence *does* run before storage (documented in format.ts) —
    // pinning the current behaviour so a refactor surfaces in a test diff.
    expect(H.indexState.sequences.get(USER_ID)).toBe(1);
  });

  test("chrono 500 on PUT (integrity-shaped) → 500 storage_integrity_error", async () => {
    setPlannerOverride(() => ({
      content_type: "daily_brief_v1",
      title: "Another doomed brief",
      spec_id: "executive-broadsheet",
      top_priorities: [],
      timeline: [],
      watchlist: [],
      notes: [],
    }));

    // 4xx that isn't 404 → integrity error per `chrono.ts`.
    setChronoPutOverride(() => {
      return Response.json(
        { error: { code: "bad_shape" } },
        { status: 422 },
      );
    });

    const app = mountFullApp();
    const res = await app.request("/format", {
      method: "POST",
      headers: await authHeaders(H.keypair, USER_ID),
      body: JSON.stringify({ content: "any input" }),
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "storage_integrity_error",
    });
    expect(H.indexState.pages.length).toBe(0);
  });
});
