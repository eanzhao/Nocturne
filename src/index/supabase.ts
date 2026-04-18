/**
 * Supabase (Postgres) index client — the authoritative record of every page,
 * its sequence number, its rating, and archive share tokens.
 *
 * Wraps the `postgres` library (Bun-compatible). Every statement runs under
 * a 5s `statement_timeout` set at connect time via the PG session config, so
 * a pathological query can never wedge a request indefinitely. We DO NOT add
 * retry logic in v0 — callers see a typed {@link IndexError} and decide.
 */
import crypto from "node:crypto";
import postgres, { type Sql } from "postgres";
import { config } from "../config.ts";

/**
 * The `postgres` driver attaches its error class to the default export at
 * runtime but does NOT re-export it as a named ES binding. So we reach through
 * the default import for the `instanceof` check.
 */
const PostgresError = (postgres as unknown as {
  PostgresError: new (...args: unknown[]) => Error;
}).PostgresError;

export type IndexErrorCode =
  | "timeout"
  | "duplicate"
  | "constraint"
  | "unavailable";

export class IndexError extends Error {
  readonly code: IndexErrorCode;
  readonly pgCode: string | undefined;
  override readonly cause: unknown;

  constructor(
    code: IndexErrorCode,
    message: string,
    opts: { pgCode?: string; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "IndexError";
    this.code = code;
    this.pgCode = opts.pgCode;
    this.cause = opts.cause;
  }
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

/**
 * Convert a Postgres driver error into a typed {@link IndexError}.
 *
 * SQLSTATE reference:
 *   - 23505 — unique_violation        → duplicate
 *   - 23503 — foreign_key_violation   → constraint
 *   - 23502 — not_null_violation      → constraint
 *   - 23514 — check_violation         → constraint
 *   - 57014 — query_canceled (statement_timeout fires this) → timeout
 *   - 08xxx — connection_exception family → unavailable
 */
function toIndexError(err: unknown, op: string): IndexError {
  if (err instanceof IndexError) return err;
  if (err instanceof PostgresError) {
    const pgCode = (err as unknown as { code?: string }).code;
    if (pgCode === "23505") {
      return new IndexError("duplicate", `${op}: ${err.message}`, {
        pgCode,
        cause: err,
      });
    }
    if (pgCode === "23503" || pgCode === "23502" || pgCode === "23514") {
      return new IndexError("constraint", `${op}: ${err.message}`, {
        pgCode,
        cause: err,
      });
    }
    if (pgCode === "57014") {
      return new IndexError(
        "timeout",
        `${op}: statement_timeout exceeded`,
        { pgCode, cause: err },
      );
    }
    if (pgCode?.startsWith("08")) {
      return new IndexError("unavailable", `${op}: ${err.message}`, {
        pgCode,
        cause: err,
      });
    }
    return new IndexError("unavailable", `${op}: ${err.message}`, {
      pgCode,
      cause: err,
    });
  }
  if (err instanceof Error && /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH/.test(err.message)) {
    return new IndexError("unavailable", `${op}: ${err.message}`, {
      cause: err,
    });
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new IndexError("unavailable", `${op}: ${msg}`, { cause: err });
}

/**
 * Build a `Sql` client configured for this service.
 *
 * Extracted so tests can stand up a throwaway instance against pg-mem or a
 * real test Postgres without having to monkey-patch the module-level
 * singleton.
 */
export function createClient(databaseUrl: string = config.DATABASE_URL): Sql {
  return postgres(databaseUrl, {
    // 5s hard deadline on every statement — protects the API path from a
    // stuck query holding a request hostage.
    connection: { statement_timeout: 5_000 },
    // No prepared statements across all connections: simpler pg-mem /
    // Supabase-PgBouncer-in-transaction-mode compatibility.
    prepare: false,
    // Silence postgres.js's stdout notices; tests don't want them.
    onnotice: () => {},
  });
}

/** Module-level singleton. */
let _sql: Sql | null = null;

export function getClient(): Sql {
  if (!_sql) _sql = createClient();
  return _sql;
}

/** Test-only: install a custom client (e.g. pg-mem). */
export function __setClient__(client: Sql | null): void {
  _sql = client;
}

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface Page {
  page_id: string;
  user_id: string;
  storage_key: string;
  spec_id: string;
  content_type: string;
  rating: "good" | "bad" | null;
  created_at: Date;
}

export interface InsertPageInput {
  page_id: string;
  user_id: string;
  storage_key: string;
  spec_id: string;
  content_type: string;
}

export interface ShareTokenCreateResult {
  token: string; // plaintext, returned ONCE
  token_id: string;
  expires_at: Date;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export async function insertPage(input: InsertPageInput): Promise<void> {
  const sql = getClient();
  try {
    await sql`
      INSERT INTO nocturne.pages (
        page_id, user_id, storage_key, spec_id, content_type
      ) VALUES (
        ${input.page_id},
        ${input.user_id},
        ${input.storage_key},
        ${input.spec_id},
        ${input.content_type}
      )
    `;
  } catch (err) {
    throw toIndexError(err, "insertPage");
  }
}

export async function getPage(page_id: string): Promise<Page | null> {
  const sql = getClient();
  try {
    const rows = await sql<Page[]>`
      SELECT page_id, user_id, storage_key, spec_id, content_type, rating, created_at
      FROM nocturne.pages
      WHERE page_id = ${page_id}
      LIMIT 1
    `;
    return rows[0] ?? null;
  } catch (err) {
    throw toIndexError(err, "getPage");
  }
}

export async function setRating(
  page_id: string,
  score: "good" | "bad",
): Promise<void> {
  const sql = getClient();
  try {
    await sql`
      UPDATE nocturne.pages
      SET rating = ${score}
      WHERE page_id = ${page_id}
    `;
  } catch (err) {
    throw toIndexError(err, "setRating");
  }
}

export async function listPagesForUser(user_id: string): Promise<Page[]> {
  const sql = getClient();
  try {
    const rows = await sql<Page[]>`
      SELECT page_id, user_id, storage_key, spec_id, content_type, rating, created_at
      FROM nocturne.pages
      WHERE user_id = ${user_id}
      ORDER BY created_at DESC
    `;
    return [...rows];
  } catch (err) {
    throw toIndexError(err, "listPagesForUser");
  }
}

// ---------------------------------------------------------------------------
// Sequence
// ---------------------------------------------------------------------------

/**
 * Atomic per-user monotonic "Issue #".
 *
 * One round trip. The UPSERT is the full operation — no SELECT-then-UPDATE
 * race window. Two concurrent callers for the same `user_id` will each do
 * their own `ON CONFLICT ... last_seq + 1` and get distinct numbers (thanks
 * to Postgres's per-row locking during the UPDATE).
 */
export async function nextSequence(user_id: string): Promise<number> {
  const sql = getClient();
  try {
    const rows = await sql<{ last_seq: number | string | bigint }[]>`
      INSERT INTO nocturne.page_sequence (user_id, last_seq)
      VALUES (${user_id}, 1)
      ON CONFLICT (user_id) DO UPDATE
        SET last_seq = nocturne.page_sequence.last_seq + 1
      RETURNING last_seq
    `;
    const raw = rows[0]?.last_seq;
    if (raw === undefined || raw === null) {
      throw new IndexError(
        "unavailable",
        "nextSequence: upsert returned no row",
      );
    }
    // `last_seq` is BIGINT; postgres.js may return number | string | bigint
    // depending on driver options. Normalise to number when safe.
    const n = typeof raw === "bigint" ? Number(raw) : Number(raw);
    if (!Number.isFinite(n) || n < 1) {
      throw new IndexError(
        "unavailable",
        `nextSequence: invalid last_seq ${String(raw)}`,
      );
    }
    return n;
  } catch (err) {
    throw toIndexError(err, "nextSequence");
  }
}

// ---------------------------------------------------------------------------
// Planner fallback log
// ---------------------------------------------------------------------------

export async function logPlannerFallback(
  page_id: string,
  reason: string,
  raw_llm_output: unknown,
): Promise<void> {
  const sql = getClient();
  try {
    await sql`
      INSERT INTO nocturne.planner_fallback_log (page_id, fallback_reason, raw_llm_output)
      VALUES (
        ${page_id},
        ${reason},
        ${sql.json(raw_llm_output as postgres.JSONValue)}
      )
    `;
  } catch (err) {
    throw toIndexError(err, "logPlannerFallback");
  }
}

// ---------------------------------------------------------------------------
// Share tokens
// ---------------------------------------------------------------------------

/**
 * Base62 alphabet — avoids URL-reserved characters and avoids the `=` padding
 * that base64url still emits for some lengths. Keeps share URLs clean.
 */
const BASE62_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Encode `bytes` as base62 by treating them as a big-endian unsigned integer.
 *
 * For a 16-byte input (128 bits) this yields 22 characters, carrying the full
 * 128 bits of entropy. We deliberately avoid the (chunk-and-concat) family of
 * base62 encoders — they truncate to ~21–23 chars but leak the internal
 * chunking in token length variance.
 */
function bytesToBase62(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  if (n === 0n) return "0";
  let out = "";
  const BASE = 62n;
  while (n > 0n) {
    const rem = n % BASE;
    out = BASE62_ALPHABET[Number(rem)] + out;
    n = n / BASE;
  }
  return out;
}

/**
 * SHA-256 hex digest of `token`. Used as `token_hash` in the index so the
 * database never stores the plaintext.
 */
function sha256Hex(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export async function createShareToken(
  user_id: string,
  ttl_days = 90,
): Promise<ShareTokenCreateResult> {
  const sql = getClient();
  // 128 bits of entropy — matches the issue spec ("128-bit random base62").
  const token = bytesToBase62(crypto.randomBytes(16));
  const token_hash = sha256Hex(token);
  const expires_at = new Date(Date.now() + ttl_days * 86_400_000);

  try {
    const rows = await sql<{ token_id: string }[]>`
      INSERT INTO nocturne.archive_share_tokens (
        user_id, token_hash, expires_at
      ) VALUES (
        ${user_id}, ${token_hash}, ${expires_at}
      )
      RETURNING token_id
    `;
    const token_id = rows[0]?.token_id;
    if (!token_id) {
      throw new IndexError(
        "unavailable",
        "createShareToken: insert returned no token_id",
      );
    }
    return { token, token_id, expires_at };
  } catch (err) {
    throw toIndexError(err, "createShareToken");
  }
}

export async function resolveShareToken(
  token: string,
): Promise<{ user_id: string } | null> {
  const sql = getClient();
  const token_hash = sha256Hex(token);
  try {
    const rows = await sql<{ user_id: string }[]>`
      SELECT user_id
      FROM nocturne.archive_share_tokens
      WHERE token_hash = ${token_hash}
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > NOW())
      LIMIT 1
    `;
    return rows[0] ?? null;
  } catch (err) {
    throw toIndexError(err, "resolveShareToken");
  }
}

/**
 * Revoke a share token by its id. Returns `true` when a row was actually
 * updated — i.e. the `(token_id, user_id)` pair matched AND the token wasn't
 * already revoked. Returns `false` for ownership mismatch, unknown id, or
 * idempotent re-revoke.
 */
export async function revokeShareToken(
  token_id: string,
  user_id: string,
): Promise<boolean> {
  const sql = getClient();
  try {
    const result = await sql`
      UPDATE nocturne.archive_share_tokens
      SET revoked_at = NOW()
      WHERE token_id = ${token_id}
        AND user_id = ${user_id}
        AND revoked_at IS NULL
    `;
    return result.count > 0;
  } catch (err) {
    throw toIndexError(err, "revokeShareToken");
  }
}

// ---------------------------------------------------------------------------
// Test helpers (non-public but exported for coverage)
// ---------------------------------------------------------------------------

/** Test-only: exposes the base62 encoder for determinism checks. */
export const __internals__ = { bytesToBase62, sha256Hex };
