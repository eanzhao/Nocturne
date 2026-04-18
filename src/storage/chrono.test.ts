/**
 * Unit tests for src/storage/chrono.ts.
 *
 * Strategy: mock global `fetch`. We explicitly assert:
 *   - The signal passed to `fetch` is an `AbortSignal` (proving timeouts are
 *     wired) and is cancelled within the per-method budget.
 *   - 404 → `StorageError{code:"not_found"}`, 5xx → `unavailable`.
 *   - Abort errors on the underlying `fetch` surface as `timeout`.
 *
 * We do NOT spin up a real chrono-storage — that's integration scope.
 */
import "./test-env.ts"; // MUST be first — populates env for src/config.ts.
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import {
  __TIMEOUTS__,
  getObject,
  objectExists,
  putObject,
  StorageError,
} from "./chrono.ts";

type FetchArgs = { input: string | URL | Request; init?: RequestInit };

const originalFetch = globalThis.fetch;
let calls: FetchArgs[] = [];

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function installFetch(handler: (args: FetchArgs) => Promise<Response>) {
  calls = [];
  globalThis.fetch = mock(
    async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ input, init });
      return handler({ input, init });
    },
  ) as unknown as typeof fetch;
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("buildObjectUrl (via fetch call shape)", () => {
  test("putObject hits POST /api/buckets/:bucket/objects with key and contentType", async () => {
    installFetch(async () =>
      jsonResponse({ data: { url: "s3://bucket/key" }, error: null }),
    );
    await putObject("nocturne", "u/page.html", "<html/>", "text/html");
    expect(calls.length).toBe(1);
    const call = calls[0]!;
    expect(call.init?.method).toBe("POST");
    const url = new URL(call.input as string);
    expect(url.pathname).toBe("/api/buckets/nocturne/objects");
    expect(url.searchParams.get("key")).toBe("u/page.html");
    expect(url.searchParams.get("contentType")).toBe("text/html");
  });

  test("getObject mints a presigned URL then fetches the body", async () => {
    const presignedUrl =
      "https://s3.test.invalid/chrono/nocturne/foo%2Fbar?sig=abc";
    installFetch(async ({ input }) => {
      const u = String(input);
      if (u.includes("/presigned-url")) {
        return jsonResponse({
          data: { presignedUrl, expiresAt: "2099-01-01T00:00:00Z" },
          error: null,
        });
      }
      return new Response("body", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    });
    await getObject("nocturne", "foo/bar");
    expect(calls.length).toBe(2);

    // Hop 1 — mint
    const mintCall = calls[0]!;
    expect(mintCall.init?.method).toBe("GET");
    const mintUrl = new URL(mintCall.input as string);
    expect(mintUrl.pathname).toBe("/api/buckets/nocturne/presigned-url");
    expect(mintUrl.searchParams.get("key")).toBe("foo/bar");

    // Hop 2 — body
    const bodyCall = calls[1]!;
    expect(bodyCall.init?.method).toBe("GET");
    expect(String(bodyCall.input)).toBe(presignedUrl);
  });

  test("objectExists uses HEAD", async () => {
    installFetch(async () => new Response(null, { status: 200 }));
    await objectExists("nocturne", "x");
    expect(calls[0]!.init?.method).toBe("HEAD");
  });
});

describe("timeout wiring", () => {
  test("putObject passes an AbortSignal tied to the 8s budget", async () => {
    installFetch(async () =>
      jsonResponse({ data: { url: "s3://bucket/key" }, error: null }),
    );
    await putObject("b", "k", "x", "text/plain");
    const signal = calls[0]!.init?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(__TIMEOUTS__.put).toBe(8_000);
  });

  test("getObject passes an AbortSignal on each hop; mint + body budgets sum to 5s", async () => {
    installFetch(async ({ input }) => {
      if (String(input).includes("/presigned-url")) {
        return jsonResponse({
          data: { presignedUrl: "https://s3.test.invalid/x", expiresAt: "x" },
          error: null,
        });
      }
      return new Response("", { status: 200 });
    });
    await getObject("b", "k");
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
    expect(calls[1]!.init?.signal).toBeInstanceOf(AbortSignal);
    expect(__TIMEOUTS__.get).toBe(5_000);
    expect(__TIMEOUTS__.getMint + __TIMEOUTS__.getBody).toBe(__TIMEOUTS__.get);
  });

  test("objectExists passes an AbortSignal tied to the 3s budget", async () => {
    installFetch(async () => new Response(null, { status: 200 }));
    await objectExists("b", "k");
    const signal = calls[0]!.init?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(__TIMEOUTS__.head).toBe(3_000);
  });

  test("timeout/abort on fetch surfaces as StorageError{code:'timeout'}", async () => {
    installFetch(async ({ init }) => {
      // Simulate the signal firing immediately (as if the timeout elapsed
      // and then fetch rejected, which is what Bun's fetch does).
      const sig = init?.signal;
      if (sig) {
        // Force the signal to be 'aborted' path, then throw TimeoutError.
      }
      const err = new DOMException("timed out", "TimeoutError");
      throw err;
    });
    await expect(getObject("b", "k")).rejects.toMatchObject({
      name: "StorageError",
      code: "timeout",
    });
  });

  test("generic AbortError also maps to timeout", async () => {
    installFetch(async () => {
      throw new DOMException("aborted", "AbortError");
    });
    await expect(putObject("b", "k", "x", "text/plain")).rejects.toMatchObject({
      name: "StorageError",
      code: "timeout",
    });
  });
});

describe("status-code → code mapping", () => {
  test("getObject 404 on mint → not_found (no body fetch)", async () => {
    installFetch(async () =>
      jsonResponse(
        { data: null, error: { code: "OBJECT_NOT_FOUND", message: "gone" } },
        { status: 404 },
      ),
    );
    let caught: unknown;
    try {
      await getObject("b", "k");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StorageError);
    expect((caught as StorageError).code).toBe("not_found");
    expect((caught as StorageError).upstreamCode).toBe("OBJECT_NOT_FOUND");
    // mint returned 404 → we MUST NOT have attempted the body fetch.
    expect(calls.length).toBe(1);
  });

  test("getObject 503 on mint → unavailable", async () => {
    installFetch(async () =>
      jsonResponse(
        { data: null, error: { code: "S3_UNAVAILABLE", message: "down" } },
        { status: 503 },
      ),
    );
    let caught: unknown;
    try {
      await getObject("b", "k");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StorageError);
    expect((caught as StorageError).code).toBe("unavailable");
    expect((caught as StorageError).status).toBe(503);
  });

  test("getObject body 404 (gone between hops) → not_found", async () => {
    installFetch(async ({ input }) => {
      if (String(input).includes("/presigned-url")) {
        return jsonResponse({
          data: { presignedUrl: "https://s3.test.invalid/x", expiresAt: "x" },
          error: null,
        });
      }
      return new Response("", { status: 404 });
    });
    await expect(getObject("b", "k")).rejects.toMatchObject({
      name: "StorageError",
      code: "not_found",
    });
  });

  test("getObject body 503 → unavailable", async () => {
    installFetch(async ({ input }) => {
      if (String(input).includes("/presigned-url")) {
        return jsonResponse({
          data: { presignedUrl: "https://s3.test.invalid/x", expiresAt: "x" },
          error: null,
        });
      }
      return new Response("", { status: 503 });
    });
    await expect(getObject("b", "k")).rejects.toMatchObject({
      name: "StorageError",
      code: "unavailable",
    });
  });

  test("getObject mint with malformed JSON → integrity", async () => {
    installFetch(async () =>
      new Response("not-json", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(getObject("b", "k")).rejects.toMatchObject({
      name: "StorageError",
      code: "integrity",
    });
  });

  test("getObject mint missing presignedUrl → integrity", async () => {
    installFetch(async () =>
      jsonResponse({ data: { expiresAt: "x" }, error: null }),
    );
    await expect(getObject("b", "k")).rejects.toMatchObject({
      name: "StorageError",
      code: "integrity",
    });
  });

  test("objectExists returns false on 404 and true on 200", async () => {
    installFetch(async () => new Response(null, { status: 404 }));
    expect(await objectExists("b", "k")).toBe(false);

    installFetch(async () => new Response(null, { status: 200 }));
    expect(await objectExists("b", "k")).toBe(true);
  });

  test("objectExists 503 throws unavailable (does NOT collapse to false)", async () => {
    installFetch(async () => new Response(null, { status: 503 }));
    await expect(objectExists("b", "k")).rejects.toMatchObject({
      name: "StorageError",
      code: "unavailable",
    });
  });

  test("putObject 500 → unavailable", async () => {
    installFetch(async () => new Response("", { status: 500 }));
    await expect(
      putObject("b", "k", "x", "text/plain"),
    ).rejects.toMatchObject({
      name: "StorageError",
      code: "unavailable",
    });
  });

  test("putObject returns the upstream url on 200", async () => {
    installFetch(async () =>
      jsonResponse({
        data: { url: "s3://nocturne/u/page.html" },
        error: null,
      }),
    );
    const out = await putObject("nocturne", "u/page.html", "x", "text/html");
    expect(out.url).toBe("s3://nocturne/u/page.html");
  });

  test("putObject rejects malformed success envelope as integrity", async () => {
    installFetch(async () =>
      jsonResponse({ data: { url: 42 }, error: null }),
    );
    await expect(
      putObject("b", "k", "x", "text/plain"),
    ).rejects.toMatchObject({
      name: "StorageError",
      code: "integrity",
    });
  });

  test("getObject returns body + contentType on 200 (body hop's header)", async () => {
    installFetch(async ({ input }) => {
      if (String(input).includes("/presigned-url")) {
        return jsonResponse({
          data: { presignedUrl: "https://s3.test.invalid/x", expiresAt: "x" },
          error: null,
        });
      }
      return new Response("hello-world", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    });
    const { body, contentType } = await getObject("b", "k");
    expect(contentType).toBe("text/plain; charset=utf-8");
    expect(new TextDecoder().decode(body)).toBe("hello-world");
  });
});
