/**
 * E2E: two concurrent POST /format from the same user.
 *
 * Unit-level atomicity for `nextSequence` is covered in
 * `src/index/supabase.test.ts` — that test serialises the responder the same
 * way Postgres's per-row UPDATE lock would. Here we prove the HTTP layer
 * preserves it: two in-flight requests from the same user MUST resolve to
 * distinct slugs with distinct sequence numbers, and the Supabase fake MUST
 * show exactly N+1 rows after both land.
 *
 * The fixture's in-memory `dispatchQuery` is synchronous inside each call, so
 * "concurrent" here means dispatch-serialised Promises — the same semantic
 * Postgres itself provides at the per-row level. The bug this test guards
 * against is `POST /format` accidentally caching or sharing sequence numbers
 * at any point above the DB layer.
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
import { resetFixtureState, setPlannerOverride } from "./fixture-server.ts";

const USER_ID = "33333333-3333-3333-3333-333333333333";

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

describe("E2E: concurrent /format", () => {
  test("two parallel POSTs return distinct slugs and sequential seqs", async () => {
    setPlannerOverride(() => ({
      content_type: "daily_brief_v1",
      title: "Concurrent smoke",
      spec_id: "executive-broadsheet",
      top_priorities: [],
      timeline: [],
      watchlist: [],
      notes: [],
    }));

    const app = mountFullApp();
    const headers = await authHeaders(H.keypair, USER_ID);

    const [r1, r2] = await Promise.all([
      app.request("/format", {
        method: "POST",
        headers,
        body: JSON.stringify({ content: "one" }),
      }),
      app.request("/format", {
        method: "POST",
        headers,
        body: JSON.stringify({ content: "two" }),
      }),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    const url1 = ((await r1.json()) as { url: string }).url;
    const url2 = ((await r2.json()) as { url: string }).url;
    const slug1 = url1.split("/").at(-1)!;
    const slug2 = url2.split("/").at(-1)!;

    // Distinct slugs — the 120-bit entropy alone makes a collision
    // effectively impossible, but we're really asserting "the handler didn't
    // accidentally cache one and return it twice".
    expect(slug1).not.toBe(slug2);

    // Sequence advanced exactly twice.
    expect(H.indexState.sequences.get(USER_ID)).toBe(2);

    // Both pages hit the index, each with a unique seq-adjacent page_id.
    expect(H.indexState.pages.length).toBe(2);
    const pageIds = H.indexState.pages.map((p) => p.page_id);
    expect(new Set(pageIds).size).toBe(2);
    expect(new Set(pageIds)).toEqual(new Set([slug1, slug2]));
  });
});
