/**
 * NyxID identity middleware.
 *
 * Trust boundary: Nocturne never issues or stores sessions. Every authenticated
 * request carries two headers, injected by the NyxID proxy:
 *
 *   X-NyxID-User-Id         — UUID, the fast-path user key
 *   X-NyxID-Identity-Token  — short-lived (60s TTL) RS256 JWT, proof it came
 *                             from NyxID and not a header-spoofing client
 *
 * The middleware verifies the JWT against NyxID's JWKS (`NYXID_JWKS_URL`) and
 * asserts `payload.sub === userIdHeader`, `payload.iss === config.NYXID_BASE_URL`,
 * and `payload.aud === "nocturne"`. On success, `c.set('user_id', ...)`
 * exposes the verified id to downstream handlers.
 *
 * JWKS cache strategy: 10-minute TTL + lazy invalidation on verification
 * failure. NyxID rotates signing keys; a cached JWKS that's missed a rotation
 * would otherwise reject every request until the TTL expires. On any
 * signature/kid failure we refresh once and retry before returning 401.
 *
 * Error map (all bodies are `{ error: <code> }`):
 *   missing_identity        401 — missing one or both headers
 *   invalid_identity_token  401 — JWT failed verification after a JWKS refresh
 *   identity_mismatch       401 — JWT `sub` != `X-NyxID-User-Id`
 *   auth_unavailable        503 — JWKS fetch failed and we have no cache
 */

import type { MiddlewareHandler } from "hono";
import {
  createLocalJWKSet,
  jwtVerify,
  errors as joseErrors,
  type JSONWebKeySet,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";
import { config } from "../config.ts";

// ---------------------------------------------------------------------------
// Hono context typing — makes `c.get('user_id')` typed downstream.

declare module "hono" {
  interface ContextVariableMap {
    user_id: string | null;
  }
}

// ---------------------------------------------------------------------------
// JWKS cache. Module-level so it survives across requests.
//
// We keep the *raw* JWKS JSON (not a compiled key function) so that
// `createLocalJWKSet` can be re-invoked cheaply; that also makes the cache
// trivially swappable in tests.

const JWKS_TTL_MS = 10 * 60 * 1000; // 10 minutes
const JWKS_FETCH_TIMEOUT_MS = 3000; // 3 seconds, critical path

interface JwksCacheEntry {
  jwks: JSONWebKeySet;
  fetchedAt: number;
}

interface JwksFetcher {
  (url: string, signal: AbortSignal): Promise<JSONWebKeySet>;
}

let cache: JwksCacheEntry | null = null;

const defaultFetcher: JwksFetcher = async (url, signal) => {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`JWKS endpoint returned ${res.status}`);
  }
  const body = (await res.json()) as JSONWebKeySet;
  if (!body || !Array.isArray(body.keys)) {
    throw new Error("JWKS endpoint returned invalid body");
  }
  return body;
};

let fetcher: JwksFetcher = defaultFetcher;
const NOCTURNE_AUDIENCE = "nocturne";

/**
 * Test-only hook. Swaps the JWKS fetcher so tests can serve a JWKS locally
 * without standing up an HTTP server. Returns a disposer that restores the
 * default fetcher and clears the cache.
 */
export function __setJwksFetcherForTesting(f: JwksFetcher | null): () => void {
  const prev = fetcher;
  fetcher = f ?? defaultFetcher;
  cache = null;
  return () => {
    fetcher = prev;
    cache = null;
  };
}

/** Test-only: clear the JWKS cache between cases. */
export function __clearJwksCacheForTesting(): void {
  cache = null;
}

