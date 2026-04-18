/**
 * Tests for `POST /v/{slug}/rate`.
 *
 * Strategy: mock `src/index/supabase.ts` via `mock.module`, stand up the
 * route's sub-router in isolation (no full app.ts), fire requests at it.
 */
process.env.BASE_URL ??= "http://localhost:7701";
process.env.DATABASE_URL ??= "postgres://localhost/test";
process.env.CHRONO_STORAGE_URL ??= "http://127.0.0.1:3805";
process.env.NYXID_BASE_URL ??= "http://127.0.0.1:9000";
process.env.NYXID_JWKS_URL ??= "http://127.0.0.1:9000/.well-known/jwks.json";
process.env.NYXID_JWT_ISSUER ??= "http://127.0.0.1:9000";
process.env.NYXID_JWT_AUDIENCE ??= "nocturne";
process.env.NYXID_SERVICE_SECRET ??=
  "test-secret-test-secret-test-secret-xxxxxxxxxx";

import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

// ---------------------------------------------------------------------------
// Mock state — referenced from the test stubs installed via `mock.module`.

interface IndexErrorShape {
  name: "IndexError";
  code: "timeout" | "duplicate" | "constraint" | "unavailable";
  message: string;
}

class FakeIndexError extends Error implements IndexErrorShape {
  override name = "IndexError" as const;
  code: IndexErrorShape["code"];
  constructor(code: IndexErrorShape["code"], message = "err") {
    super(message);
    this.code = code;
  }
}

interface Page {
  page_id: string;
  user_id: string;
  storage_key: string;
  spec_id: string;
  content_type: string;
  rating: "good" | "bad" | null;
  created_at: Date;
}

let mockGetPage: (slug: string) => Promise<Page | null> = async () => null;
let mockSetRating: (
  slug: string,
  score: "good" | "bad",
) => Promise<void> = async () => {};
let setRatingCalls: Array<{ slug: string; score: "good" | "bad" }> = [];

mock.module("../index/supabase.ts", () => ({
  IndexError: FakeIndexError,
  getPage: (slug: string) => mockGetPage(slug),
  setRating: (slug: string, score: "good" | "bad") => {
    setRatingCalls.push({ slug, score });
    return mockSetRating(slug, score);
  },
}));

type RateModule = typeof import("./rate.ts");
let rateMod!: RateModule;

beforeAll(async () => {
  rateMod = await import("./rate.ts");
});

function makeApp() {
  const app = new Hono();
  app.route("/", rateMod.rateRouter);
  return app;
}

const FAKE_PAGE: Page = {
  page_id: "abc123",
  user_id: "u-1",
  storage_key: "u-1/abc123.html",
  spec_id: "executive-broadsheet",
  content_type: "daily_brief_v1",
  rating: null,
  created_at: new Date("2026-04-18T00:00:00Z"),
};

beforeEach(() => {
  setRatingCalls = [];
  mockGetPage = async () => FAKE_PAGE;
  mockSetRating = async () => {};
});

describe("POST /v/:slug/rate", () => {
  test("happy path — good score returns 200 and calls setRating", async () => {
    const app = makeApp();
    const res = await app.request("/v/abc123/rate?score=good", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    expect(setRatingCalls).toEqual([{ slug: "abc123", score: "good" }]);
  });

  test("happy path — bad score works too", async () => {
    const app = makeApp();
    const res = await app.request("/v/abc123/rate?score=bad", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(setRatingCalls[0]!.score).toBe("bad");
  });

  test("rejects an unknown score enum with 400", async () => {
    const app = makeApp();
    const res = await app.request("/v/abc123/rate?score=meh", {
      method: "POST",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: "invalid_score" });
    expect(setRatingCalls.length).toBe(0);
  });

  test("rejects missing score with 400", async () => {
    const app = makeApp();
    const res = await app.request("/v/abc123/rate", { method: "POST" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: "invalid_score" });
  });

  test("404 when the slug isn't in the index", async () => {
    mockGetPage = async () => null;
    const app = makeApp();
    const res = await app.request("/v/nope/rate?score=good", {
      method: "POST",
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: "page_not_found" });
    expect(setRatingCalls.length).toBe(0);
  });

  test("500 when setRating throws IndexError", async () => {
    mockSetRating = async () => {
      throw new FakeIndexError("timeout", "UPDATE timed out");
    };
    const app = makeApp();
    const res = await app.request("/v/abc123/rate?score=good", {
      method: "POST",
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "index_write_failed" });
  });

  test("500 when getPage throws IndexError", async () => {
    mockGetPage = async () => {
      throw new FakeIndexError("unavailable", "conn refused");
    };
    const app = makeApp();
    const res = await app.request("/v/abc123/rate?score=good", {
      method: "POST",
    });
    expect(res.status).toBe(500);
  });
});
