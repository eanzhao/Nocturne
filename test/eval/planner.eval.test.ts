/**
 * LLM quality eval — does the planner pick the "right" spec for each fixture?
 *
 * Two modes:
 *
 *   - **Mock mode (default).** Runs in CI on every `bun test`. We hand the
 *     planner a `fetchImpl` that returns a hardcoded OpenAI-shaped response
 *     per fixture — that exercises the Zod + spec-fallback path end-to-end
 *     without burning LLM credits. The hardcoded response carries the
 *     manual-vetted expected `spec_id`, so this mode verifies the harness
 *     is wired correctly, not the model's taste.
 *
 *   - **Real mode.** Set `EVAL=1` to actually call
 *     `NYXID_BASE_URL/api/v1/llm/gateway/v1/chat/completions` with
 *     `process.env.NYXID_SERVICE_TOKEN` as the bearer. This is where the
 *     ≥ 2/3 threshold is meaningful.
 *
 * `bun test` CI green-ness is preserved by wrapping the "does the model
 * agree with the vetted answers" assertion in `describe.skipIf(!EVAL)`.
 */
import "../e2e/fixture-env.ts"; // MUST be first — populates config env

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, test } from "bun:test";

import { DailyBriefBlock, type DailyBrief } from "../../src/schema/daily-brief.ts";
import {
  PLANNER_SOFT_TIMEOUT_MS,
  planDailyBrief,
  type FetchLike,
} from "../../src/llm/gateway.ts";

type SpecId = DailyBrief["spec_id"];
const SPEC_IDS: readonly SpecId[] = [
  "executive-broadsheet",
  "quiet-ledger",
  "guji-classical",
];

function toSpecId(raw: string): SpecId {
  if ((SPEC_IDS as readonly string[]).includes(raw)) {
    return raw as SpecId;
  }
  throw new Error(
    `fixtures expected-spec-ids.json contains an unknown spec_id: ${raw}`,
  );
}

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const FIXTURES_DIR = join(dirname(__filename), "fixtures");

interface Fixture {
  name: string;
  content: string;
  expectedSpecId: SpecId;
}

async function loadFixtures(): Promise<Fixture[]> {
  const expectedRaw = await readFile(
    join(FIXTURES_DIR, "expected-spec-ids.json"),
    "utf8",
  );
  const expected = JSON.parse(expectedRaw) as Record<string, string>;

  const out: Fixture[] = [];
  for (const name of Object.keys(expected)) {
    const content = await readFile(
      join(FIXTURES_DIR, `${name}.txt`),
      "utf8",
    );
    out.push({
      name,
      content,
      expectedSpecId: toSpecId(expected[name]!),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mock fetch — canned OpenAI-shaped envelope.
// ---------------------------------------------------------------------------

/**
 * Build a `fetchImpl` that returns the vetted `spec_id` for each fixture,
 * wrapped in a minimum-viable `DailyBrief`. Keeping the response short keeps
 * the mock from masking a schema regression (the Zod parse still has to
 * accept every field).
 */
function makeMockFetch(fixtures: Fixture[]): FetchLike {
  return async (_url, init) => {
    const body = JSON.parse((init.body as string) ?? "{}") as {
      messages: Array<{ role: string; content: string }>;
    };
    const userMsg = body.messages.find((m) => m.role === "user");
    const content = userMsg?.content ?? "";

    // Match fixture by substring of the input content (within the
    // buildUserPrompt `<brief>…</brief>` wrapper).
    const fixture = fixtures.find((f) =>
      content.includes(f.content.slice(0, 40).trim()),
    );
    if (!fixture) {
      throw new Error(`planner mock: no fixture matched content`);
    }
    const brief = {
      content_type: "daily_brief_v1",
      title: `Eval fixture: ${fixture.name}`,
      spec_id: fixture.expectedSpecId,
      top_priorities: [],
      timeline: [],
      watchlist: [],
      notes: [],
    };
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(brief) } }],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };
}

// ---------------------------------------------------------------------------
// Real-mode fetch — uses process.env.NYXID_SERVICE_TOKEN bearer
// ---------------------------------------------------------------------------

const realFetch: FetchLike = async (url, init) => {
  return fetch(url, init);
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const EVAL_MODE = process.env.EVAL === "1";
const REAL_BEARER = process.env.NYXID_SERVICE_TOKEN;

describe("planner eval — mock mode (default)", () => {
  test("every fixture produces a Zod-valid daily_brief_v1", async () => {
    const fixtures = await loadFixtures();
    const fetchImpl = makeMockFetch(fixtures);
    for (const f of fixtures) {
      const out = await planDailyBrief(f.content, "test-bearer", {
        fetchImpl,
        timeoutMs: 2_000,
      });
      const reparsed = DailyBriefBlock.safeParse(out.brief);
      expect(reparsed.success).toBe(true);
      expect(out.brief.spec_id).toBe(f.expectedSpecId);
    }
  });

  test("the fixture set covers all three vetted spec_ids", async () => {
    const fixtures = await loadFixtures();
    const specs = new Set(fixtures.map((f) => f.expectedSpecId));
    expect(specs).toEqual(
      new Set(["executive-broadsheet", "quiet-ledger", "guji-classical"]),
    );
    expect(fixtures.length).toBe(3);
  });
});

/**
 * Real-call eval — opt-in via EVAL=1 to avoid burning LLM credits in CI.
 *
 * The threshold is ≥ 2/3 (67%), relaxed from the v0 goal of 80% because a
 * 3-sample baseline cannot statistically justify 80% — two of three correct
 * is the strongest meaningful signal at N=3.
 */
describe.skipIf(!EVAL_MODE)("planner eval — real NyxID LLM Gateway", () => {
  test("spec_id agreement ≥ 2/3", async () => {
    if (!REAL_BEARER) {
      throw new Error(
        "EVAL=1 requires NYXID_SERVICE_TOKEN to be set in the environment",
      );
    }
    const fixtures = await loadFixtures();
    const results: Array<{
      name: string;
      got: string;
      want: string;
    }> = [];

    for (const f of fixtures) {
      const out = await planDailyBrief(f.content, REAL_BEARER, {
        fetchImpl: realFetch,
        timeoutMs: PLANNER_SOFT_TIMEOUT_MS,
      });
      const reparsed = DailyBriefBlock.safeParse(out.brief);
      expect(reparsed.success).toBe(true);
      results.push({
        name: f.name,
        got: out.brief.spec_id,
        want: f.expectedSpecId,
      });
    }

    const hits = results.filter((r) => r.got === r.want).length;
    const hitRate = hits / results.length;
    // Surface the full matrix for debugging on threshold failures.
    // eslint-disable-next-line no-console
    console.log(
      `planner eval — ${hits}/${results.length} = ${(hitRate * 100).toFixed(0)}%`,
    );
    for (const r of results) {
      // eslint-disable-next-line no-console
      console.log(
        `  ${r.name}: got=${r.got} want=${r.want} ${r.got === r.want ? "OK" : "MISS"}`,
      );
    }
    expect(hitRate).toBeGreaterThanOrEqual(2 / 3);
  });
});
