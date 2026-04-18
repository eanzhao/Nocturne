/**
 * Tests for `POST /format`.
 *
 * Strategy: mock every external dependency (LLM gateway, chrono storage,
 * supabase index, nyxidAuth middleware, spec loader) via `mock.module`. Run
 * the route's sub-router directly — no full app.ts wiring required.
 *
 * The happy-path assertion proves the dual-write ordering:
 *   planner → nextSequence → renderPage → chrono.putObject → supabase.insertPage
 */
process.env.BASE_URL ??= "http://localhost:7701";
process.env.DATABASE_URL ??= "postgres://localhost/test";
process.env.CHRONO_STORAGE_URL ??= "http://127.0.0.1:3805";
process.env.NYXID_BASE_URL ??= "http://127.0.0.1:9000";
process.env.NYXID_JWKS_URL ??= "http://127.0.0.1:9000/.well-known/jwks.json";
process.env.NYXID_SERVICE_SECRET ??=
  "test-secret-test-secret-test-secret-xxxxxxxxxx";

import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

// ---------------------------------------------------------------------------
// Fake error classes (identity-matched via mock.module swap)

class FakePlannerTimeout extends Error {
  override name = "PlannerTimeout" as const;
}
class FakePlannerInvalidOutput extends Error {
  override name = "PlannerInvalidOutput" as const;
  rawResponse: string;
  constructor(message: string, rawResponse = "") {
    super(message);
    this.rawResponse = rawResponse;
  }
}
class FakePlannerUpstreamError extends Error {
  override name = "PlannerUpstreamError" as const;
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}
class FakePlannerRateLimited extends Error {
  override name = "PlannerRateLimited" as const;
  body: string;
  constructor(body = "rl") {
    super("rate limited");
    this.body = body;
  }
}

class FakeStorageError extends Error {
  override name = "StorageError" as const;
  code: "timeout" | "not_found" | "unavailable" | "integrity";
  constructor(
    code: "timeout" | "not_found" | "unavailable" | "integrity",
    message = "err",
  ) {
    super(message);
    this.code = code;
  }
}

