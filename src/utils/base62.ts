/**
 * Base62 encoder — shared between `src/utils/slug.ts` (page_id) and
 * `src/index/supabase.ts` (share tokens). Kept here so alphabet and edge
 * cases can't drift between the two.
 *
 * We encode the input bytes as ONE big-endian unsigned integer rather than
 * using chunk-and-concat — chunking leaks the internal chunking boundary in
 * output-length variance, which is a minor but avoidable token-fingerprint.
 */

/**
 * Base62 alphabet. The order matches the well-known GMP/bitcoin/base62
 * convention (0-9, A-Z, a-z). We intentionally do NOT shuffle it —
 * shuffling adds zero security (the entropy lives in the input bytes, not
 * the output mapping) and makes the result harder for humans to type.
 */
const BASE62_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Encode `bytes` as base62 by treating them as a single big-endian unsigned
 * integer. An all-zero input (essentially impossible from a CSPRNG) returns
 * `"0"` — still a valid URL slug, just oddly short.
 */
export function bytesToBase62(bytes: Uint8Array): string {
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
