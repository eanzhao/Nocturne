/**
 * `POST /v/{slug}/rate?score=good|bad` — unauthenticated rating submission.
 *
 * No auth, by design:
 *   - The chrome zone script fires this from any visitor's browser — forcing
 *     identity here would defeat the "opens anywhere without login" property
 *     that makes `/v/{slug}` worth existing.
 *   - The counter has essentially zero abuse value: there's no global "top
 *     rated" list, no leaderboard, no payout. A motivated botter flipping one
 *     row from good → bad buys them nothing.
 *   - `setRating` is idempotent — the last click wins, so repeated submissions
 *     don't inflate anything.
 *
 * If this ever grows a real abuse surface (aggregate stats page, badges), the
 * fix is a rate-limit + cookie-based fingerprint, not middleware auth.
 *
 * Error mapping:
 *   - Missing / malformed `score`         → 400 invalid_score
 *   - Page not in the index                → 404 page_not_found
 *   - Any other IndexError (timeout/…)     → 500 index_write_failed
 */
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";

import * as supabase from "../index/supabase.ts";

// ---------------------------------------------------------------------------
// Inputs

const ScoreEnum = z.enum(["good", "bad"]);
export type Score = z.infer<typeof ScoreEnum>;

// ---------------------------------------------------------------------------
// Router

export const rateRouter = new Hono();

/**
 * Route path: `/v/:slug/rate` — mounted at the app root so the resulting
 * absolute path matches the issue spec (`POST /v/{slug}/rate`).
 */
rateRouter.post("/v/:slug/rate", async (c) => {
  const slug = c.req.param("slug");

  // Score comes in via query string (the chrome script fires `POST
  // /v/{id}/rate?score=...`). We deliberately do NOT read it from a JSON
  // body — a query-string contract is easier to probe with curl and keeps
  // the endpoint parseable without content-type dance.
  const rawScore = c.req.query("score");
  const parsed = ScoreEnum.safeParse(rawScore);
  if (!parsed.success) {
    return c.json({ error: "invalid_score" }, 400);
  }
  const score = parsed.data;

  // The index's `setRating` runs a plain UPDATE; we need a 404 when no row
  // matched. The cheapest "did that hit a row" signal on the client is a
  // follow-up `getPage` — the extra round trip is fine on a 1 rps endpoint
  // and keeps `supabase.setRating` narrow (it returns void).
  let page: supabase.Page | null;
  try {
    page = await supabase.getPage(slug);
  } catch (err) {
    if (err instanceof supabase.IndexError) {
      return indexErrorResponse(c, err);
    }
    throw err;
  }
  if (page === null) {
    return c.json({ error: "page_not_found" }, 404);
  }

  try {
    await supabase.setRating(slug, score);
  } catch (err) {
    if (err instanceof supabase.IndexError) {
      return indexErrorResponse(c, err);
    }
    throw err;
  }

  return c.json({ ok: true }, 200);
});

/** Typed IndexError → JSON response. */
function indexErrorResponse(c: Context, err: supabase.IndexError) {
  switch (err.code) {
    case "timeout":
    case "unavailable":
    case "duplicate":
    case "constraint":
      return c.json({ error: "index_write_failed" }, 500);
  }
}
