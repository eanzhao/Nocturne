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
 * short enough to paste into a tweet without pain. The default byte count is
 * kept inline here so this utility stays usable outside the server runtime.
 *
 * `crypto.getRandomValues` is the Web Crypto CSPRNG — present in Bun globally,
 * cryptographically secure, and faster than pulling in `node:crypto` for what
 * is effectively a 15-byte fill.
 */

// Default entropy: 15 bytes ≈ 120 bits. Kept inline so this module does not
// couple to server-side config; callers that want a different size pass it
// as an argument.
import { bytesToBase62 } from "./base62.ts";

const DEFAULT_PAGE_ID_BYTES = 15;

/**
 * Return a new page_id. Fresh random bytes every call; callers must never
 * cache the result.
 *
 * @param bytes Entropy in bytes. Defaults to `DEFAULT_PAGE_ID_BYTES` (15).
 */
export function generatePageId(
  bytes: number = DEFAULT_PAGE_ID_BYTES,
): string {
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