class FakeIndexError extends Error {
  override name = "IndexError" as const;
  code: "timeout" | "duplicate" | "constraint" | "unavailable";
  constructor(
    code: "timeout" | "duplicate" | "constraint" | "unavailable",
    message = "err",
  ) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Mock state — driven per test.

interface PlannerResult {
  brief: unknown;
  fallbackReason?: "invalid_spec_id";
  rawLLMOutput?: unknown;
}

let mockPlanResult: PlannerResult | Error = {
  brief: {
    content_type: "daily_brief_v1",
    title: "Morning digest",
    spec_id: "executive-broadsheet",
    top_priorities: [],
    timeline: [],
    watchlist: [],
    notes: [],
  },
};

let putObjectCalls: Array<{
  bucket: string;
  key: string;
  body: string;
  contentType: string;
}> = [];
let mockPutObject: (
  bucket: string,
  key: string,
  body: string | Uint8Array | ArrayBuffer,
  contentType: string,
) => Promise<{ url: string }> = async () => ({ url: "s3://x" });

let insertPageCalls: Array<Record<string, unknown>> = [];
let mockInsertPage: (input: Record<string, unknown>) => Promise<void> =
  async () => {};

let nextSequenceCalls = 0;
let mockNextSequence: (userId: string) => Promise<number> = async () => 1;

let logPlannerFallbackCalls: Array<{
  page_id: string;
  reason: string;
  raw: unknown;
}> = [];

let renderPageCalls: Array<{ brief: unknown; spec: unknown; ctx: unknown }> = [];
const RENDERED_HTML = "<!doctype html><html><body>rendered</body></html>";

// NyxID auth stub — injects a fake user_id so the handler can proceed.
const NYXID_USER_ID = "user-abc-123";

mock.module("../middleware/auth.ts", () => ({
  nyxidAuth: async (c: { set: (k: string, v: string) => void }, next: () => Promise<void>) => {
    c.set("user_id", NYXID_USER_ID);
    await next();
  },
}));

mock.module("../llm/gateway.ts", () => ({
  PlannerTimeout: FakePlannerTimeout,
  PlannerInvalidOutput: FakePlannerInvalidOutput,
  PlannerUpstreamError: FakePlannerUpstreamError,
  PlannerRateLimited: FakePlannerRateLimited,
  planDailyBrief: async () => {
    if (mockPlanResult instanceof Error) throw mockPlanResult;
    return mockPlanResult;
  },
}));

mock.module("../storage/chrono.ts", () => ({
  StorageError: FakeStorageError,
  putObject: (
    bucket: string,
    key: string,
    body: string,
    contentType: string,
  ) => {
    putObjectCalls.push({ bucket, key, body, contentType });
    return mockPutObject(bucket, key, body, contentType);
  },
}));

mock.module("../index/supabase.ts", () => ({
  IndexError: FakeIndexError,
  nextSequence: (userId: string) => {
    nextSequenceCalls += 1;
    return mockNextSequence(userId);
  },
  insertPage: (input: Record<string, unknown>) => {
    insertPageCalls.push(input);
    return mockInsertPage(input);
  },
  logPlannerFallback: async (
    page_id: string,
    reason: string,
    raw: unknown,
  ) => {
    logPlannerFallbackCalls.push({ page_id, reason, raw });
  },
}));

mock.module("../renderer/render-page.tsx", () => ({
  renderPage: (brief: unknown, spec: unknown, ctx: unknown) => {
    renderPageCalls.push({ brief, spec, ctx });
    return RENDERED_HTML;
  },
}));

type FormatModule = typeof import("./format.ts");
let formatMod!: FormatModule;

beforeAll(async () => {
  formatMod = await import("./format.ts");
  // Install a stub spec set so we don't need to read JSON off disk.
  formatMod.__resetSpecsForTesting(
    new Map<string, unknown>([
      ["executive-broadsheet", { id: "executive-broadsheet" } as unknown],
      ["quiet-ledger", { id: "quiet-ledger" } as unknown],
      ["guji-classical", { id: "guji-classical" } as unknown],
    ]) as unknown as Parameters<typeof formatMod.__resetSpecsForTesting>[0],
  );
});

function makeApp() {
  const app = new Hono();
  app.route("/", formatMod.formatRouter);
  return app;
}

async function postFormat(
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const app = makeApp();
  return app.request("/format", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-nyxid-delegation-token": "deleg-token",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  putObjectCalls = [];
  insertPageCalls = [];
  logPlannerFallbackCalls = [];
  renderPageCalls = [];
  nextSequenceCalls = 0;
  mockPutObject = async () => ({ url: "s3://x" });
  mockInsertPage = async () => {};
  mockNextSequence = async () => 42;
  mockPlanResult = {
    brief: {
      content_type: "daily_brief_v1",
      title: "Morning digest",
      spec_id: "executive-broadsheet",
      top_priorities: [],
      timeline: [],
      watchlist: [],
      notes: [],
    },
  };
});

// ---------------------------------------------------------------------------

describe("POST /format — happy path", () => {
  test("returns 200 with the /v/{page_id} URL", async () => {
    const res = await postFormat({ content: "hello" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    expect(body.url).toMatch(/^http:\/\/localhost:7701\/v\/[0-9A-Za-z]+$/);
  });

  test("dual-write ordering: nextSequence → render → putObject → insertPage", async () => {
    const res = await postFormat({ content: "hello" });
    expect(res.status).toBe(200);

    expect(nextSequenceCalls).toBe(1);
    expect(renderPageCalls.length).toBe(1);
    expect(putObjectCalls.length).toBe(1);
    expect(insertPageCalls.length).toBe(1);

    const put = putObjectCalls[0]!;
    expect(put.bucket).toBe("nocturne");
    expect(put.key).toMatch(
      new RegExp(`^${NYXID_USER_ID}/[0-9A-Za-z]+\\.html$`),
    );
    expect(put.body).toBe(RENDERED_HTML);
    expect(put.contentType).toBe("text/html; charset=utf-8");

    const ins = insertPageCalls[0]!;
    expect(ins.user_id).toBe(NYXID_USER_ID);
    expect(ins.spec_id).toBe("executive-broadsheet");
    expect(ins.content_type).toBe("daily_brief_v1");
    expect(ins.storage_key).toBe(put.key);
  });

  test("render ctx carries seq, model, owner_slug (not raw user_id leak)", async () => {
    mockNextSequence = async () => 7;
    await postFormat({ content: "hello" });
    const ctx = renderPageCalls[0]!.ctx as {
      user_id: string;
      seq: number;
      page_id: string;
      owner_slug: string;
      created_at: string;
      model: string;
    };
    expect(ctx.seq).toBe(7);
    expect(ctx.user_id).toBe(NYXID_USER_ID);
    expect(ctx.owner_slug).toMatch(/^[0-9a-f]{16}$/);
    expect(ctx.page_id.length).toBeGreaterThan(10);
    expect(ctx.created_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
    );
    expect(ctx.model).toBe("gpt-5.4");
  });

  test("logPlannerFallback is called when the planner reports a fallback", async () => {
    mockPlanResult = {
      brief: {
        content_type: "daily_brief_v1",
        title: "T",
        spec_id: "executive-broadsheet",
        top_priorities: [],
        timeline: [],
        watchlist: [],
        notes: [],
      },
      fallbackReason: "invalid_spec_id",
      rawLLMOutput: { foo: "bar" },
    };
    const res = await postFormat({ content: "hello" });
    expect(res.status).toBe(200);
    expect(logPlannerFallbackCalls.length).toBe(1);
    expect(logPlannerFallbackCalls[0]!.reason).toBe("invalid_spec_id");
    expect(logPlannerFallbackCalls[0]!.raw).toEqual({ foo: "bar" });
  });
});

// ---------------------------------------------------------------------------

describe("POST /format — request validation", () => {
  test("empty content → 400", async () => {
    const res = await postFormat({ content: "" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });

  test("missing content field → 400", async () => {
    const res = await postFormat({ other: "x" });
    expect(res.status).toBe(400);
  });

  test("content > 100KB → 400", async () => {
    const res = await postFormat({ content: "a".repeat(60_000) });
    expect(res.status).toBe(400);
  });

  test("malformed JSON → 400", async () => {
    const app = makeApp();
    const res = await app.request("/format", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-nyxid-delegation-token": "deleg-token",
      },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------

describe("POST /format — delegation token", () => {
  test("missing X-NyxID-Delegation-Token → 500 missing_delegation_token", async () => {
    const app = makeApp();
    const res = await app.request("/format", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "missing_delegation_token" });
  });
});

// ---------------------------------------------------------------------------

describe("POST /format — error mapping", () => {
  test("PlannerTimeout → 504 planner_timeout", async () => {
    mockPlanResult = new FakePlannerTimeout("slow");
    const res = await postFormat({ content: "hi" });
    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({ error: "planner_timeout" });
  });

  test("PlannerInvalidOutput → 502 planner_invalid_output", async () => {
    mockPlanResult = new FakePlannerInvalidOutput("bad json");
    const res = await postFormat({ content: "hi" });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "planner_invalid_output" });
  });

  test("PlannerUpstreamError → 502 planner_upstream_error", async () => {
    mockPlanResult = new FakePlannerUpstreamError(503, "gateway down");
    const res = await postFormat({ content: "hi" });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "planner_upstream_error" });
  });

  test("PlannerRateLimited → 502 planner_upstream_error", async () => {
    mockPlanResult = new FakePlannerRateLimited();
    const res = await postFormat({ content: "hi" });
    expect(res.status).toBe(502);
  });

  test("chrono putObject timeout → 502 storage_unavailable", async () => {
    mockPutObject = async () => {
      throw new FakeStorageError("timeout", "slow");
    };
    const res = await postFormat({ content: "hi" });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "storage_unavailable" });
    // Insert MUST NOT have happened — storage failed first.
    expect(insertPageCalls.length).toBe(0);
  });

  test("chrono putObject unavailable → 502 storage_unavailable", async () => {
    mockPutObject = async () => {
      throw new FakeStorageError("unavailable", "down");
    };
    const res = await postFormat({ content: "hi" });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "storage_unavailable" });
  });

  test("chrono putObject integrity → 500 storage_integrity_error", async () => {
    mockPutObject = async () => {
      throw new FakeStorageError("integrity", "malformed");
    };
    const res = await postFormat({ content: "hi" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "storage_integrity_error" });
  });

  test("supabase insertPage duplicate → 500 duplicate_page_id", async () => {
    mockInsertPage = async () => {
      throw new FakeIndexError("duplicate", "unique violation");
    };
    const res = await postFormat({ content: "hi" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "duplicate_page_id" });
  });

  test("supabase insertPage timeout → 500 index_write_failed", async () => {
    mockInsertPage = async () => {
      throw new FakeIndexError("timeout", "slow");
    };
    const res = await postFormat({ content: "hi" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "index_write_failed" });
  });

  test("supabase nextSequence failure → 500 index_write_failed", async () => {
    mockNextSequence = async () => {
      throw new FakeIndexError("unavailable", "conn refused");
    };
    const res = await postFormat({ content: "hi" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "index_write_failed" });
    // Never should have touched chrono.
    expect(putObjectCalls.length).toBe(0);
  });
});
