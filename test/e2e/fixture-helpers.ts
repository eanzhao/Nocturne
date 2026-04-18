/**
 * Shared helpers for the E2E suite.
 *
 * Three concerns, each isolated:
 *   1. **JWKS keypair + JWT signing** — same pattern as
 *      `src/middleware/auth.test.ts`. Generated once per test file in
 *      `beforeAll`, exposed via the `Keypair` handle.
 *   2. **Fake `Sql` client** — the tagged-template responder used across the
 *      v0 supabase tests, with a richer "in-memory row store" for the E2E
 *      flows that need to remember what a prior request inserted (e.g. the
 *      sequence test running twice in a row).
 *   3. **App composition** — each E2E file mounts its own fresh `Hono` app
 *      via `mountFullApp` so there's no cross-file router state.
 */
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  type JSONWebKeySet,
  type JWK,
  type KeyLike,
} from "jose";
import type { Sql } from "postgres";

import { config } from "../../src/config.ts";
import { __setClient__ } from "../../src/index/supabase.ts";
import {
  __clearJwksCacheForTesting,
  __setJwksFetcherForTesting,
} from "../../src/middleware/auth.ts";
import { archiveRoutes } from "../../src/routes/archive.ts";
import { archiveShareRoutes } from "../../src/routes/archive-share.ts";
import { formatRouter } from "../../src/routes/format.ts";
import { rateRouter } from "../../src/routes/rate.ts";
import { viewRouter } from "../../src/routes/view.ts";
import { deriveUserSlug } from "../../src/utils/user-slug.ts";
import { setFixtureJwks, startFixture } from "./fixture-server.ts";

import { Hono } from "hono";

// ---------------------------------------------------------------------------
// JWT / JWKS
// ---------------------------------------------------------------------------

export interface Keypair {
  kid: string;
  privateKey: KeyLike;
  publicJwk: JWK;
}

export async function makeKeypair(kid = "k1"): Promise<Keypair> {
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = kid;
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  return { kid, privateKey, publicJwk };
}

export function jwksOf(...pairs: Keypair[]): JSONWebKeySet {
  return { keys: pairs.map((p) => p.publicJwk) };
}

export async function signFor(
  kp: Keypair,
  sub: string,
  opts: { expiresIn?: string } = {},
): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: kp.kid })
    .setIssuer("https://nyx-test.invalid")
    .setAudience("nocturne")
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? "60s")
    .sign(kp.privateKey);
}

/**
 * Build the standard NyxID-proxy-injected header set. `/format` also needs the
 * delegation token; other routes skip it.
 */
export async function authHeaders(
  kp: Keypair,
  userId: string,
  opts: { withDelegation?: boolean } = {},
): Promise<Record<string, string>> {
  const token = await signFor(kp, userId);
  const hdrs: Record<string, string> = {
    "x-nyxid-user-id": userId,
    "x-nyxid-identity-token": token,
    "content-type": "application/json",
  };
  if (opts.withDelegation !== false) {
    hdrs["x-nyxid-delegation-token"] = "test-delegation-token";
  }
  return hdrs;
}

// ---------------------------------------------------------------------------
// Fake `Sql` — in-memory pages / sequences / share-tokens.
// ---------------------------------------------------------------------------

export interface PageRow {
  page_id: string;
  user_id: string;
  storage_key: string;
  spec_id: string;
  content_type: string;
  rating: "good" | "bad" | null;
  created_at: Date;
}

export interface ShareTokenRow {
  token_id: string;
  user_id: string;
  token_hash: string;
  created_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
}

/**
 * In-memory index — what a real Postgres would store for the tables we touch.
 * The fake `Sql` closure below dispatches tagged-template queries against
 * this state, implementing just enough SQL semantics to run the E2E flows.
 */
export interface IndexState {
  pages: PageRow[];
  sequences: Map<string, number>;
  shareTokens: ShareTokenRow[];
  /** Each captured query — useful for assertions where needed. */
  captured: Array<{ sql: string; values: unknown[] }>;
}

export function newIndexState(): IndexState {
  return {
    pages: [],
    sequences: new Map(),
    shareTokens: [],
    captured: [],
  };
}

/**
 * A tiny SQL-dispatch for the fake Sql. We do string-matching on the query
 * shape (already proven stable by the unit tests in
 * `src/index/supabase.test.ts`). The dispatch is intentionally minimal — only
 * the queries the E2E flows exercise are handled; unknown queries return an
 * empty array so the fake never silently succeeds on a mis-spelled match.
 */
