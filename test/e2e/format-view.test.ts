/**
 * E2E: POST /format → GET /v/{slug}.
 *
 * Full round-trip with every external service replaced by a local fixture
 * (chrono-storage over loopback HTTP, NyxID JWKS + LLM Gateway over loopback
 * HTTP, Supabase via an in-memory `__setClient__` fake). This is the broadest
 * possible integration check: the request handler, the schema validators, the
 * renderer, and the dual-write ordering all run unmodified.
 *
 * Assertions:
 *   - 200 + `{url: "/v/<page_id>"}` shape.
 *   - GET that URL returns HTML with:
 *     - The fixture-planner's title.
 *     - A spec-specific class (`spec-executive-broadsheet`).
 *     - The provenance strip wordmark `NOCTURNE`.
 *   - Cache-control is `immutable`.
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

const USER_ID = "11111111-1111-1111-1111-111111111111";

let H!: E2EHarness;

beforeAll(async () => {
  H = await bootE2E(USER_ID);
});

afterAll(() => {
  H.disposeJwks();
});

beforeEach(() => {
  resetFixtureState();
});

describe("E2E: POST /format → GET /v/{slug}", () => {
  test("happy path — formatted page is retrievable via the returned URL", async () => {
    setPlannerOverride(() => ({
      content_type: "daily_brief_v1",
      title: "E2E smoke headline",
      spec_id: "executive-broadsheet",
      summary: "An executive-broadsheet smoke test.",
      top_priorities: [
        {
          title: "Verify round-trip",
          why_it_matters: "Confirms the dual-write ordering works end to end",
        },
      ],
      timeline: [],
      watchlist: [],
      notes: [],
    }));

    const app = mountFullApp();
    const postRes = await app.request("/format", {
      method: "POST",
      headers: await authHeaders(H.keypair, USER_ID),
      body: JSON.stringify({ content: "hello nocturne e2e" }),
    });
    expect(postRes.status).toBe(200);
    const { url } = (await postRes.json()) as { url: string };
    expect(url).toMatch(/^http:\/\/localhost:7701\/v\/[0-9A-Za-z]+$/);

    // Extract the `page_id` suffix and re-fetch through the same app.
    const slug = url.split("/").at(-1)!;
    const getRes = await app.request(`/v/${slug}`);
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    const html = await getRes.text();

    // Fixture-planner title round-trips into the <title>.
    expect(html).toContain("<title>E2E smoke headline</title>");
    // Spec-specific class survived the renderer.
    expect(html).toContain("spec-executive-broadsheet");
    // Provenance strip is present.
    expect(html).toContain("NOCTURNE");
    // Issue number reflects the first sequence (1).
    expect(html).toContain("Issue #1");
  });

  test("spec class matches the planner's choice", async () => {
    setPlannerOverride(() => ({
      content_type: "daily_brief_v1",
      title: "A quieter day",
      spec_id: "quiet-ledger",
      top_priorities: [],
      timeline: [],
      watchlist: [],
      notes: [],
    }));

    const app = mountFullApp();
    const postRes = await app.request("/format", {
      method: "POST",
      headers: await authHeaders(H.keypair, USER_ID),
      body: JSON.stringify({ content: "a slow, reflective morning" }),
    });
    expect(postRes.status).toBe(200);
    const { url } = (await postRes.json()) as { url: string };
    const slug = url.split("/").at(-1)!;
    const getRes = await app.request(`/v/${slug}`);
    const html = await getRes.text();
    // The body class reflects the planner's chosen spec (guards against
    // cross-contamination with other specs mentioned in print.css).
    expect(html).toMatch(/<body class="[^"]*\bspec-quiet-ledger\b[^"]*"/);
    // The <meta name="nocturne:spec"> tag is the canonical identifier.
    expect(html).toContain(
      '<meta name="nocturne:spec" content="quiet-ledger"',
    );
  });
});
