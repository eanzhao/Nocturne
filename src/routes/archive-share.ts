/**
 * Share-token lifecycle endpoints — all behind `nyxidAuth`.
 *
 *   POST   /u/share             → mint a new share token (plaintext returned ONCE)
 *   GET    /u/share             → list the caller's tokens (never includes plaintext)
 *   DELETE /u/share/:token_id   → revoke a token the caller owns
 *
 * The plaintext token is the only secret the caller ever needs to carry; we
 * persist only its SHA-256 hash in `nocturne.archive_share_tokens`. That means
 * we cannot reissue the plaintext on any subsequent read — users who lose a
 * token must revoke and mint a new one. This is the intended trade: a
 * database breach leaks nothing replayable.
 */

import { Hono, type Context } from "hono";
import { z } from "zod";
import { config } from "../config.ts";
import * as supabase from "../index/supabase.ts";
import { nyxidAuth } from "../middleware/auth.ts";
import { deriveUserSlug } from "../utils/user-slug.ts";

/**
 * TTL policy: default 90 days, clamp to [1, 365].
 *
 * - 1 day minimum: shorter than this is almost certainly a client typo
 *   ("I meant 10, not 0.1"); rejecting would be user-hostile but accepting
 *   a 0-or-negative value would create an immediately-dead token.
 * - 365 day maximum: a share token that outlives a year is an archive-style
 *   grant the caller almost never actually wants; forcing re-issue once a
 *   year is a cheap defense against "this token leaked into a training set"
 *   long-tail failure modes.
 * - Default 90: matches the issue spec; long enough to ship quarterly, short
 *   enough that forgotten tokens cycle out.
 */
const MIN_TTL_DAYS = 1;
const MAX_TTL_DAYS = 365;
const DEFAULT_TTL_DAYS = 90;

const CreateBody = z
  .object({
    ttl_days: z
      .number()
      .int()
      .optional(),
  })
  .strict()
  // Accept an empty body — defaulting to 90 days is the common path.
  .default({});

/**
 * Clamp a caller-supplied TTL into [MIN, MAX]. Returning a clamped value
 * (rather than 400-ing on out-of-range) is a deliberate trade: the spec asks
 * for clamping, and a share-token mint is the kind of endpoint where "you
 * asked for 400 days, you got 365" is more helpful than a hard error.
 */
function clampTtl(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_TTL_DAYS;
  if (!Number.isFinite(raw)) return DEFAULT_TTL_DAYS;
  const n = Math.trunc(raw);
  if (n < MIN_TTL_DAYS) return MIN_TTL_DAYS;
  if (n > MAX_TTL_DAYS) return MAX_TTL_DAYS;
  return n;
}

/**
 * Build the share-token sub-router. Exported as a factory so `src/app.ts`
 * can wire it after merge without this module touching the top-level app.
 */
export function archiveShareRoutes(): Hono {
  const app = new Hono();

  app.use("/u/share", nyxidAuth);
  app.use("/u/share/*", nyxidAuth);

  app.post("/u/share", async (c) => {
    const userId = requireUserId(c);

    // Parse body permissively: accept missing body, accept `{}`, accept
    // `{ttl_days: N}`. Anything else with extra fields is a client bug and
    // worth a 400 — strict() catches it.
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      raw = {};
    }
    const parsed = CreateBody.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_body" }, 400);
    }

    const ttlDays = clampTtl(parsed.data.ttl_days);
    const { token, token_id, expires_at } = await supabase.createShareToken(
      userId,
      ttlDays,
    );

    const ownerSlug = await deriveUserSlug(
      userId,
      config.NYXID_SERVICE_SECRET,
    );
    const base = config.BASE_URL.replace(/\/+$/, "");
    const url = `${base}/u/${ownerSlug}?token=${encodeURIComponent(token)}`;

    // 201 Created — the plaintext `token` field is the ONLY time we'll ever
    // return it. Clients must capture it at this moment or reissue.
    return c.json(
      {
        token,
        token_id,
        url,
        expires_at: expires_at.toISOString(),
      },
      201,
    );
  });

  app.get("/u/share", async (c) => {
    const userId = requireUserId(c);
    const rows = await supabase.listShareTokens(userId);
    return c.json(
      rows.map((r) => ({
        token_id: r.token_id,
        created_at: r.created_at.toISOString(),
        expires_at: r.expires_at ? r.expires_at.toISOString() : null,
        revoked_at: r.revoked_at ? r.revoked_at.toISOString() : null,
      })),
    );
  });

  app.delete("/u/share/:token_id", async (c) => {
    const userId = requireUserId(c);
    const tokenId = c.req.param("token_id");

    // We don't validate UUID shape here — `revokeShareToken` does a
    // (token_id, user_id) match against the index and returns `false` for
    // any miss. A malformed id simply can't match a real row, so the 404
    // path handles it uniformly.
    const ok = await supabase.revokeShareToken(tokenId, userId);
    if (!ok) {
      // "Not owner" and "token doesn't exist" collapse into one response
      // so a caller cannot probe for other users' token_ids.
      return c.json({ error: "not_found" }, 404);
    }
    return c.json({ ok: true });
  });

  return app;
}

/**
 * `nyxidAuth` guarantees `user_id` is set — but the context type is
 * `string | null`, so we narrow here once rather than sprinkling `!` through
 * every handler.
 */
function requireUserId(c: Context): string {
  const userId = c.get("user_id");
  if (!userId) {
    // Should be unreachable: nyxidAuth would have rejected already. Throwing
    // here is a defense-in-depth assertion — if it ever trips, we want to
    // see it in logs, not silently serve an empty archive.
    throw new Error("archive-share: user_id missing after nyxidAuth");
  }
  return userId;
}
