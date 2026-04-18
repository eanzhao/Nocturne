/**
 * HTTP fixture servers for E2E tests.
 *
 * Nocturne talks to two external services:
 *   - **chrono-storage** (blob store): HTTP API with a POST to put objects
 *     and a two-hop `GET /presigned-url` → `fetch(presigned)` to read.
 *   - **NyxID** (LLM gateway + JWKS source): serves JWKS at
 *     `/.well-known/jwks.json` and accepts OpenAI-compatible chat completions
 *     at `/api/v1/llm/gateway/v1/chat/completions`.
 *
 * This module stands up two `Bun.serve` instances — one per port — that
 * together impersonate both upstreams with enough fidelity for the E2E flow.
 *
 * Design choices:
 *   - **Real HTTP.** We intentionally do NOT stub `fetch`. Mocking `fetch`
 *     leaks to every other test in the batch; a real server contained to
 *     loopback is both safer and closer to the production code path.
 *   - **Singletons.** Bun runs all tests inside one `bun test` process, so
 *     every E2E file shares the same two listeners. `startFixture` is
 *     idempotent: the first caller binds, subsequent callers get the same
 *     handle. `stopFixture` is called from a single `afterAll` at process
 *     exit — but even that is best-effort; leaving the sockets open until
 *     the process dies is fine for a test harness.
 *   - **Mutable state in `plannerOverride` / `chronoStore` / `chronoOverride`.**
 *     Each test configures what the fixture should return next. Because the
 *     fixture is a singleton, tests must `resetFixtureState()` in
 *     `beforeEach` to avoid bleed.
 */
import type { JSONWebKeySet } from "jose";

import { FIXTURE_CHRONO_PORT, FIXTURE_NYXID_PORT } from "./fixture-env.ts";

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

/**
 * In-memory chrono-storage replacement. Keyed by `${bucket}/${key}` so tests
 * can read back anything a previous `putObject` wrote during the same test.
 *
 * The server keeps the raw bytes AND the content-type so the GET path can
 * round-trip either back out to the caller.
 */
type StoredObject = { body: Uint8Array; contentType: string };

const chronoStore = new Map<string, StoredObject>();

/**
 * Per-request override for chrono PUT. When set, every PUT hits this
 * function instead of the in-memory store — used by the `error-response.e2e.ts`
 * test to simulate a storage outage without tearing down the whole fixture.
 */
type ChronoPutOverride =
  | null
  | ((req: {
      bucket: string;
      key: string;
      contentType: string;
      body: Uint8Array;
    }) => Promise<Response> | Response);

let chronoPutOverride: ChronoPutOverride = null;

/**
 * Per-request override for the planner's chat completions endpoint.
 *
 * When null, the fixture returns a plausible `daily_brief_v1` derived from the
 * user's content (handy for the happy-path tests). When set, tests can pin the
 * response to a specific `DailyBrief` (e.g. `spec_id: "guji-classical"`).
 */
type PlannerOverride =
  | null
  | ((userContent: string) => Record<string, unknown>);

let plannerOverride: PlannerOverride = null;

/**
 * JWKS the NyxID fixture advertises. Rewritten by the test harness once the
 * test-side keypair has been generated.
 */
let currentJwks: JSONWebKeySet = { keys: [] };

/**
 * Reset all per-test state. Call this in `beforeEach`.
 *
 * NOTE: we deliberately do NOT reset `currentJwks` here — the keypair lifetime
 * is per-test-file (rebuilt in `beforeAll`), not per-test. A `beforeEach`
 * reset would trip the lazy-refresh path in `auth.ts` with no benefit.
 */
export function resetFixtureState(): void {
  chronoStore.clear();
  chronoPutOverride = null;
  plannerOverride = null;
}

export function setPlannerOverride(fn: PlannerOverride): void {
  plannerOverride = fn;
}

export function setChronoPutOverride(fn: ChronoPutOverride): void {
  chronoPutOverride = fn;
}

export function setFixtureJwks(jwks: JSONWebKeySet): void {
  currentJwks = jwks;
}

export function getStoredObject(
  bucket: string,
  key: string,
): StoredObject | undefined {
  return chronoStore.get(`${bucket}/${key}`);
}

// ---------------------------------------------------------------------------
// Planner default — builds a schema-valid daily_brief_v1 from arbitrary text
// ---------------------------------------------------------------------------

/**
 * Extract a plausible title from the first non-empty line, trimmed to 200 chars.
 * Fallback keeps the schema happy even when the input is empty-after-trim.
 */
function deriveTitle(content: string): string {
  const firstLine = content.split(/\r?\n/).find((l) => l.trim().length > 0);
  const title = (firstLine ?? "Untitled").trim().slice(0, 200);
  return title.length > 0 ? title : "Untitled";
}

function defaultBrief(content: string): Record<string, unknown> {
  return {
    content_type: "daily_brief_v1",
    title: deriveTitle(content),
    spec_id: "executive-broadsheet",
    top_priorities: [
      { title: "Ship the fixture", why_it_matters: "tests rely on it" },
    ],
    timeline: [],
    watchlist: [],
    notes: [],
  };
}

// ---------------------------------------------------------------------------
// NyxID fixture
// ---------------------------------------------------------------------------

