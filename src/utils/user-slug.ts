/**
 * Derive the public archive slug for a NyxID user.
 *
 * The archive page lives at `/u/{slug}`. We deliberately do NOT expose the
 * NyxID UUID in the URL: it is a stable identifier across NyxID-integrated
 * services, and leaking it in casually-shared links would let a third party
 * cross-reference a user's activity across the whole ecosystem.
 *
 * Instead we derive a per-service slug via `HMAC-SHA256(userId, secret)` and
 * truncate to 16 hex characters. Properties:
 *
 *   - **Deterministic**: the same user always resolves to the same slug — the
 *     owner can bookmark their archive URL.
 *   - **Unguessable without the secret**: 16 hex chars = 64 bits of keyed
 *     entropy, which combined with the "valid share token OR valid auth"
 *     access rule makes brute-forcing pointless (and the 64-bit space itself
 *     is well beyond any practical guessing budget against a public endpoint).
 *   - **Scoped to Nocturne**: the `NYXID_SERVICE_SECRET` is per-service, so
 *     the same NyxID user gets unrelated slugs on other downstream services.
 *
 * Uses Bun's native WebCrypto (`crypto.subtle`) rather than `node:crypto`
 * because the rest of this service is moving toward the platform API — and
 * WebCrypto's async shape composes cleanly with our route handlers. 16 hex
 * chars is a conscious truncation: we accept the reduced collision space
 * (2^64 rather than 2^256) in exchange for a slug short enough to double-click
 * and paste without line-wrap. Collisions within a single deployment are
 * astronomically unlikely at expected user counts, and even if one occurred
 * the path-match is still gated behind auth-or-token.
 */

const SLUG_HEX_LEN = 16;

const HEX_CHARS = "0123456789abcdef";

/** Convert a raw byte buffer to lowercase hex. */
function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    out += HEX_CHARS[b >>> 4];
    out += HEX_CHARS[b & 0x0f];
  }
  return out;
}

/**
 * HMAC-SHA256(userId, secret) truncated to 16 hex chars.
 *
 * Both inputs are UTF-8 encoded. The function is async because WebCrypto's
 * `importKey`/`sign` are Promise-returning; callers at request time must
 * `await` it. Cost is a single HMAC — effectively free at request scale.
 */
export async function deriveUserSlug(
  userId: string,
  secret: string,
): Promise<string> {
  if (!userId) {
    throw new Error("deriveUserSlug: userId is required");
  }
  if (!secret) {
    throw new Error("deriveUserSlug: secret is required");
  }

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(userId));
  return bytesToHex(new Uint8Array(sig)).slice(0, SLUG_HEX_LEN);
}
