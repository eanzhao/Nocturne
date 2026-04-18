/**
 * Page id ("slug") generation for `/v/{page_id}` URLs.
 *
 * Why base62:
 *   - URL-safe without encoding.
 *   - No `-` / `_` visual ambiguity that base64url still has on some fonts.
 *   - Keeps the slug a single opaque token — no hint at internal encoding.
 *
 * Default: 15 bytes ≈ 120 bits → ~20 characters.
 *
 *   15 bytes * log2(256) / log2(62)  ≈  20.16 characters
 *
 * That's comfortably past the 72-bit "never collide in practice" threshold and
 * short enough to paste into a tweet without pain. The byte count is kept in
 * `config.PAGE_ID_BYTES` so it can be bumped without a code change.
 *
 * `crypto.getRandomValues` is the Web Crypto CSPRNG — present in Bun globally,
 * cryptographically secure, and faster than pulling in `node:crypto` for what
 * is effectively a 15-byte fill.
 */
import { config } from "../config.ts";

/**
 * Base62 alphabet. The order matches the well-known GMP/bitcoin/base62
 * convention (0-9, A-Z, a-z). We intentionally do NOT shuffle the alphabet —
 * shuffling adds zero security (the entropy lives in the input bytes, not the
 * output mapping) and makes the result harder for humans to type.
 */
const BASE62_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Encode `bytes` as base62 by treating them as a single big-endian unsigned
 * integer. For a 15-byte input (120 bits) this yields ~20 characters with no
 * variance in the high-order bit count leaking; the chunk-and-concat style of
 * base62 encoders is deliberately avoided for the same reason as in
 * `src/index/supabase.ts` (see its `bytesToBase62` docs).
 *
 * An all-zero input (which should essentially never happen with a CSPRNG)
 * returns `"0"`; that's still a valid URL slug, even if an oddly short one.
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
 * Return a new page_id. Fresh random bytes every call; callers must never
 * cache the result.
 *
 * @param bytes Entropy in bytes. Defaults to `config.PAGE_ID_BYTES` (15).
 */
export function generatePageId(bytes: number = config.PAGE_ID_BYTES): string {
  if (!Number.isInteger(bytes) || bytes < 1) {
    throw new RangeError(
      `generatePageId: bytes must be a positive integer, got ${String(bytes)}`,
    );
  }
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return bytesToBase62(buf);
}

/** Test-only: exposed so the unit tests can drive the encoder deterministically. */
export const __internals__ = { bytesToBase62 };
