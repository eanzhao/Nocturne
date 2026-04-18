/**
 * Unit tests for `src/utils/slug.ts`.
 *
 * `src/config.ts` reads env at module-load time, so we set env vars BEFORE
 * we dynamic-import the slug module.
 */
process.env.BASE_URL ??= "http://localhost:7701";
process.env.DATABASE_URL ??= "postgres://localhost/test";
process.env.CHRONO_STORAGE_URL ??= "http://127.0.0.1:3805";
process.env.NYXID_BASE_URL ??= "http://127.0.0.1:9000";
process.env.NYXID_JWKS_URL ??= "http://127.0.0.1:9000/.well-known/jwks.json";
process.env.NYXID_JWT_ISSUER ??= "http://127.0.0.1:9000";
process.env.NYXID_JWT_AUDIENCE ??= "nocturne";
process.env.NYXID_SERVICE_SECRET ??=
  "test-secret-test-secret-test-secret-xxxxxxxxxx";

import { beforeAll, describe, expect, test } from "bun:test";

type SlugModule = typeof import("./slug.ts");
let slug!: SlugModule;

beforeAll(async () => {
  slug = await import("./slug.ts");
});

const BASE62_ALPHA = /^[0-9A-Za-z]+$/;

describe("generatePageId", () => {
  test("default length is ~20 chars (15 bytes, base62)", () => {
    // 15 random bytes → ceil(15 * 8 / log2(62)) = 20 chars on average.
    // Allow a modest window because the high-order byte may be 0.
    for (let i = 0; i < 50; i++) {
      const id = slug.generatePageId();
      expect(id.length).toBeGreaterThanOrEqual(18);
      expect(id.length).toBeLessThanOrEqual(21);
      expect(BASE62_ALPHA.test(id)).toBe(true);
    }
  });

  test("is unique across 1000 calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(slug.generatePageId());
    expect(seen.size).toBe(1000);
  });

  test("honors explicit byte count", () => {
    const id = slug.generatePageId(8); // 8 bytes → ~11 chars
    expect(id.length).toBeGreaterThanOrEqual(9);
    expect(id.length).toBeLessThanOrEqual(12);
    expect(BASE62_ALPHA.test(id)).toBe(true);
  });

  test("rejects non-positive byte counts", () => {
    expect(() => slug.generatePageId(0)).toThrow(RangeError);
    expect(() => slug.generatePageId(-1)).toThrow(RangeError);
    expect(() => slug.generatePageId(1.5)).toThrow(RangeError);
  });
});

describe("bytesToBase62 (internal)", () => {
  test("zero bytes map to '0'", () => {
    expect(slug.__internals__.bytesToBase62(new Uint8Array([0, 0, 0]))).toBe(
      "0",
    );
  });

  test("single-byte encodings match the alphabet", () => {
    expect(slug.__internals__.bytesToBase62(new Uint8Array([0, 1]))).toBe("1");
    expect(slug.__internals__.bytesToBase62(new Uint8Array([0, 10]))).toBe(
      "A",
    );
    expect(slug.__internals__.bytesToBase62(new Uint8Array([0, 35]))).toBe(
      "Z",
    );
    expect(slug.__internals__.bytesToBase62(new Uint8Array([0, 36]))).toBe(
      "a",
    );
    expect(slug.__internals__.bytesToBase62(new Uint8Array([0, 61]))).toBe(
      "z",
    );
    expect(slug.__internals__.bytesToBase62(new Uint8Array([0, 62]))).toBe(
      "10",
    );
  });

  test("is deterministic for the same input", () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    expect(slug.__internals__.bytesToBase62(bytes)).toBe(
      slug.__internals__.bytesToBase62(bytes),
    );
  });
});
