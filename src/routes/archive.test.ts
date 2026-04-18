/**
 * Route tests for `GET /u/{slug}`.
 *
 * Harness notes:
 *   - Env is populated by `./test-env.ts` (loaded first).
 *   - The Postgres client is replaced with a route-driven fake via
 *     `__setClient__`. Each test installs its own `Responder` that maps
 *     `(sql, values)` pairs to fake rows — this lets us simulate "token is
 *     revoked", "token is expired", "listPagesForUser returns 3 rows", etc.
 *   - NyxID JWKS is replaced with a local RSA keypair. The same pattern as
 *     `src/middleware/auth.test.ts`: a single shared key, no rotation logic.
 *
 * Each test constructs a fresh sub-app via `archiveRoutes()` so there's no
 * cross-test state in the router itself.
 */

import "./test-env.ts"; // MUST be first — populates env for src/config.ts.

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
import postgres, { type Sql } from "postgres";
import { config } from "../config.ts";
import { IndexError, __internals__, __setClient__ } from "../index/supabase.ts";
import {
  __clearJwksCacheForTesting,
  __setJwksFetcherForTesting,
} from "../middleware/auth.ts";
import { deriveUserSlug } from "../utils/user-slug.ts";
import { archiveRoutes } from "./archive.ts";

// ---------------------------------------------------------------------------
// Fake SQL — captures queries and responds via an injected responder.

interface CapturedQuery {
  sql: string;
  values: unknown[];
}
type Responder = (q: CapturedQuery) => unknown;

interface FakeSql {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
  captured: CapturedQuery[];
  setResponder(fn: Responder): void;
  json(value: unknown): { __json__: unknown };
}

function makeFakeSql(): FakeSql {
  let responder: Responder = () => [];
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    let sql = "";
    for (let i = 0; i < strings.length; i++) {
      sql += strings[i];
      if (i < values.length) sql += `$${i + 1}`;
    }
    const capture = { sql, values };
    fake.captured.push(capture);
    return Promise.resolve(responder(capture));
  }) as FakeSql;
  fn.captured = [];
  fn.setResponder = (r) => {
    responder = r;
  };
  fn.json = (v) => ({ __json__: v });
  const fake = fn;
  return fake;
}

function installFakeSql(): FakeSql {
  // Silence unused-import lint; `postgres` is imported only for its type.
  void postgres;
  const fake = makeFakeSql();
  __setClient__(fake as unknown as Sql);
  return fake;
}

// ---------------------------------------------------------------------------
// JWKS / JWT helpers — same pattern as middleware/auth.test.ts

interface Keypair {
  kid: string;
  privateKey: KeyLike;
  publicJwk: JWK;
}

async function makeKeypair(kid = "k1"): Promise<Keypair> {
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = kid;
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  return { kid, privateKey, publicJwk };
}

async function signFor(kp: Keypair, sub: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: kp.kid })
    .setIssuer(config.NYXID_BASE_URL)
    .setAudience("nocturne")
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(kp.privateKey);
}

// ---------------------------------------------------------------------------
// Fixtures

const OWNER_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ID = "22222222-2222-2222-2222-222222222222";

let ownerSlug!: string;
let otherSlug!: string;
let keypair!: Keypair;
let jwks!: JSONWebKeySet;
let disposeFetcher: (() => void) | null = null;

beforeAll(async () => {
  keypair = await makeKeypair();
  jwks = { keys: [keypair.publicJwk] };
  ownerSlug = await deriveUserSlug(OWNER_ID, config.NYXID_SERVICE_SECRET);
  otherSlug = await deriveUserSlug(OTHER_ID, config.NYXID_SERVICE_SECRET);
});

beforeEach(() => {
  disposeFetcher = __setJwksFetcherForTesting(async () => jwks);
});

afterEach(() => {
  disposeFetcher?.();
  disposeFetcher = null;
  __clearJwksCacheForTesting();
  __setClient__(null);
});

// ---------------------------------------------------------------------------
// Responder helpers — map queries to behaviours.

