/**
 * `GET /u/{slug}` — the owner archive page with tiered privacy.
 *
 * Access model (in priority order):
 *
 *   1. `?token=<share_token>` — `resolveShareToken` finds the owning user.
 *      The token itself tells us *who* the page belongs to; we then check
 *      that the derived slug matches the path. A token for user A pasted
 *      onto user B's URL returns 404, not 401 — the token is valid, just
 *      not for that page.
 *   2. Otherwise, `optionalNyxidAuth` runs. If the caller is the owner
 *      (derived slug == path slug), they see their own list. If they are
 *      authenticated but looking at someone else's slug, we 404 — same
 *      response as "page doesn't exist" to avoid confirming the slug exists.
 *   3. No token, no auth → 401 `auth_required`.
 *
 * Response body is intentionally **unstyled** plain HTML. The DESIGN.md
 * contract is that `/u/{slug}` is a lookup-and-navigate skeleton, not a
 * showcase. Any CSS risks collapsing three coexisting aesthetics back into
 * one house style. Polish lands in v1.5 as a separate effort.
 */

import { Hono, type Context } from "hono";
import { z } from "zod";
import { config } from "../config.ts";
import * as supabase from "../index/supabase.ts";
import { optionalNyxidAuth } from "../middleware/auth.ts";
import { deriveUserSlug } from "../utils/user-slug.ts";
import { mapIndexError } from "./_errors.ts";

/**
 * Minimal HTML escaper for the unstyled archive table.
 *
 * We do not pull in Hono JSX here: the archive page is the one surface where
 * we explicitly want zero framework chrome so it can be trivially diffed in
 * tests. All interpolated values are user-supplied (titles, spec ids) or
 * trusted (date formatting, slug), but we escape everything uniformly — a
 * missed bypass on "trusted" input is still a bypass.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Format a Postgres `timestamptz` (or a JS Date) as ISO calendar date, UTC.
 *
 * We intentionally do NOT localize: the archive is a deterministic listing,
 * and downstream tools (screen readers, paste into a spreadsheet) are better
 * served by `YYYY-MM-DD`. If the caller wants their local TZ they can look at
 * the actual page.
 */
function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface ArchiveRow {
  created_at: Date;
  page_id: string;
  spec_id: string;
  content_type: string;
}

/**
 * Render the archive HTML. Kept as a pure function of its inputs so tests can
 * assert shape without standing up a whole Hono request cycle.
 *
 * The "Title" column carries the `page_id` rather than an editorial title:
 * v0 `nocturne.pages` does not store a title column — titles live inside the
 * content blob (see `DailyBriefBlock.title`). Issue #7 is responsible for
 * propagating a title into the index when the writer side lands. Until then
 * the archive renders enough to find a page (date + id + spec + link).
 */
export function renderArchiveHtml(
  rows: ArchiveRow[],
  opts: { count: number },
): string {
  const rowHtml = rows
    .map((r) => {
      const date = escapeHtml(formatDate(r.created_at));
      const pageId = escapeHtml(r.page_id);
      const spec = escapeHtml(r.spec_id);
      const href = escapeHtml(`/v/${r.page_id}`);
      return `<tr><td>${date}</td><td>${pageId}</td><td>${spec}</td><td><a href="${href}">view</a></td></tr>`;
    })
    .join("");

  // No <style>, no <link>, no inline CSS — the system font is the point.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>All your Nocturnes</title>
</head>
<body>
<h1>All your Nocturnes</h1>
<p>${opts.count} Nocturne${opts.count === 1 ? "" : "s"}.</p>
<table>
<thead><tr><th>Date</th><th>Title</th><th>Spec</th><th></th></tr></thead>
<tbody>${rowHtml}</tbody>
</table>
</body>
</html>
`;
}

const TokenQuery = z.object({
  token: z.string().min(1).optional(),
});

/** Slugs are always 16 lowercase hex chars (see `deriveUserSlug`). */
const SLUG_RE = /^[0-9a-f]{16}$/;

/**
 * Build the archive sub-router. Exported as a factory so `src/app.ts` can
 * wire it after merge without this module touching the top-level app.
 *
 * We register two overlapping route handlers on `GET /u/:slug`:
 *
 *   - The first inspects `?token=...`. If present it resolves the token and
 *     bypasses auth entirely. If absent it calls `next()` to fall through.
 *   - The second wraps `optionalNyxidAuth` and handles the owner-auth path.
 *
 * This split is load-bearing: if `nyxidAuth` ran unconditionally, a caller
 * with a valid share token but no NyxID headers would hit 401
 * `missing_identity` before we ever got to check the token. `optionalNyxidAuth`
 * on the second handler gives us the "authenticated but wrong user" → 404
 * response without running JWKS verification for the token-only branch.
 */
export function archiveRoutes(): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    const mapped = mapIndexError(err, c);
    if (mapped) return mapped;
    throw err;
  });

  // Token-bearing branch. If no token is present we `next()` to the auth
  // handler below.
  app.get("/u/:slug", async (c, next) => {
    const slug = c.req.param("slug");
    const parsed = TokenQuery.safeParse({
      token: c.req.query("token"),
    });
    if (!parsed.success) {
      return c.json({ error: "invalid_query" }, 400);
    }

    const token = parsed.data.token;
    if (token === undefined) {
      return next();
    }

    if (!SLUG_RE.test(slug)) {
      return c.json({ error: "not_found" }, 404);
    }

    const resolved = await supabase.resolveShareToken(token);
    if (!resolved) {
      // Unknown, revoked, or expired — collapse into one response so an
      // attacker can't tell which.
      return c.json({ error: "invalid_share_token" }, 401);
    }
    const ownerSlug = await deriveUserSlug(
      resolved.user_id,
      config.NYXID_SERVICE_SECRET,
    );
    if (ownerSlug !== slug) {
      // Valid token, wrong URL — the token holder shouldn't be able to
      // probe for which slugs exist, so we 404 rather than 403.
      return c.json({ error: "not_found" }, 404);
    }
    return renderFor(c, resolved.user_id);
  });

  // Auth branch. Runs `optionalNyxidAuth` so we can distinguish "no
  // credentials at all" (401 auth_required) from "credentials but wrong
  // user" (404). Using `nyxidAuth` directly would collapse both into a
  // generic 401 and leak nothing useful to the caller.
  app.get("/u/:slug", optionalNyxidAuth, async (c) => {
    const slug = c.req.param("slug");
    if (!SLUG_RE.test(slug)) {
      // An authenticated user looking at a malformed slug still sees 404 —
      // the slug shape is public knowledge, no information leak.
      return c.json({ error: "not_found" }, 404);
    }

    const userId = c.get("user_id");
    if (!userId) {
      return c.json({ error: "auth_required" }, 401);
    }
    const ownSlug = await deriveUserSlug(
      userId,
      config.NYXID_SERVICE_SECRET,
    );
    if (ownSlug !== slug) {
      return c.json({ error: "not_found" }, 404);
    }
    return renderFor(c, userId);
  });

  return app;
}

async function renderFor(c: Context, userId: string): Promise<Response> {
  const pages = await supabase.listPagesForUser(userId);
  const body = renderArchiveHtml(pages, { count: pages.length });
  return c.html(body);
}