function dispatchQuery(
  state: IndexState,
  sql: string,
  values: unknown[],
): unknown {
  const s = sql.replace(/\s+/g, " ").trim();

  // ---- pages ---------------------------------------------------------------

  if (/INSERT INTO nocturne\.pages/.test(s)) {
    state.pages.push({
      page_id: String(values[0]),
      user_id: String(values[1]),
      storage_key: String(values[2]),
      spec_id: String(values[3]),
      content_type: String(values[4]),
      rating: null,
      created_at: new Date(),
    });
    return [];
  }

  if (/SELECT[\s\S]+FROM nocturne\.pages[\s\S]+WHERE page_id/.test(s)) {
    const pageId = String(values[0]);
    const row = state.pages.find((p) => p.page_id === pageId);
    return row ? [row] : [];
  }

  if (/SELECT[\s\S]+FROM nocturne\.pages[\s\S]+WHERE user_id/.test(s)) {
    const uid = String(values[0]);
    const rows = state.pages
      .filter((p) => p.user_id === uid)
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
    return rows;
  }

  if (/UPDATE nocturne\.pages[\s\S]+SET rating/.test(s)) {
    const rating = values[0] as "good" | "bad";
    const pageId = String(values[1]);
    const row = state.pages.find((p) => p.page_id === pageId);
    if (row) row.rating = rating;
    return { count: row ? 1 : 0 };
  }

  // ---- page_sequence (atomic upsert) ---------------------------------------

  if (/INSERT INTO nocturne\.page_sequence/.test(s)) {
    const uid = String(values[0]);
    const next = (state.sequences.get(uid) ?? 0) + 1;
    state.sequences.set(uid, next);
    return [{ last_seq: next }];
  }

  // ---- share tokens --------------------------------------------------------

  if (/INSERT INTO nocturne\.archive_share_tokens/.test(s)) {
    const tokenId = crypto.randomUUID();
    state.shareTokens.push({
      token_id: tokenId,
      user_id: String(values[0]),
      token_hash: String(values[1]),
      created_at: new Date(),
      expires_at: (values[2] as Date) ?? null,
      revoked_at: null,
    });
    return [{ token_id: tokenId }];
  }

  if (
    /FROM nocturne\.archive_share_tokens/.test(s) &&
    /token_hash = \$1/.test(s)
  ) {
    const hash = String(values[0]);
    const now = Date.now();
    const row = state.shareTokens.find(
      (t) =>
        t.token_hash === hash &&
        t.revoked_at === null &&
        (t.expires_at === null || t.expires_at.getTime() > now),
    );
    return row ? [{ user_id: row.user_id }] : [];
  }

  if (/UPDATE nocturne\.archive_share_tokens[\s\S]+SET revoked_at/.test(s)) {
    const tokenId = String(values[0]);
    const uid = String(values[1]);
    const row = state.shareTokens.find(
      (t) =>
        t.token_id === tokenId && t.user_id === uid && t.revoked_at === null,
    );
    if (row) {
      row.revoked_at = new Date();
      return { count: 1 };
    }
    return { count: 0 };
  }

  if (
    /FROM nocturne\.archive_share_tokens/.test(s) &&
    /WHERE user_id = \$1/.test(s)
  ) {
    const uid = String(values[0]);
    return state.shareTokens
      .filter((t) => t.user_id === uid)
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
      .map((t) => ({
        token_id: t.token_id,
        created_at: t.created_at,
        expires_at: t.expires_at,
        revoked_at: t.revoked_at,
      }));
  }

  // ---- planner fallback log ------------------------------------------------

  if (/INSERT INTO nocturne\.planner_fallback_log/.test(s)) {
    return [];
  }

  return [];
}

interface FakeSql {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
  state: IndexState;
  json(value: unknown): { __json__: unknown };
}

export function installIndexFake(): IndexState {
  const state = newIndexState();
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    let sql = "";
    for (let i = 0; i < strings.length; i++) {
      sql += strings[i];
      if (i < values.length) sql += `$${i + 1}`;
    }
    state.captured.push({ sql, values });
    const result = dispatchQuery(state, sql, values);
    return Promise.resolve(result);
  }) as FakeSql;
  fn.state = state;
  fn.json = (value: unknown) => ({ __json__: value });
  __setClient__(fn as unknown as Sql);
  return state;
}

// ---------------------------------------------------------------------------
// JWKS installation — connects the auth middleware to our singleton fixture.
// ---------------------------------------------------------------------------

/**
 * Register a keypair with the NyxID fixture AND with the auth middleware's
 * local JWKS cache. Returns a disposer that tears both down.
 *
 * We use the DI hook `__setJwksFetcherForTesting` rather than letting the
 * middleware go over HTTP — the rationale from the issue brief: fewer moving
 * parts, no need for the fixture server to be reachable before `auth.ts`
 * warms up its cache.
 */
export function installJwks(kp: Keypair): () => void {
  const jwks = jwksOf(kp);
  setFixtureJwks(jwks); // reachable via /.well-known/jwks.json too
  const dispose = __setJwksFetcherForTesting(async () => jwks);
  return () => {
    dispose();
    __clearJwksCacheForTesting();
  };
}

// ---------------------------------------------------------------------------
// App composition
// ---------------------------------------------------------------------------

/**
 * Build a fresh Hono app wiring every v0-alpha route — the same set `app.ts`
 * exports, but isolated per test file to avoid any shared-router state. We
 * deliberately do NOT import `src/app.ts`: it calls `OpenAPIHono().openapi(...)`
 * which registers schemas globally, and repeated registrations across tests
 * have bitten us in the past.
 */
export function mountFullApp(): Hono {
  const app = new Hono();
  app.route("/", formatRouter);
  app.route("/", viewRouter);
  app.route("/", rateRouter);
  app.route("/", archiveRoutes());
  app.route("/", archiveShareRoutes());
  return app;
}

// ---------------------------------------------------------------------------
// Convenience: start fixture + install keys + install SQL in one call.
// ---------------------------------------------------------------------------

export interface E2EHarness {
  keypair: Keypair;
  ownerSlug: string;
  userId: string;
  indexState: IndexState;
  disposeJwks: () => void;
}

export async function bootE2E(userId: string): Promise<E2EHarness> {
  startFixture();
  const keypair = await makeKeypair();
  const ownerSlug = await deriveUserSlug(
    userId,
    config.NYXID_SERVICE_SECRET,
  );
  const disposeJwks = installJwks(keypair);
  const indexState = installIndexFake();
  return { keypair, ownerSlug, userId, indexState, disposeJwks };
}
