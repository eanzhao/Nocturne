/**
 * Tests for `deriveUserSlug`.
 *
 * We validate three things:
 *   1. Deterministic — same `(userId, secret)` always produces the same slug.
 *   2. Keyed — different secrets produce unrelated slugs for the same userId.
 *   3. Shape — 16 lowercase hex chars, no padding or reserved characters.
 *
 * The known-answer vector is recomputed here with `node:crypto` HMAC so we
 * catch any drift if the WebCrypto implementation changes behaviour under us.
 */

import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { deriveUserSlug } from "./user-slug.ts";

const SECRET_A = "secret-secret-secret-secret-secret";
const SECRET_B = "different-different-different-different";
const USER = "11111111-2222-3333-4444-555555555555";

function nodeHmacPrefix(userId: string, secret: string, len = 16): string {
  return crypto
    .createHmac("sha256", secret)
    .update(userId, "utf8")
    .digest("hex")
    .slice(0, len);
}

describe("deriveUserSlug", () => {
  test("produces 16 lowercase hex chars", async () => {
    const s = await deriveUserSlug(USER, SECRET_A);
    expect(s).toMatch(/^[0-9a-f]{16}$/);
    expect(s).toHaveLength(16);
  });

  test("matches the node:crypto HMAC-SHA256 truncation", async () => {
    const expected = nodeHmacPrefix(USER, SECRET_A);
    const actual = await deriveUserSlug(USER, SECRET_A);
    expect(actual).toBe(expected);
  });

  test("is deterministic for (userId, secret)", async () => {
    const a = await deriveUserSlug(USER, SECRET_A);
    const b = await deriveUserSlug(USER, SECRET_A);
    expect(a).toBe(b);
  });

  test("is different for different secrets", async () => {
    const a = await deriveUserSlug(USER, SECRET_A);
    const b = await deriveUserSlug(USER, SECRET_B);
    expect(a).not.toBe(b);
  });

  test("is different for different user ids under same secret", async () => {
    const a = await deriveUserSlug(USER, SECRET_A);
    const b = await deriveUserSlug(
      "99999999-2222-3333-4444-555555555555",
      SECRET_A,
    );
    expect(a).not.toBe(b);
  });

  test("rejects empty inputs", async () => {
    await expect(deriveUserSlug("", SECRET_A)).rejects.toThrow();
    await expect(deriveUserSlug(USER, "")).rejects.toThrow();
  });
});