async function fetchJwksWithTimeout(): Promise<JSONWebKeySet> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JWKS_FETCH_TIMEOUT_MS);
  try {
    return await fetcher(config.NYXID_JWKS_URL, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Return a usable JWKS, fetching if the cache is empty or stale. If the fetch
 * fails, fall back to a stale cache (callers can still try to verify against
 * it); only if the cache is empty does this throw.
 */
async function getJwks(forceRefresh = false): Promise<JSONWebKeySet> {
  const now = Date.now();
  if (
    !forceRefresh &&
    cache !== null &&
    now - cache.fetchedAt < JWKS_TTL_MS
  ) {
    return cache.jwks;
  }
  try {
    const jwks = await fetchJwksWithTimeout();
    cache = { jwks, fetchedAt: now };
    return jwks;
  } catch (err) {
    if (cache !== null) {
      // Network blip but we have *something* — let verification try.
      return cache.jwks;
    }
    throw err;
  }
}

/**
 * Verify a JWT. If the first attempt fails because the signing key was not
 * found or the signature did not validate (classic symptoms of a rotated key
 * we haven't re-fetched), refresh the JWKS once and retry.
 */
async function verifyJwtWithLazyRefresh(
  token: string,
): Promise<{ payload: JWTPayload }> {
  const firstJwks = await getJwks(false);
  const firstKey: JWTVerifyGetKey = createLocalJWKSet(firstJwks);
  const verifyOptions = {
    issuer: config.NYXID_BASE_URL,
    audience: NOCTURNE_AUDIENCE,
  } as const;

  try {
    const { payload } = await jwtVerify(token, firstKey, verifyOptions);
    return { payload };
  } catch (err) {
    if (!isRetryableVerifyError(err)) {
      throw err;
    }
    // Lazy invalidation: fetch JWKS once more, swap keyset, retry.
    const refreshedJwks = await getJwks(true);
    const refreshedKey: JWTVerifyGetKey = createLocalJWKSet(refreshedJwks);
    const { payload } = await jwtVerify(token, refreshedKey, verifyOptions);
    return { payload };
  }
}

/**
 * Classify whether a verification failure is worth a JWKS refresh. Signature
 * mismatch and "no matching kid" both mean "maybe the key rotated"; expired
 * / malformed tokens will never be saved by a refresh.
 */
function isRetryableVerifyError(err: unknown): boolean {
  if (err instanceof joseErrors.JWKSNoMatchingKey) return true;
  if (err instanceof joseErrors.JWKSMultipleMatchingKeys) return true;
  if (err instanceof joseErrors.JWSSignatureVerificationFailed) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Middleware

const HDR_USER_ID = "x-nyxid-user-id";
const HDR_IDENTITY_TOKEN = "x-nyxid-identity-token";

type AuthFailure =
  | { kind: "missing_identity" }
  | { kind: "invalid_identity_token" }
  | { kind: "identity_mismatch" }
  | { kind: "auth_unavailable" };

/**
 * Run the full verification flow given both headers. Never throws — returns
 * either the verified user id or a typed failure tag.
 */
async function verifyHeaders(
  userIdHeader: string,
  idToken: string,
): Promise<{ ok: true; userId: string } | { ok: false; failure: AuthFailure }> {
  let payload: JWTPayload;
  try {
    ({ payload } = await verifyJwtWithLazyRefresh(idToken));
  } catch (err) {
    if (isJwksUnavailable(err)) {
      return { ok: false, failure: { kind: "auth_unavailable" } };
    }
    return { ok: false, failure: { kind: "invalid_identity_token" } };
  }
  if (payload.sub !== userIdHeader) {
    return { ok: false, failure: { kind: "identity_mismatch" } };
  }
  return { ok: true, userId: userIdHeader };
}

/**
 * A "JWKS unavailable" error is one that bubbled out of `getJwks` with no
 * cache to fall back to. We detect it by checking for the well-known shapes
 * our fetcher throws — anything coming out of `jose` itself is a
 * token-validity problem, not an auth-infrastructure outage.
 */
function isJwksUnavailable(err: unknown): boolean {
  if (err instanceof joseErrors.JOSEError) return false;
  if (err instanceof Error) {
    if (err.name === "AbortError") return true;
    if (err.message.startsWith("JWKS endpoint returned")) return true;
    if (err.message === "JWKS endpoint returned invalid body") return true;
    // Network errors (fetch failures, DNS, etc) — be permissive.
    return true;
  }
  return false;
}

/**
 * Strict NyxID auth. Rejects with 401/503 on any failure; on success,
 * `c.get('user_id')` returns the verified UUID string.
 */
export const nyxidAuth: MiddlewareHandler = async (c, next) => {
  const staticBearer = config.NOCTURNE_STATIC_BEARER;
  if (staticBearer !== undefined) {
    const allowInProd = config.NOCTURNE_STATIC_BEARER_FORCE === "1";
    const envOk = config.NODE_ENV !== "production" || allowInProd;
    if (envOk) {
      const authHeader = c.req.header("authorization") ?? "";
      const m = authHeader.match(/^Bearer\s+(.+)$/i);
      if (m && m[1] === staticBearer) {
        console.warn(JSON.stringify({
          level: "warn",
          msg: "auth: static bearer accepted",
          env: config.NODE_ENV,
          forced: allowInProd,
          path: c.req.path,
        }));
        c.set("user_id", "00000000-0000-0000-0000-000000000001");
        await next();
        return;
      }
    }
  }

  const userIdHeader = c.req.header(HDR_USER_ID);
  const idToken = c.req.header(HDR_IDENTITY_TOKEN);

  if (!userIdHeader || !idToken) {
    return c.json({ error: "missing_identity" }, 401);
  }

  const result = await verifyHeaders(userIdHeader, idToken);
  if (!result.ok) {
    return failureResponse(c, result.failure);
  }
  c.set("user_id", result.userId);
  await next();
};

/**
 * Optional NyxID auth. Used by routes that *can* be authenticated but also
 * accept an alternate path (e.g. share tokens on `GET /u/{slug}`).
 *
 *   - Both headers absent   → `user_id` = null, continues.
 *   - Both headers present  → full verification; failures still 401/503.
 *   - One of two present    → treated as a failed auth attempt (401) rather
 *                             than anonymous, because a half-supplied identity
 *                             is almost certainly a client bug worth surfacing.
 */
export const optionalNyxidAuth: MiddlewareHandler = async (c, next) => {
  const staticBearer = config.NOCTURNE_STATIC_BEARER;
  if (staticBearer !== undefined) {
    const allowInProd = config.NOCTURNE_STATIC_BEARER_FORCE === "1";
    const envOk = config.NODE_ENV !== "production" || allowInProd;
    if (envOk) {
      const authHeader = c.req.header("authorization") ?? "";
      const m = authHeader.match(/^Bearer\s+(.+)$/i);
      if (m && m[1] === staticBearer) {
        console.warn(JSON.stringify({
          level: "warn",
          msg: "auth: static bearer accepted",
          env: config.NODE_ENV,
          forced: allowInProd,
          path: c.req.path,
        }));
        c.set("user_id", "00000000-0000-0000-0000-000000000001");
        await next();
        return;
      }
    }
  }

  const userIdHeader = c.req.header(HDR_USER_ID);
  const idToken = c.req.header(HDR_IDENTITY_TOKEN);

  if (!userIdHeader && !idToken) {
    c.set("user_id", null);
    await next();
    return;
  }
  if (!userIdHeader || !idToken) {
    return c.json({ error: "missing_identity" }, 401);
  }

  const result = await verifyHeaders(userIdHeader, idToken);
  if (!result.ok) {
    return failureResponse(c, result.failure);
  }
  c.set("user_id", result.userId);
  await next();
};

function failureResponse(
  c: Parameters<MiddlewareHandler>[0],
  failure: AuthFailure,
) {
  switch (failure.kind) {
    case "missing_identity":
      return c.json({ error: "missing_identity" }, 401);
    case "invalid_identity_token":
      return c.json({ error: "invalid_identity_token" }, 401);
    case "identity_mismatch":
      return c.json({ error: "identity_mismatch" }, 401);
    case "auth_unavailable":
      return c.json({ error: "auth_unavailable" }, 503);
  }
}
