/**
 * Unit tests for `nyxidAuth` / `optionalNyxidAuth`.
 *
 * These never touch the network. Instead, we generate RSA keypairs locally
 * with `jose`, sign fixture JWTs, and inject the JWKS via the test-only
 * fetcher hook (`__setJwksFetcherForTesting`). That gives deterministic
 * control over the "rotated key" and "JWKS network failure" cases.
 *
 * `src/config.ts` reads `process.env` at module-load time, so every env
 * variable it requires is populated *before* the first `await import` of
 * the auth module.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  type JSONWebKeySet,
  type JWK,
  type KeyLike,
} from "jose";

// ---------------------------------------------------------------------------
// Env bootstrap — populated before the first import of `./auth.ts`.

const ENV_DEFAULTS: Record<string, string> = {
  PORT: "7701",
  BASE_URL: "http://localhost:7701",
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test:test@127.0.0.1:5432/test",
  CHRONO_STORAGE_URL: "http://127.0.0.1:3805",
  CHRONO_STORAGE_BUCKET: "nocturne",
  NYXID_BASE_URL: "https://nyx-test.invalid",
  NYXID_JWKS_URL: "https://nyx-test.invalid/.well-known/jwks.json",
  NYXID_SERVICE_SECRET:
    "0123456789abcdef0123456789abcdef0123456789abcdef",
  PAGE_ID_BYTES: "15",
};
for (const [k, v] of Object.entries(ENV_DEFAULTS)) {
  process.env[k] ??= v;
}

// Dynamic handles — filled in `beforeAll` once env is ready.
type AuthModule = typeof import("./auth.ts");
let authMod!: AuthModule;

beforeAll(async () => {
  authMod = await import("./auth.ts");
});

// ---------------------------------------------------------------------------
// Fixtures

const ISSUER = process.env.NYXID_BASE_URL ?? "https://nyx-test.invalid";
const AUDIENCE = "nocturne";
const USER_ID = "11111111-2222-3333-4444-555555555555";

interface Keypair {
  kid: string;
  privateKey: KeyLike;
  publicJwk: JWK;
}

async function makeKeypair(kid: string): Promise<Keypair> {
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = kid;
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  return { kid, privateKey, publicJwk };
}

function jwksOf(...pairs: Keypair[]): JSONWebKeySet {
  return { keys: pairs.map((p) => p.publicJwk) };
}

async function signToken(
  kp: Keypair,
  opts: {
    sub?: string;
    expiresIn?: string;
    issuer?: string;
    audience?: string;
  } = {},
): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: kp.kid })
    .setIssuer(opts.issuer ?? ISSUER)
    .setAudience(opts.audience ?? AUDIENCE)
    .setSubject(opts.sub ?? USER_ID)
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? "60s")
    .sign(kp.privateKey);
}

// ---------------------------------------------------------------------------
// Harness — mounts the middleware on a throwaway Hono app.

function appWithAuth(mw: AuthModule["nyxidAuth"]) {
  const app = new Hono();
  app.use("*", mw);
  app.get("/whoami", (c) => c.json({ user_id: c.get("user_id") }));
  return app;
}

function authedReq(headers: Record<string, string> = {}): Request {
  return new Request("http://test.local/whoami", { headers });
}

// ---------------------------------------------------------------------------
// Lifecycle — each test gets a clean JWKS cache and a tracked fetcher.

let fetchCount = 0;
let currentJwks: JSONWebKeySet = { keys: [] };
let failNextFetch: "error" | null = null;
let disposeFetcher: (() => void) | null = null;

beforeEach(() => {
  fetchCount = 0;
  currentJwks = { keys: [] };
  failNextFetch = null;
  disposeFetcher = authMod.__setJwksFetcherForTesting(async () => {
    fetchCount++;
    if (failNextFetch === "error") {
      throw new Error("simulated network failure");
    }
    return currentJwks;
  });
});

afterEach(() => {
  disposeFetcher?.();
  disposeFetcher = null;
  authMod.__clearJwksCacheForTesting();
});

// ---------------------------------------------------------------------------
// Tests

describe("nyxidAuth", () => {
  test("valid JWT + matching header sets user_id on context", async () => {
    const kp = await makeKeypair("k1");
    currentJwks = jwksOf(kp);
    const token = await signToken(kp, { sub: USER_ID });

    const app = appWithAuth(authMod.nyxidAuth);
    const res = await app.request(
      authedReq({
        "x-nyxid-user-id": USER_ID,
        "x-nyxid-identity-token": token,
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user_id: USER_ID });
    expect(fetchCount).toBe(1);
  });

  test("missing X-NyxID-Identity-Token returns 401 missing_identity", async () => {
    const app = appWithAuth(authMod.nyxidAuth);
    const res = await app.request(
      authedReq({ "x-nyxid-user-id": USER_ID }),
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "missing_identity" });
    expect(fetchCount).toBe(0); // never touched JWKS
  });

  test("bad signature returns 401 invalid_identity_token", async () => {
    // JWKS advertises kp1, but we sign with a different key that happens to
    // carry the same kid — signature verification will fail.
    const kp1 = await makeKeypair("k1");
    const kp2 = await makeKeypair("k1"); // same kid, different key material
    currentJwks = jwksOf(kp1);
    const forged = await signToken(kp2, { sub: USER_ID });

    const app = appWithAuth(authMod.nyxidAuth);
    const res = await app.request(
      authedReq({
        "x-nyxid-user-id": USER_ID,
        "x-nyxid-identity-token": forged,
      }),
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_identity_token" });
    // One initial fetch + one lazy-refresh retry before giving up.
    expect(fetchCount).toBe(2);
  });

  test("sub mismatch returns 401 identity_mismatch", async () => {
    const kp = await makeKeypair("k1");
    currentJwks = jwksOf(kp);
    const token = await signToken(kp, { sub: "not-the-header-user" });

    const app = appWithAuth(authMod.nyxidAuth);
    const res = await app.request(
      authedReq({
        "x-nyxid-user-id": USER_ID,
        "x-nyxid-identity-token": token,
      }),
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "identity_mismatch" });
  });

  test("wrong issuer returns 401 invalid_identity_token", async () => {
    const kp = await makeKeypair("k1");
    currentJwks = jwksOf(kp);
    const token = await signToken(kp, {
      sub: USER_ID,
      issuer: "https://wrong-issuer.invalid",
    });

    const app = appWithAuth(authMod.nyxidAuth);
    const res = await app.request(
      authedReq({
        "x-nyxid-user-id": USER_ID,
        "x-nyxid-identity-token": token,
      }),
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_identity_token" });
    expect(fetchCount).toBe(1);
  });

  test("wrong audience returns 401 invalid_identity_token", async () => {
    const kp = await makeKeypair("k1");
    currentJwks = jwksOf(kp);
    const token = await signToken(kp, {
      sub: USER_ID,
      audience: "another-service",
    });

    const app = appWithAuth(authMod.nyxidAuth);
    const res = await app.request(
      authedReq({
        "x-nyxid-user-id": USER_ID,
        "x-nyxid-identity-token": token,
      }),
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_identity_token" });
    expect(fetchCount).toBe(1);
  });

  test("stale JWKS kid triggers one refresh + retry and passes", async () => {
    // Prime the cache with an old JWKS containing only `k-old`.
    const oldKp = await makeKeypair("k-old");
    currentJwks = jwksOf(oldKp);

    // Warm the cache with a successful verification against k-old.
    const warmToken = await signToken(oldKp, { sub: USER_ID });
    const app = appWithAuth(authMod.nyxidAuth);
    const warm = await app.request(
      authedReq({
        "x-nyxid-user-id": USER_ID,
        "x-nyxid-identity-token": warmToken,
      }),
    );
    expect(warm.status).toBe(200);
    expect(fetchCount).toBe(1);

    // NyxID rotates: the cache still has only k-old, but the incoming token
    // is signed by k-new. Server-side JWKS now advertises both.
    const newKp = await makeKeypair("k-new");
    currentJwks = jwksOf(oldKp, newKp);
    const rotatedToken = await signToken(newKp, { sub: USER_ID });

    const rotated = await app.request(
      authedReq({
        "x-nyxid-user-id": USER_ID,
        "x-nyxid-identity-token": rotatedToken,
      }),
    );

    expect(rotated.status).toBe(200);
    expect(await rotated.json()).toEqual({ user_id: USER_ID });
    // Warm (1) + first-attempt cache-hit (0, no fetch) + one lazy refresh (1)
    // = 2 total fetches across both requests.
    expect(fetchCount).toBe(2);
  });

  test("JWKS network fail with no cache returns 503 auth_unavailable", async () => {
    failNextFetch = "error";
    // Token contents don't matter — we never get past the JWKS fetch.
    const kp = await makeKeypair("k1");
    const token = await signToken(kp, { sub: USER_ID });

    const app = appWithAuth(authMod.nyxidAuth);
    const res = await app.request(
      authedReq({
        "x-nyxid-user-id": USER_ID,
        "x-nyxid-identity-token": token,
      }),
    );

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "auth_unavailable" });
  });
});

describe("optionalNyxidAuth", () => {
  test("with no headers, sets user_id to null and continues", async () => {
    const app = appWithAuth(authMod.optionalNyxidAuth);
    const res = await app.request(authedReq({}));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user_id: null });
    expect(fetchCount).toBe(0);
  });

  test("with valid headers, verifies and sets user_id", async () => {
    const kp = await makeKeypair("k1");
    currentJwks = jwksOf(kp);
    const token = await signToken(kp, { sub: USER_ID });

    const app = appWithAuth(authMod.optionalNyxidAuth);
    const res = await app.request(
      authedReq({
        "x-nyxid-user-id": USER_ID,
        "x-nyxid-identity-token": token,
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user_id: USER_ID });
  });
});

describe("nyxidAuth — static-bearer fallback", () => {
  const STATIC_BEARER = "tok-test-tok-test-tok-test-tok-test";
  const STATIC_USER_ID = "00000000-0000-0000-0000-000000000001";

  async function runStaticBearerCase(opts: {
    env?: Record<string, string>;
    unsetEnv?: string[];
    headers?: Record<string, string>;
  }) {
    const childEnv = {
      ...process.env,
      ...ENV_DEFAULTS,
      ...(opts.env ?? {}),
    } as Record<string, string>;
    for (const key of opts.unsetEnv ?? []) {
      delete childEnv[key];
    }

    const script = `
      import { Hono } from "hono";

      const app = new Hono();
      const { nyxidAuth } = await import("./src/middleware/auth.ts");
      app.use("*", nyxidAuth);
      app.get("/whoami", (c) => c.json({ user_id: c.get("user_id") }));

      const res = await app.request(
        new Request("http://test.local/whoami", {
          headers: ${JSON.stringify(opts.headers ?? {})},
        }),
      );

      console.log(JSON.stringify({
        status: res.status,
        body: await res.json(),
      }));
    `;

    const proc = Bun.spawn({
      cmd: ["bun", "-e", script],
      cwd: process.cwd(),
      env: childEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    return {
      stderr,
      result: JSON.parse(stdout.trim()) as {
        status: number;
        body: { error?: string; user_id?: string | null };
      },
    };
  }

  test("env not set: Authorization bearer still returns 401 missing_identity", async () => {
    const { result } = await runStaticBearerCase({
      unsetEnv: ["NOCTURNE_STATIC_BEARER"],
      headers: { authorization: "Bearer whatever" },
    });

    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: "missing_identity" });
  });

  test("env set + matching bearer + no NyxID headers returns sentinel user", async () => {
    const { stderr, result } = await runStaticBearerCase({
      env: { NOCTURNE_STATIC_BEARER: STATIC_BEARER },
      headers: { authorization: `Bearer ${STATIC_BEARER}` },
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ user_id: STATIC_USER_ID });
    expect(stderr).toContain("auth: static bearer accepted");
  });

  test("env set + wrong bearer falls through to 401 missing_identity", async () => {
    const { result } = await runStaticBearerCase({
      env: { NOCTURNE_STATIC_BEARER: STATIC_BEARER },
      headers: { authorization: "Bearer wrong-token" },
    });

    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: "missing_identity" });
  });

  test("production env + force off disables the static bearer path", async () => {
    const { result } = await runStaticBearerCase({
      env: {
        NODE_ENV: "production",
        NOCTURNE_STATIC_BEARER: STATIC_BEARER,
        NOCTURNE_STATIC_BEARER_FORCE: "0",
      },
      headers: { authorization: `Bearer ${STATIC_BEARER}` },
    });

    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: "missing_identity" });
  });
});
