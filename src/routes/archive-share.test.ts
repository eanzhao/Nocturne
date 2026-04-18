/**
 * Route tests for share-token lifecycle — POST / GET / DELETE /u/share.
 *
 * Harness mirrors `archive.test.ts`: fake SQL + locally-signed JWKS. We
 * drive the full Hono pipeline (including `nyxidAuth`) so the tests prove
 * the happy path AND the "unauthenticated → 401" path through the real
 * middleware, not a shortcut.
 *
 * The key assertions are:
 *   - `POST /u/share` returns plaintext `token` on creation, and
 *   - `GET /u/share` never does, even right after.
 *   - TTL clamping: `ttl_days: 0` → 1 day; `ttl_days: 9999` → 365 days.
 *   - Revoke honors ownership: 404 for non-owner, 200 for owner.
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
import { type Sql } from "postgres";
import { config } from "../config.ts";
import { IndexError, __setClient__ } from "../index/supabase.ts";
import {
  __clearJwksCacheForTesting,
  __setJwksFetcherForTesting,
} from "../middleware/auth.ts";
import { deriveUserSlug } from "../utils/user-slug.ts";
import { archiveShareRoutes } from "./archive-share.ts";

// ---------------------------------------------------------------------------
// Fake SQL

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
    const result = responder(capture);
    // Match postgres.js behaviour: tagged-template result shape allows
    // `result.count` after UPDATE; surface that here for revoke tests.
    return Promise.resolve(result);
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
  const fake = makeFakeSql();
  __setClient__(fake as unknown as Sql);
  return fake;
}

// ---------------------------------------------------------------------------
// JWKS / JWT helpers

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

let keypair!: Keypair;
let jwks!: JSONWebKeySet;
let ownerSlug!: string;
let disposeFetcher: (() => void) | null = null;

beforeAll(async () => {
  keypair = await makeKeypair();
  jwks = { keys: [keypair.publicJwk] };
  ownerSlug = await deriveUserSlug(OWNER_ID, config.NYXID_SERVICE_SECRET);
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

function mountApp(): Hono {
  const app = new Hono();
  app.route("/", archiveShareRoutes());
  return app;
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await signFor(keypair, OWNER_ID);
  return {
    "x-nyxid-user-id": OWNER_ID,
    "x-nyxid-identity-token": token,
    "content-type": "application/json",
  };
}

// ---------------------------------------------------------------------------
// Tests

describe("POST /u/share", () => {
  test("creates a token, returns plaintext ONCE, includes share URL", async () => {
    const fake = installFakeSql();
    const TOKEN_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    fake.setResponder(({ sql }) => {
      if (/INSERT INTO nocturne\.archive_share_tokens/.test(sql)) {
        return [{ token_id: TOKEN_ID }];
      }
      return [];
    });

    const res = await mountApp().request("/u/share", {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({ ttl_days: 30 }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      token: string;
      token_id: string;
      url: string;
      expires_at: string;
    };

    expect(body.token_id).toBe(TOKEN_ID);
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(10); // base62 of 16 bytes
    expect(body.url).toBe(
      `${config.BASE_URL}/u/${ownerSlug}?token=${encodeURIComponent(body.token)}`,
    );
    // expires_at should be ~30 days from now.
    const exp = new Date(body.expires_at).getTime();
    const diffDays = (exp - Date.now()) / 86_400_000;
    expect(diffDays).toBeGreaterThan(29);
    expect(diffDays).toBeLessThan(31);
  });

  test("clamps ttl_days below 1 up to 1", async () => {
    const fake = installFakeSql();
    fake.setResponder(({ sql }) => {
      if (/INSERT INTO nocturne\.archive_share_tokens/.test(sql)) {
        return [{ token_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" }];
      }
      return [];
    });

    const res = await mountApp().request("/u/share", {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({ ttl_days: 0 }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { expires_at: string };
    const diffDays = (new Date(body.expires_at).getTime() - Date.now()) / 86_400_000;
    // clamped to exactly 1 day, allow a few seconds of drift.
    expect(diffDays).toBeGreaterThan(0.99);
    expect(diffDays).toBeLessThan(1.01);
  });

  test("clamps ttl_days above 365 down to 365", async () => {
    const fake = installFakeSql();
    fake.setResponder(({ sql }) => {
      if (/INSERT INTO nocturne\.archive_share_tokens/.test(sql)) {
        return [{ token_id: "cccccccc-cccc-cccc-cccc-cccccccccccc" }];
      }
      return [];
    });

    const res = await mountApp().request("/u/share", {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({ ttl_days: 9999 }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { expires_at: string };
    const diffDays = (new Date(body.expires_at).getTime() - Date.now()) / 86_400_000;
    expect(diffDays).toBeGreaterThan(364.99);
    expect(diffDays).toBeLessThan(365.01);
  });

  test("default TTL when body is omitted is 90 days", async () => {
    const fake = installFakeSql();
    fake.setResponder(({ sql }) => {
      if (/INSERT INTO nocturne\.archive_share_tokens/.test(sql)) {
        return [{ token_id: "dddddddd-dddd-dddd-dddd-dddddddddddd" }];
      }
      return [];
    });

    const res = await mountApp().request("/u/share", {
      method: "POST",
      headers: await authHeaders(),
      // no body
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { expires_at: string };
    const diffDays = (new Date(body.expires_at).getTime() - Date.now()) / 86_400_000;
    expect(diffDays).toBeGreaterThan(89.99);
    expect(diffDays).toBeLessThan(90.01);
  });

  test("rejects unauthenticated requests with 401", async () => {
    installFakeSql();
    const res = await mountApp().request("/u/share", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ttl_days: 30 }),
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /u/share", () => {
  test("returns tokens for the caller, never including plaintext", async () => {
    const fake = installFakeSql();
    const now = new Date("2026-04-17T00:00:00Z");
    const expires = new Date("2026-07-17T00:00:00Z");
    fake.setResponder(({ sql }) => {
      if (/FROM nocturne\.archive_share_tokens/.test(sql)) {
        return [
          {
            token_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            created_at: now,
            expires_at: expires,
            revoked_at: null,
          },
          {
            token_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            created_at: now,
            expires_at: expires,
            revoked_at: new Date("2026-04-18T00:00:00Z"),
          },
        ];
      }
      return [];
    });

    const res = await mountApp().request("/u/share", {
      headers: await authHeaders(),
    });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    const bodyText = JSON.stringify(rows);
    expect(bodyText).not.toContain("token_hash");
    // No plaintext `token` field is ever returned on list.
    expect(rows.every((r) => !("token" in r))).toBe(true);
    expect(rows[0]).toEqual({
      token_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      created_at: now.toISOString(),
      expires_at: expires.toISOString(),
      revoked_at: null,
    });
    expect(rows[1]?.revoked_at).toBe("2026-04-18T00:00:00.000Z");
  });

  test("create-then-list: the plaintext from POST is not echoed by GET", async () => {
    // Simulate the full flow: POST returns plaintext; the subsequent GET
    // only sees metadata. The responder models that the server stores only
    // the hash.
    const fake = installFakeSql();
    const TOKEN_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    fake.setResponder(({ sql }) => {
      if (/INSERT INTO nocturne\.archive_share_tokens/.test(sql)) {
        return [{ token_id: TOKEN_ID }];
      }
      if (/FROM nocturne\.archive_share_tokens/.test(sql)) {
        return [
          {
            token_id: TOKEN_ID,
            created_at: new Date(),
            expires_at: new Date(Date.now() + 90 * 86_400_000),
            revoked_at: null,
          },
        ];
      }
      return [];
    });

    const app = mountApp();
    const headers = await authHeaders();

    const postRes = await app.request("/u/share", {
      method: "POST",
      headers,
      body: JSON.stringify({ ttl_days: 90 }),
    });
    const postBody = (await postRes.json()) as { token: string };
    expect(postBody.token).toBeTruthy();

    const listRes = await app.request("/u/share", { headers });
    const listBody = (await listRes.json()) as Array<Record<string, unknown>>;
    // The plaintext token must not appear anywhere in the list response.
    expect(JSON.stringify(listBody)).not.toContain(postBody.token);
  });
});

describe("DELETE /u/share/:token_id", () => {
  test("returns 200 on successful owner-revoke", async () => {
    const fake = installFakeSql();
    fake.setResponder(({ sql }) => {
      if (/UPDATE nocturne\.archive_share_tokens/.test(sql)) {
        // postgres.js returns an array-like object with `count` on mutations.
        const r: { count: number } = { count: 1 };
        return r;
      }
      return [];
    });

    const res = await mountApp().request(
      "/u/share/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      { method: "DELETE", headers: await authHeaders() },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("returns 404 when token_id doesn't match the caller (or doesn't exist)", async () => {
    const fake = installFakeSql();
    fake.setResponder(({ sql }) => {
      if (/UPDATE nocturne\.archive_share_tokens/.test(sql)) {
        return { count: 0 };
      }
      return [];
    });

    const res = await mountApp().request(
      "/u/share/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      { method: "DELETE", headers: await authHeaders() },
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  test("rejects unauthenticated delete with 401", async () => {
    installFakeSql();
    const res = await mountApp().request(
      "/u/share/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      { method: "DELETE" },
    );
    expect(res.status).toBe(401);
  });
});

describe("IndexError mapping", () => {
  test("createShareToken throwing IndexError(duplicate) → 500 duplicate_page_id", async () => {
    const fake = installFakeSql();
    fake.setResponder(() => {
      throw new IndexError("duplicate", "simulated unique-violation");
    });

    const res = await mountApp().request("/u/share", {
      method: "POST",
      headers: { ...(await authHeaders()), "content-type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "duplicate_page_id" });
  });
});