type TokenOutcome =
  | { kind: "resolved"; user_id: string }
  | { kind: "not_found" };

/**
 * Build a responder that serves:
 *   - `resolveShareToken` → the given outcome, keyed off the presence of
 *     `token_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR
 *     expires_at > NOW())`.
 *   - `listPagesForUser` → a canned list per user_id.
 */
function buildResponder(opts: {
  tokens?: Map<string /* token plaintext */, TokenOutcome>;
  pages?: Map<string /* user_id */, Array<Record<string, unknown>>>;
}): Responder {
  return ({ sql, values }) => {
    const s = sql.replace(/\s+/g, " ").trim();
    if (/FROM nocturne\.archive_share_tokens/.test(s) && /token_hash/.test(s)) {
      // `resolveShareToken` hashes the plaintext before querying — so `values[0]`
      // is the SHA-256 hex of the token. Our responder matches on that.
      const hash = String(values[0]);
      for (const [token, outcome] of opts.tokens ?? []) {
        if (sha256Hex(token) === hash) {
          if (outcome.kind === "resolved") {
            return [{ user_id: outcome.user_id }];
          }
          return [];
        }
      }
      return [];
    }
    if (/FROM nocturne\.pages/.test(s) && /WHERE user_id/.test(s)) {
      const uid = String(values[0]);
      return opts.pages?.get(uid) ?? [];
    }
    return [];
  };
}

function sha256Hex(s: string): string {
  // Match the production hasher exactly — the fake SQL responder sees the
  // hash, not the plaintext, so our token map lookup has to hash too.
  return __internals__.sha256Hex(s);
}

// ---------------------------------------------------------------------------
// App builder

function mountApp(): Hono {
  const app = new Hono();
  app.route("/", archiveRoutes());
  return app;
}

// ---------------------------------------------------------------------------
// Tests

