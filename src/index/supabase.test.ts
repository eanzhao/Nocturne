/**
 * Unit tests for src/index/supabase.ts.
 *
 * Strategy: swap the module-level `Sql` client for a tagged-template fake
 * that captures the exact queries + parameter bindings our functions emit.
 * This lets us:
 *   1. Verify the SQL shape of the atomic UPSERT matches the issue spec
 *      (single round trip, `ON CONFLICT DO UPDATE ... RETURNING last_seq`).
 *   2. Simulate concurrent `nextSequence` callers and confirm our
 *      client-side contract ("one UPSERT per call; Postgres handles atomicity
 *      via per-row locking") — the fake serialises them FIFO, which is what
 *      Postgres would do for rows locked under concurrent UPDATE.
 *   3. Drive pure-logic paths: base62 encoder, sha256 hashing,
 *      `PostgresError → IndexError` mapping, share-token lifecycle.
 *
 * Running against real Postgres is out of scope for this harness; pg-mem
 * would require a new dep we aren't allowed to add in this issue.
 */
import "./test-env.ts"; // MUST be first — populates env for src/config.ts.
import { afterEach, describe, expect, test } from "bun:test";
import postgres, { type Sql } from "postgres";

// `postgres` attaches PostgresError to its default export at runtime but does
// not re-export it as a named ES binding.
const PostgresError = (postgres as unknown as {
  PostgresError: new (message: string) => Error;
}).PostgresError;
import {
  __internals__,
  __setClient__,
  createShareToken,
  getPage,
  IndexError,
  insertPage,
  listPagesForUser,
  logPlannerFallback,
  nextSequence,
  resolveShareToken,
  revokeShareToken,
  setRating,
} from "./supabase.ts";

// ---------------------------------------------------------------------------
// Fake `Sql` — a callable tagged template that captures queries
// ---------------------------------------------------------------------------

interface CapturedQuery {
  sql: string; // interpolated strings joined with $1, $2, ...
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
    // Rebuild the query as a parameterised string so assertions can regex it.
    let sql = "";
    for (let i = 0; i < strings.length; i++) {
      sql += strings[i];
      if (i < values.length) sql += `$${i + 1}`;
    }
    const capture = { sql, values };
    fake.captured.push(capture);
    const result = responder(capture);
    return Promise.resolve(result);
  }) as FakeSql;
  fn.captured = [] as CapturedQuery[];
  fn.setResponder = (r: Responder) => {
    responder = r;
  };
  fn.json = (value: unknown) => ({ __json__: value });
  const fake = fn;
  return fake;
}

function installFake(): FakeSql {
  const fake = makeFakeSql();
  __setClient__(fake as unknown as Sql);
  return fake;
}

afterEach(() => {
  __setClient__(null);
});

// ---------------------------------------------------------------------------
// nextSequence — atomic UPSERT
// ---------------------------------------------------------------------------

