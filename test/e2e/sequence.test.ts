/**
 * E2E: sequential /format calls produce monotonically increasing issue #s.
 *
 * Two POST /format from the same user → two distinct slugs, two rows in the
 * in-memory pages store, and `last_seq` increments 1 → 2 between them. We also
 * assert the provenance strip on each rendered page reflects "Issue #N" with
 * the matching N.
 *
 * This test is orthogonal to the concurrent one in `concurrent-format.test.ts`:
 * here we're proving the sequence is actually visible at the HTTP layer, not
 * just internally atomic.
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

const USER_ID = "22222222-2222-2222-2222-222222222222";

let H!: E2EHarness;

beforeAll(async () => {
  H = await bootE2E(USER_ID);
});

afterAll(() => {
  H.disposeJwks();
});

beforeEach(() => {
  resetFixtureState();
  // Fresh sequence state per test.
  H.indexState.sequences.clear();
  H.indexState.pages.length = 0;
});

describe("E2E: sequential /format", () => {
  test("two sequential POSTs yield distinct slugs and seqs 1 then 2", async () => {
    setPlannerOverride((content) => ({
      content_type: "daily_brief_v1",
      title: `Brief ${content.length}`,
      spec_id: "executive-broadsheet",
      top_priorities: [],
      timeline: [],
      watchlist: [],
      notes: [],
    }));

    const app = mountFullApp();
    const headers = await authHeaders(H.keypair, USER_ID);

    const r1 = await app.request("/format", {
      method: "POST",
      headers,
      body: JSON.stringify({ content: "first" }),
    });
    expect(r1.status).toBe(200);
    const url1 = ((await r1.json()) as { url: string }).url;
    const slug1 = url1.split("/").at(-1)!;

    const r2 = await app.request("/format", {
      method: "POST",
      headers,
      body: JSON.stringify({ content: "a bit longer second" }),
    });
    expect(r2.status).toBe(200);
    const url2 = ((await r2.json()) as { url: string }).url;
    const slug2 = url2.split("/").at(-1)!;

    // Distinct slugs.
    expect(slug1).not.toBe(slug2);

    // Supabase fake tracked the sequence for just this user.
    expect(H.indexState.sequences.get(USER_ID)).toBe(2);

    // And the two pages landed in the in-memory index.
    expect(H.indexState.pages.map((p) => p.page_id).sort()).toEqual(
      [slug1, slug2].sort(),
    );

    // The rendered pages carry "Issue #1" and "Issue #2" respectively.
    const h1 = await (await app.request(`/v/${slug1}`)).text();
    const h2 = await (await app.request(`/v/${slug2}`)).text();
    expect(h1).toContain("Issue #1");
    expect(h2).toContain("Issue #2");
  });
});
