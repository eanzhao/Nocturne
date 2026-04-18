/**
 * Tests for `GET /v/{slug}`.
 *
 * Strategy: mock the supabase index and the chrono storage modules. Exercise
 * the router directly (no full app.ts).
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
// Mock shims

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
let mockGetObject: (
  bucket: string,
  key: string,
) => Promise<{ body: ArrayBuffer; contentType: string }> = async () => ({
  body: new TextEncoder().encode("<html/>").buffer as ArrayBuffer,
  contentType: "text/html; charset=utf-8",
});

mock.module("../index/supabase.ts", () => ({
  IndexError: FakeIndexError,
  getPage: (slug: string) => mockGetPage(slug),
}));

mock.module("../storage/chrono.ts", () => ({
  StorageError: FakeStorageError,
  getObject: (bucket: string, key: string) => mockGetObject(bucket, key),
}));

type ViewModule = typeof import("./view.ts");
let viewMod!: ViewModule;

beforeAll(async () => {
  viewMod = await import("./view.ts");
});

function makeApp() {
  const app = new Hono();
  app.route("/", viewMod.viewRouter);
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
  mockGetPage = async () => FAKE_PAGE;
  mockGetObject = async () => ({
    body: new TextEncoder().encode("<html><body>hi</body></html>")
      .buffer as ArrayBuffer,
    contentType: "text/html; charset=utf-8",
  });
});

describe("GET /v/:slug", () => {
  test("happy path — returns HTML body with immutable cache header", async () => {
    const app = makeApp();
    const res = await app.request("/v/abc123");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(await res.text()).toBe("<html><body>hi</body></html>");
  });

  test("404 when the slug isn't in the index", async () => {
    mockGetPage = async () => null;
    const app = makeApp();
    const res = await app.request("/v/nope");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: "page_not_found" });
  });

  test("500 storage_integrity_error when supabase says yes but chrono 404s", async () => {
    mockGetObject = async () => {
      throw new FakeStorageError("not_found", "gone");
    };
    const app = makeApp();
    const res = await app.request("/v/abc123");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "storage_integrity_error" });
  });

  test("502 storage_unavailable when chrono is down", async () => {
    mockGetObject = async () => {
      throw new FakeStorageError("unavailable", "down");
    };
    const app = makeApp();
    const res = await app.request("/v/abc123");
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toEqual({ error: "storage_unavailable" });
  });

  test("502 storage_unavailable when chrono times out", async () => {
    mockGetObject = async () => {
      throw new FakeStorageError("timeout", "slow");
    };
    const app = makeApp();
    const res = await app.request("/v/abc123");
    expect(res.status).toBe(502);
  });

  test("503 index_unavailable when supabase throws", async () => {
    mockGetPage = async () => {
      throw new FakeIndexError("unavailable", "conn refused");
    };
    const app = makeApp();
    const res = await app.request("/v/abc123");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ error: "index_unavailable" });
  });

  test("cache header is present even when body is empty", async () => {
    mockGetObject = async () => ({
      body: new ArrayBuffer(0),
      contentType: "text/html; charset=utf-8",
    });
    const app = makeApp();
    const res = await app.request("/v/abc123");
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
  });
});