describe("nextSequence", () => {
  test("emits a single-round-trip INSERT ... ON CONFLICT DO UPDATE RETURNING", async () => {
    const fake = installFake();
    fake.setResponder(() => [{ last_seq: 1 }]);

    const n = await nextSequence("11111111-1111-1111-1111-111111111111");
    expect(n).toBe(1);
    expect(fake.captured.length).toBe(1);

    const { sql, values } = fake.captured[0]!;
    // Normalise whitespace so assertions are readable.
    const compact = sql.replace(/\s+/g, " ").trim();
    expect(compact).toMatch(
      /^INSERT INTO nocturne\.page_sequence \(user_id, last_seq\) VALUES \(\$1, 1\) ON CONFLICT \(user_id\) DO UPDATE SET last_seq = nocturne\.page_sequence\.last_seq \+ 1 RETURNING last_seq$/,
    );
    expect(values).toEqual(["11111111-1111-1111-1111-111111111111"]);
  });

  test("sequential calls each get the number their UPSERT returned", async () => {
    // Model the server side: counter per user_id, incremented per call.
    const fake = installFake();
    const counters = new Map<string, number>();
    fake.setResponder(({ values }) => {
      const uid = values[0] as string;
      const next = (counters.get(uid) ?? 0) + 1;
      counters.set(uid, next);
      return [{ last_seq: next }];
    });

    const uid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const a = await nextSequence(uid);
    const b = await nextSequence(uid);
    const c = await nextSequence(uid);
    expect([a, b, c]).toEqual([1, 2, 3]);
  });

  test("concurrent calls produce the full set {1..N} with no duplicates", async () => {
    // This test validates the *contract shape*: each call is exactly one
    // round trip, and under a serialising backend (like Postgres's per-row
    // UPDATE lock) the returned values form a contiguous 1..N sequence
    // with no duplicates. If `nextSequence` were to split into a
    // SELECT-then-UPDATE, two concurrent calls on the same row could
    // observe the same last_seq and emit duplicates.
    const fake = installFake();
    let queue: Promise<unknown> = Promise.resolve();
    const counters = new Map<string, number>();
    fake.setResponder(({ values }) => {
      // Serialise responder execution the same way a row lock would.
      const uid = values[0] as string;
      const task = queue.then(() => {
        const next = (counters.get(uid) ?? 0) + 1;
        counters.set(uid, next);
        return [{ last_seq: next }];
      });
      queue = task.then(() => undefined);
      return task;
    });

    const uid = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, () => nextSequence(uid)),
    );
    expect(fake.captured.length).toBe(N);
    expect(new Set(results).size).toBe(N);
    expect([...results].sort((a, b) => a - b)).toEqual(
      Array.from({ length: N }, (_, i) => i + 1),
    );
  });

  test("maps 57014 (query_canceled) → IndexError{code:'timeout'}", async () => {
    const fake = installFake();
    fake.setResponder(() => {
      const e = Object.assign(new PostgresError("canceled"), {
        code: "57014",
      });
      throw e;
    });
    await expect(nextSequence("u")).rejects.toMatchObject({
      name: "IndexError",
      code: "timeout",
    });
  });

  test("normalises bigint last_seq to number", async () => {
    const fake = installFake();
    fake.setResponder(() => [{ last_seq: 42n }]);
    const n = await nextSequence("u");
    expect(n).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// pages helpers
// ---------------------------------------------------------------------------

describe("insertPage", () => {
  test("emits a single INSERT with all 5 column values bound in order", async () => {
    const fake = installFake();
    fake.setResponder(() => []);
    await insertPage({
      page_id: "p_abc",
      user_id: "uid",
      storage_key: "uid/p_abc.html",
      spec_id: "executive-broadsheet",
      content_type: "text/html",
    });

    const { sql, values } = fake.captured[0]!;
    const compact = sql.replace(/\s+/g, " ").trim();
    expect(compact).toContain("INSERT INTO nocturne.pages");
    // The postgres.js template retains its authored whitespace; collapse-check.
    expect(compact).toMatch(
      /page_id,\s*user_id,\s*storage_key,\s*spec_id,\s*content_type/,
    );
    expect(values).toEqual([
      "p_abc",
      "uid",
      "uid/p_abc.html",
      "executive-broadsheet",
      "text/html",
    ]);
  });

  test("23505 → duplicate", async () => {
    const fake = installFake();
    fake.setResponder(() => {
      const e = Object.assign(new PostgresError("dup key"), {
        code: "23505",
      });
      throw e;
    });
    await expect(
      insertPage({
        page_id: "p",
        user_id: "u",
        storage_key: "k",
        spec_id: "s",
        content_type: "text/html",
      }),
    ).rejects.toMatchObject({ name: "IndexError", code: "duplicate" });
  });

  test("23502 not-null → constraint", async () => {
    const fake = installFake();
    fake.setResponder(() => {
      const e = Object.assign(new PostgresError("null violation"), {
        code: "23502",
      });
      throw e;
    });
    await expect(
      insertPage({
        page_id: "p",
        user_id: "u",
        storage_key: "k",
        spec_id: "s",
        content_type: "text/html",
      }),
    ).rejects.toMatchObject({ name: "IndexError", code: "constraint" });
  });
});

describe("getPage", () => {
  test("SELECTs by page_id and returns the single row, or null", async () => {
    const fake = installFake();
    const row = {
      page_id: "p1",
      user_id: "u1",
      storage_key: "u1/p1.html",
      spec_id: "quiet-ledger",
      content_type: "text/html",
      rating: null,
      created_at: new Date("2026-04-18T00:00:00Z"),
    };
    fake.setResponder(() => [row]);
    const got = await getPage("p1");
    expect(got).toEqual(row);
    expect(fake.captured[0]!.sql).toMatch(
      /SELECT[\s\S]+FROM nocturne\.pages[\s\S]+WHERE page_id = \$1/,
    );

    fake.setResponder(() => []);
    const miss = await getPage("nope");
    expect(miss).toBeNull();
  });
});

describe("setRating", () => {
  test("UPDATEs rating with a parameterised score", async () => {
    const fake = installFake();
    fake.setResponder(() => ({ count: 1 }));
    await setRating("pid", "good");
    const { sql, values } = fake.captured[0]!;
    expect(sql).toMatch(/UPDATE nocturne\.pages[\s\S]+SET rating = \$1/);
    expect(values).toEqual(["good", "pid"]);
  });
});

describe("listPagesForUser", () => {
  test("SELECTs by user_id ordered by created_at DESC", async () => {
    const fake = installFake();
    fake.setResponder(() => []);
    await listPagesForUser("uid");
    const { sql, values } = fake.captured[0]!;
    const compact = sql.replace(/\s+/g, " ").trim();
    expect(compact).toMatch(/WHERE user_id = \$1/);
    expect(compact).toMatch(/ORDER BY created_at DESC/);
    expect(values).toEqual(["uid"]);
  });
});

// ---------------------------------------------------------------------------
// planner fallback
// ---------------------------------------------------------------------------

describe("logPlannerFallback", () => {
  test("INSERTs page_id + reason + JSON payload", async () => {
    const fake = installFake();
    fake.setResponder(() => []);
    const payload = { foo: [1, 2, 3], bar: "x" };
    await logPlannerFallback("p1", "spec_id_out_of_enum", payload);
    const { sql, values } = fake.captured[0]!;
    const compact = sql.replace(/\s+/g, " ").trim();
    expect(compact).toContain("INSERT INTO nocturne.planner_fallback_log");
    expect(values[0]).toBe("p1");
    expect(values[1]).toBe("spec_id_out_of_enum");
    // Third bound value was wrapped through our fake `sql.json(...)`.
    expect(values[2]).toEqual({ __json__: payload });
  });
});

// ---------------------------------------------------------------------------
// share tokens
// ---------------------------------------------------------------------------

describe("createShareToken", () => {
  test("returns {token, token_id, expires_at}; stores only the hash", async () => {
    const fake = installFake();
    fake.setResponder(() => [{ token_id: "tid-1" }]);
    const before = Date.now();
    const out = await createShareToken("uid", 90);
    const after = Date.now();

    expect(typeof out.token).toBe("string");
    // 128 bits ≈ up to 22 base62 chars (log_62(2^128) ≈ 21.49). The bigint
    // encoder emits leading-zero trimmed output, so length varies 20–22.
    expect(out.token.length).toBeGreaterThanOrEqual(20);
    expect(out.token.length).toBeLessThanOrEqual(22);
    expect(/^[0-9A-Za-z]+$/.test(out.token)).toBe(true);

    expect(out.token_id).toBe("tid-1");
    const ttlMs = 90 * 86_400_000;
    expect(out.expires_at.getTime()).toBeGreaterThanOrEqual(before + ttlMs - 5);
    expect(out.expires_at.getTime()).toBeLessThanOrEqual(after + ttlMs + 5);

    const { sql, values } = fake.captured[0]!;
    const compact = sql.replace(/\s+/g, " ").trim();
    expect(compact).toContain(
      "INSERT INTO nocturne.archive_share_tokens",
    );
    expect(compact).toContain("RETURNING token_id");
    // Plaintext token is NEVER one of the bound values.
    expect(values).not.toContain(out.token);
    // The hash IS bound (SHA-256 → 64 hex chars).
    expect((values[1] as string).length).toBe(64);
    expect(/^[0-9a-f]+$/.test(values[1] as string)).toBe(true);
    // user_id and expires_at are the other two bindings.
    expect(values[0]).toBe("uid");
    expect(values[2]).toBeInstanceOf(Date);
  });

  test("each call returns a different plaintext token (entropy sanity)", async () => {
    const fake = installFake();
    let i = 0;
    fake.setResponder(() => [{ token_id: `tid-${++i}` }]);
    const a = await createShareToken("u");
    const b = await createShareToken("u");
    expect(a.token).not.toBe(b.token);
  });
});

describe("resolveShareToken", () => {
  test("hashes the input and SELECTs by token_hash with the freshness filter", async () => {
    const fake = installFake();
    fake.setResponder(() => [{ user_id: "u42" }]);
    const out = await resolveShareToken("plaintext-token");
    expect(out).toEqual({ user_id: "u42" });

    const { sql, values } = fake.captured[0]!;
    const compact = sql.replace(/\s+/g, " ").trim();
    expect(compact).toContain("FROM nocturne.archive_share_tokens");
    expect(compact).toContain("WHERE token_hash = $1");
    expect(compact).toContain("revoked_at IS NULL");
    expect(compact).toContain("expires_at IS NULL OR expires_at > NOW()");

    // The bound value is the sha256 of the plaintext — never the plaintext.
    expect(values[0]).toBe(__internals__.sha256Hex("plaintext-token"));
    expect(values[0]).not.toBe("plaintext-token");
  });

  test("returns null when the row isn't found (expired / revoked / unknown)", async () => {
    const fake = installFake();
    fake.setResponder(() => []);
    expect(await resolveShareToken("whatever")).toBeNull();
  });
});

describe("revokeShareToken", () => {
  test("UPDATE matches on (token_id, user_id) AND revoked_at IS NULL; returns true when a row changed", async () => {
    const fake = installFake();
    fake.setResponder(() => ({ count: 1 }));
    const ok = await revokeShareToken("tid-1", "uid-1");
    expect(ok).toBe(true);

    const { sql, values } = fake.captured[0]!;
    const compact = sql.replace(/\s+/g, " ").trim();
    expect(compact).toContain("UPDATE nocturne.archive_share_tokens");
    expect(compact).toContain("SET revoked_at = NOW()");
    expect(compact).toContain("token_id = $1");
    expect(compact).toContain("user_id = $2");
    expect(compact).toContain("revoked_at IS NULL");
    expect(values).toEqual(["tid-1", "uid-1"]);
  });

  test("returns false when owner mismatch / already revoked / unknown id", async () => {
    const fake = installFake();
    fake.setResponder(() => ({ count: 0 }));
    expect(await revokeShareToken("tid-x", "uid-y")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// toIndexError coverage (via insertPage for convenience)
// ---------------------------------------------------------------------------

describe("error mapping — toIndexError via insertPage", () => {
  test("08xxx connection_exception → unavailable", async () => {
    const fake = installFake();
    fake.setResponder(() => {
      const e = Object.assign(new PostgresError("connection lost"), {
        code: "08006",
      });
      throw e;
    });
    let caught: unknown;
    try {
      await insertPage({
        page_id: "p",
        user_id: "u",
        storage_key: "k",
        spec_id: "s",
        content_type: "text/html",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IndexError);
    expect((caught as IndexError).code).toBe("unavailable");
    expect((caught as IndexError).pgCode).toBe("08006");
  });

  test("plain ECONNREFUSED Error → unavailable", async () => {
    const fake = installFake();
    fake.setResponder(() => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
    });
    await expect(
      insertPage({
        page_id: "p",
        user_id: "u",
        storage_key: "k",
        spec_id: "s",
        content_type: "text/html",
      }),
    ).rejects.toMatchObject({ name: "IndexError", code: "unavailable" });
  });

  test("23503 fkey → constraint", async () => {
    const fake = installFake();
    fake.setResponder(() => {
      const e = Object.assign(new PostgresError("fkey violation"), {
        code: "23503",
      });
      throw e;
    });
    await expect(
      insertPage({
        page_id: "p",
        user_id: "u",
        storage_key: "k",
        spec_id: "s",
        content_type: "text/html",
      }),
    ).rejects.toMatchObject({ name: "IndexError", code: "constraint" });
  });
});

// ---------------------------------------------------------------------------
// Pure logic — base62 encoder
// ---------------------------------------------------------------------------

describe("__internals__.bytesToBase62", () => {
  test("0x00 → '0'", () => {
    expect(__internals__.bytesToBase62(new Uint8Array([0]))).toBe("0");
  });

  test("0x01 → '1'", () => {
    expect(__internals__.bytesToBase62(new Uint8Array([1]))).toBe("1");
  });

  test("0x23 → 'Z' (alphabet[35], end of A-Z block)", () => {
    // Alphabet is 0-9 (0..9), A-Z (10..35), a-z (36..61). So 35 = 'Z'.
    expect(__internals__.bytesToBase62(new Uint8Array([0x23]))).toBe("Z");
  });

  test("0x3d → 'z' (alphabet[61], last char)", () => {
    expect(__internals__.bytesToBase62(new Uint8Array([0x3d]))).toBe("z");
  });

  test("0x3e → '10' (rollover into a 2-char result)", () => {
    expect(__internals__.bytesToBase62(new Uint8Array([0x3e]))).toBe("10");
  });

  test("round-trips big-endian integer interpretation", () => {
    // 0x0100 = 256. 256 / 62 = 4 rem 8 → '48'
    expect(__internals__.bytesToBase62(new Uint8Array([0x01, 0x00]))).toBe(
      "48",
    );
  });

  test("16 bytes (128 bits) of 0xff encodes to 22 base62 chars", () => {
    const bytes = new Uint8Array(16).fill(0xff);
    const encoded = __internals__.bytesToBase62(bytes);
    expect(encoded.length).toBe(22);
    expect(/^[0-9A-Za-z]+$/.test(encoded)).toBe(true);
  });
});

describe("__internals__.sha256Hex", () => {
  test("matches the known SHA-256 of 'abc'", () => {
    expect(__internals__.sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