async function nyxidHandler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/.well-known/jwks.json" && req.method === "GET") {
    return Response.json(currentJwks);
  }

  if (
    url.pathname === "/api/v1/llm/gateway/v1/chat/completions" &&
    req.method === "POST"
  ) {
    let body: { messages?: Array<{ role: string; content: string }> };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ error: "bad_request" }, { status: 400 });
    }
    // Recover the user content so `plannerOverride` callers can peek at it.
    const userMsg = body.messages?.find((m) => m.role === "user");
    const userContent = userMsg?.content ?? "";

    const brief = plannerOverride
      ? plannerOverride(userContent)
      : defaultBrief(userContent);

    return Response.json({
      choices: [
        { message: { content: JSON.stringify(brief) } },
      ],
    });
  }

  return new Response("not found", { status: 404 });
}

// ---------------------------------------------------------------------------
// chrono-storage fixture
// ---------------------------------------------------------------------------

/**
 * Parse `/api/buckets/:bucket/(objects|presigned-url)` out of a URL path.
 */
function parseChronoPath(
  pathname: string,
): { bucket: string; kind: "objects" | "presigned-url" | "blob" } | null {
  const objM = pathname.match(/^\/api\/buckets\/([^/]+)\/objects$/);
  if (objM) return { bucket: decodeURIComponent(objM[1]!), kind: "objects" };
  const psM = pathname.match(/^\/api\/buckets\/([^/]+)\/presigned-url$/);
  if (psM) return { bucket: decodeURIComponent(psM[1]!), kind: "presigned-url" };
  // Presigned URLs the fixture mints point back at `/blob/<bucket>/<key>`.
  const blobM = pathname.match(/^\/blob\/([^/]+)\/(.+)$/);
  if (blobM) {
    return { bucket: decodeURIComponent(blobM[1]!), kind: "blob" };
  }
  return null;
}

async function chronoHandler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const parsed = parseChronoPath(url.pathname);
  if (!parsed) {
    return new Response("not found", { status: 404 });
  }

  if (parsed.kind === "objects") {
    const key = url.searchParams.get("key");
    if (key === null) {
      return Response.json({ error: { code: "missing_key" } }, { status: 400 });
    }

    // HEAD — existence probe. We keep it for shape completeness even though
    // the v0 routes don't currently use it.
    if (req.method === "HEAD") {
      return new Response(null, {
        status: chronoStore.has(`${parsed.bucket}/${key}`) ? 200 : 404,
      });
    }

    if (req.method === "POST") {
      const contentType =
        url.searchParams.get("contentType") ??
        req.headers.get("content-type") ??
        "application/octet-stream";
      const body = new Uint8Array(await req.arrayBuffer());
      if (chronoPutOverride) {
        return chronoPutOverride({ bucket: parsed.bucket, key, contentType, body });
      }
      chronoStore.set(`${parsed.bucket}/${key}`, { body, contentType });
      return Response.json({
        data: {
          url: `http://127.0.0.1:${FIXTURE_CHRONO_PORT}/blob/${encodeURIComponent(
            parsed.bucket,
          )}/${encodeURIComponent(key)}`,
        },
        error: null,
      });
    }

    return new Response("method not allowed", { status: 405 });
  }

  if (parsed.kind === "presigned-url") {
    if (req.method !== "GET") {
      return new Response("method not allowed", { status: 405 });
    }
    const key = url.searchParams.get("key");
    if (!key) {
      return Response.json(
        { error: { code: "missing_key" } },
        { status: 400 },
      );
    }
    if (!chronoStore.has(`${parsed.bucket}/${key}`)) {
      return Response.json(
        { error: { code: "object_not_found" } },
        { status: 404 },
      );
    }
    return Response.json({
      data: {
        presignedUrl: `http://127.0.0.1:${FIXTURE_CHRONO_PORT}/blob/${encodeURIComponent(
          parsed.bucket,
        )}/${encodeURIComponent(key)}`,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      error: null,
    });
  }

  // kind === "blob" — body fetch (hop 2 of GET).
  if (req.method !== "GET") {
    return new Response("method not allowed", { status: 405 });
  }
  const blobM = url.pathname.match(/^\/blob\/([^/]+)\/(.+)$/);
  if (!blobM) return new Response("not found", { status: 404 });
  const bucket = decodeURIComponent(blobM[1]!);
  const key = decodeURIComponent(blobM[2]!);
  const obj = chronoStore.get(`${bucket}/${key}`);
  if (!obj) return new Response("not found", { status: 404 });
  return new Response(obj.body, {
    status: 200,
    headers: { "content-type": obj.contentType },
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

interface FixtureHandles {
  chrono: ReturnType<typeof Bun.serve>;
  nyxid: ReturnType<typeof Bun.serve>;
}

let fixture: FixtureHandles | null = null;

/**
 * Bind both fixture servers. Idempotent — returns the existing handle if
 * already running. Tests call this from a `beforeAll`.
 */
export function startFixture(): FixtureHandles {
  if (fixture) return fixture;
  const chrono = Bun.serve({
    port: FIXTURE_CHRONO_PORT,
    fetch: chronoHandler,
  });
  const nyxid = Bun.serve({
    port: FIXTURE_NYXID_PORT,
    fetch: nyxidHandler,
  });
  fixture = { chrono, nyxid };
  return fixture;
}

/**
 * Stop both servers. Safe to call multiple times. Mostly useful if a test
 * file wants to be tidy — Bun will tear these down when the test process
 * exits regardless.
 */
export function stopFixture(): void {
  if (!fixture) return;
  fixture.chrono.stop(true);
  fixture.nyxid.stop(true);
  fixture = null;
}