describe("GET /u/{slug} — auth branch", () => {
  test("owner with valid NyxID auth gets their archive", async () => {
    const fake = installFakeSql();
    fake.setResponder(
      buildResponder({
        pages: new Map([
          [
            OWNER_ID,
            [
              {
                page_id: "pg_aaa",
                user_id: OWNER_ID,
                storage_key: `${OWNER_ID}/pg_aaa.html`,
                spec_id: "executive-broadsheet",
                content_type: "daily_brief_v1",
                rating: null,
                created_at: new Date("2026-04-17T10:00:00Z"),
              },
              {
                page_id: "pg_bbb",
                user_id: OWNER_ID,
                storage_key: `${OWNER_ID}/pg_bbb.html`,
                spec_id: "quiet-ledger",
                content_type: "daily_brief_v1",
                rating: null,
                created_at: new Date("2026-04-16T09:00:00Z"),
              },
            ],
          ],
        ]),
      }),
    );

    const token = await signFor(keypair, OWNER_ID);
    const res = await mountApp().request(`/u/${ownerSlug}`, {
      headers: {
        "x-nyxid-user-id": OWNER_ID,
        "x-nyxid-identity-token": token,
      },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<h1>All your Nocturnes</h1>");
    expect(body).toContain("2 Nocturnes");
    expect(body).toContain("pg_aaa");
    expect(body).toContain("pg_bbb");
    expect(body).toContain("executive-broadsheet");
    expect(body).toContain('href="/v/pg_aaa"');
    // No CSS / styles — DESIGN.md contract.
    expect(body).not.toContain("<style");
    expect(body).not.toContain("<link ");
  });

  test("authed user looking at another user's slug gets 404", async () => {
    const fake = installFakeSql();
    fake.setResponder(buildResponder({ pages: new Map() }));

    const token = await signFor(keypair, OWNER_ID);
    const res = await mountApp().request(`/u/${otherSlug}`, {
      headers: {
        "x-nyxid-user-id": OWNER_ID,
        "x-nyxid-identity-token": token,
      },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  test("no auth, no token → 401 auth_required", async () => {
    const fake = installFakeSql();
    fake.setResponder(buildResponder({}));

    const res = await mountApp().request(`/u/${ownerSlug}`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "auth_required" });
  });

  test("malformed slug → 404 without hitting DB", async () => {
    const fake = installFakeSql();
    fake.setResponder(buildResponder({}));

    const res = await mountApp().request("/u/not-a-real-slug");
    expect(res.status).toBe(404);
    // No DB calls — the slug regex short-circuits.
    expect(
      fake.captured.filter((q) =>
        /FROM nocturne\.(pages|archive_share_tokens)/.test(q.sql),
      ).length,
    ).toBe(0);
  });
});

describe("GET /u/{slug} — share-token branch", () => {
  test("anon with valid share token sees the archive", async () => {
    const TOKEN = "abc123TOKEN";
    const fake = installFakeSql();
    fake.setResponder(
      buildResponder({
        tokens: new Map([[TOKEN, { kind: "resolved", user_id: OWNER_ID }]]),
        pages: new Map([
          [
            OWNER_ID,
            [
              {
                page_id: "pg_xxx",
                user_id: OWNER_ID,
                storage_key: `${OWNER_ID}/pg_xxx.html`,
                spec_id: "guji-classical",
                content_type: "daily_brief_v1",
                rating: null,
                created_at: new Date("2026-04-10T00:00:00Z"),
              },
            ],
          ],
        ]),
      }),
    );

    const res = await mountApp().request(
      `/u/${ownerSlug}?token=${encodeURIComponent(TOKEN)}`,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("pg_xxx");
    expect(body).toContain("guji-classical");
  });

  test("anon with unknown / revoked / expired token → 401 invalid_share_token", async () => {
    const TOKEN = "invalid-or-revoked";
    // resolveShareToken returns empty for anything failing the active predicate;
    // our responder models that with an empty token map.
    const fake = installFakeSql();
    fake.setResponder(
      buildResponder({
        tokens: new Map([[TOKEN, { kind: "not_found" }]]),
      }),
    );

    const res = await mountApp().request(
      `/u/${ownerSlug}?token=${encodeURIComponent(TOKEN)}`,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_share_token" });
  });

  test("token for user X on slug for user Y → 404 (token valid but wrong URL)", async () => {
    const TOKEN = "tok-for-other";
    const fake = installFakeSql();
    fake.setResponder(
      buildResponder({
        tokens: new Map([[TOKEN, { kind: "resolved", user_id: OTHER_ID }]]),
      }),
    );

    const res = await mountApp().request(
      `/u/${ownerSlug}?token=${encodeURIComponent(TOKEN)}`,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  test("expired/revoked tokens are modelled by resolveShareToken returning null", async () => {
    // Double-check the two separate scenarios resolve through the same 401 path.
    // We also assert that the handler did not fall through to the auth branch
    // (which would return auth_required instead of invalid_share_token).
    for (const scenario of ["revoked", "expired"] as const) {
      const fake = installFakeSql();
      fake.setResponder(() => []);

      const res = await mountApp().request(
        `/u/${ownerSlug}?token=${encodeURIComponent(scenario)}`,
      );
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "invalid_share_token" });
      __setClient__(null);
    }
  });
});

describe("GET /u/{slug} — IndexError mapping", () => {
  test("listPagesForUser throwing IndexError(unavailable) → 503 index_unavailable", async () => {
    const fake = installFakeSql();
    fake.setResponder(() => {
      throw new IndexError("unavailable", "simulated outage");
    });

    // Valid token resolves via a separate responder branch, so route an auth
    // path instead — but the responder throws unconditionally. Use the
    // auth-branch listPagesForUser path.
    const kp = await makeKeypair();
    __setJwksFetcherForTesting(async () => ({ keys: [kp.publicJwk] }));
    const token = await signFor(kp, OWNER_ID);

    const res = await mountApp().request(`/u/${ownerSlug}`, {
      headers: {
        "x-nyxid-user-id": OWNER_ID,
        "x-nyxid-identity-token": token,
      },
    });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "index_unavailable" });
    __setJwksFetcherForTesting(null);
    __clearJwksCacheForTesting();
    __setClient__(null);
  });
});
