/**
 * E2E: full archive-share lifecycle.
 *
 * Flow under test (mirrors the issue brief):
 *   1. POST /format × 3 to accumulate three pages for a user.
 *   2. POST /u/share → captures a plaintext token + token_id.
 *   3. Anonymous GET /u/{slug}?token=... → 200, lists three rows.
 *   4. DELETE /u/share/{token_id} → token revoked.
 *   5. Repeat the GET with the same token → 401 invalid_share_token.
 *
 * Why this is an E2E and not a unit test: the archive + archive-share +
 * format routers each talk to the same Supabase index, and together they
 * encode the full revocation semantics. A unit test mocking supabase.ts
 * misses the "does the share handler actually see the revoke that the
 * share-share handler wrote" coupling.
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

import { config } from "../../src/config.ts";
import {
  authHeaders,
  bootE2E,
  mountFullApp,
  type E2EHarness,
} from "./fixture-helpers.ts";
import { resetFixtureState, setPlannerOverride } from "./fixture-server.ts";

const USER_ID = "55555555-5555-5555-5555-555555555555";

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
  H.indexState.shareTokens.length = 0;
});

describe("E2E: archive share lifecycle", () => {
  test("format×3 → mint share → anon list → revoke → anon 401", async () => {
    setPlannerOverride((content) => ({
      content_type: "daily_brief_v1",
      title: `Entry ${content}`,
      spec_id: "executive-broadsheet",
      top_priorities: [],
      timeline: [],
      watchlist: [],
      notes: [],
    }));

    const app = mountFullApp();
    const ownerHeaders = await authHeaders(H.keypair, USER_ID);

    // Step 1 — three POST /format calls from the owner.
    for (const label of ["a", "b", "c"]) {
      const res = await app.request("/format", {
        method: "POST",
        headers: ownerHeaders,
        body: JSON.stringify({ content: label }),
      });
      expect(res.status).toBe(200);
    }
    expect(H.indexState.pages.length).toBe(3);

    // Step 2 — mint a share token.
    const mintRes = await app.request("/u/share", {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({ ttl_days: 30 }),
    });
    expect(mintRes.status).toBe(201);
    const mint = (await mintRes.json()) as {
      token: string;
      token_id: string;
      url: string;
    };
    expect(mint.token.length).toBeGreaterThan(10);
    expect(mint.url).toContain(`/u/${H.ownerSlug}?token=`);

    // Step 3 — anonymous GET /u/{slug}?token=... returns list.
    const listRes = await app.request(
      `/u/${H.ownerSlug}?token=${encodeURIComponent(mint.token)}`,
    );
    expect(listRes.status).toBe(200);
    const listBody = await listRes.text();
    expect(listBody).toContain("<h1>All your Nocturnes</h1>");
    expect(listBody).toContain("3 Nocturnes");
    for (const pageId of H.indexState.pages.map((p) => p.page_id)) {
      expect(listBody).toContain(pageId);
    }

    // Step 4 — revoke.
    const revokeRes = await app.request(`/u/share/${mint.token_id}`, {
      method: "DELETE",
      headers: ownerHeaders,
    });
    expect(revokeRes.status).toBe(200);

    // Step 5 — same URL now 401s.
    const afterRevokeRes = await app.request(
      `/u/${H.ownerSlug}?token=${encodeURIComponent(mint.token)}`,
    );
    expect(afterRevokeRes.status).toBe(401);
    expect(await afterRevokeRes.json()).toEqual({
      error: "invalid_share_token",
    });
  });

  test("anon GET without token gets 401 auth_required", async () => {
    const app = mountFullApp();
    const res = await app.request(`/u/${H.ownerSlug}`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "auth_required" });
  });

  test("the minted share URL roots on BASE_URL + the owner slug", async () => {
    setPlannerOverride(() => ({
      content_type: "daily_brief_v1",
      title: "x",
      spec_id: "executive-broadsheet",
      top_priorities: [],
      timeline: [],
      watchlist: [],
      notes: [],
    }));

    const app = mountFullApp();
    const mintRes = await app.request("/u/share", {
      method: "POST",
      headers: await authHeaders(H.keypair, USER_ID),
      body: JSON.stringify({ ttl_days: 7 }),
    });
    expect(mintRes.status).toBe(201);
    const mint = (await mintRes.json()) as { url: string; token: string };
    // The sharing URL is the one the owner pastes to a teammate — it must
    // be anchored on BASE_URL (so the archive page fetched via the token
    // resolves externally too). Anything else is a packaging bug.
    expect(mint.url).toBe(
      `${config.BASE_URL}/u/${H.ownerSlug}?token=${encodeURIComponent(mint.token)}`,
    );
  });
});
