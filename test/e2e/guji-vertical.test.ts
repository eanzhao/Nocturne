/**
 * E2E: forcing `spec_id: "guji-classical"` from the planner surfaces
 * `writing-mode: vertical-rl` in the rendered HTML.
 *
 * This is the contract test for the vertical-rl path. The renderer has three
 * ways it signals the writing mode (per `src/renderer/render-page.tsx`):
 *
 *   1. `<html data-writing-mode="vertical-rl">` attribute.
 *   2. `<html class="writing-mode-vertical-rl">` class.
 *   3. A `--writing-mode: vertical-rl` CSS custom property on `:root`.
 *
 * We assert all three. If any one goes missing, the vertical layout silently
 * degrades to horizontal — which is the kind of bug that would reach
 * production before anyone noticed because `base.css` still compiles.
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

const USER_ID = "44444444-4444-4444-4444-444444444444";

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

describe("E2E: guji-classical vertical writing mode", () => {
  test("planner-forced guji-classical renders vertical-rl markers", async () => {
    setPlannerOverride(() => ({
      content_type: "daily_brief_v1",
      title: "天行健君子以自强不息",
      spec_id: "guji-classical",
      hero_quote: "大学之道在明明德",
      top_priorities: [],
      timeline: [],
      watchlist: [],
      notes: [],
    }));

    const app = mountFullApp();
    const res = await app.request("/format", {
      method: "POST",
      headers: await authHeaders(H.keypair, USER_ID),
      body: JSON.stringify({ content: "classical content" }),
    });
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    const slug = url.split("/").at(-1)!;

    const viewRes = await app.request(`/v/${slug}`);
    const html = await viewRes.text();

    // 1. <html data-writing-mode="vertical-rl">
    expect(html).toContain('data-writing-mode="vertical-rl"');

    // 2. body carries the writing-mode class AND spec class.
    expect(html).toMatch(
      /<body class="[^"]*\bwriting-mode-vertical-rl\b[^"]*\bspec-guji-classical\b[^"]*"/,
    );

    // 3. :root variable mirrors the spec.
    expect(html).toContain("--writing-mode: vertical-rl;");

    // Bonus: base.css is inlined and does apply `writing-mode: vertical-rl`
    // on the `.writing-mode-vertical-rl` scope. We just grep for the literal
    // pairing that CSS rule uses.
    expect(html).toMatch(
      /\.writing-mode-vertical-rl\s*\{[^}]*writing-mode:\s*vertical-rl/,
    );
  });
});
