/**
 * `GET /v/{slug}` — public page view.
 *
 * Flow:
 *   1. Look up the slug in the Supabase index → {user_id, storage_key, …}.
 *      If the index has no such row, 404 (`page_not_found`).
 *   2. `chrono.getObject('nocturne', storage_key)` → HTML bytes.
 *      - Storage 404 after index hit = split-brain between the two stores.
 *        That's an integrity violation, so we surface 500
 *        (`storage_integrity_error`). Letting it fall through as a user-facing
 *        404 would silently hide a real data problem.
 *   3. Return the HTML with an aggressive cache header.
 *      `public, max-age=31536000, immutable` — pages are permanent artifacts
 *      (see DESIGN.md §"What IS shared across specs"). Any CDN in front of
 *      Nocturne is welcome to cache forever.
 *
 * No auth. The slug itself IS the capability — 120 bits of base62 entropy is
 * unguessable, and the user who POSTed /format chose to share the resulting
 * URL when they pasted it anywhere.
 */
import { Hono } from "hono";

import { config } from "../config.ts";
import * as chrono from "../storage/chrono.ts";
import * as supabase from "../index/supabase.ts";

export const viewRouter = new Hono();

viewRouter.get("/v/:slug", async (c) => {
  const slug = c.req.param("slug");

  // --- Hop 1: Supabase index lookup ------------------------------------------
  let page: supabase.Page | null;
  try {
    page = await supabase.getPage(slug);
  } catch (err) {
    if (err instanceof supabase.IndexError) {
      // Index lookup failures on the public read path are always a 5xx — the
      // slug might be valid, we just couldn't check.
      return c.json({ error: "index_unavailable" }, 503);
    }
    throw err;
  }
  if (page === null) {
    return c.json({ error: "page_not_found" }, 404);
  }

  // --- Hop 2: chrono-storage body fetch --------------------------------------
  let html: { body: ArrayBuffer; contentType: string };
  try {
    html = await chrono.getObject(
      config.CHRONO_STORAGE_BUCKET,
      page.storage_key,
    );
  } catch (err) {
    if (err instanceof chrono.StorageError) {
      if (err.code === "not_found") {
        // Index said yes, storage said no → data integrity failure.
        return c.json({ error: "storage_integrity_error" }, 500);
      }
      if (err.code === "timeout" || err.code === "unavailable") {
        return c.json({ error: "storage_unavailable" }, 502);
      }
      return c.json({ error: "storage_integrity_error" }, 500);
    }
    throw err;
  }

  // We wrote `text/html; charset=utf-8` on the way in; let chrono-storage's
  // content-type round-trip (with a sensible default) speak for the response.
  const contentType = html.contentType || "text/html; charset=utf-8";

  return new Response(html.body, {
    status: 200,
    headers: {
      "content-type": contentType,
      // Immutable pages — bake in the longest sensible max-age.
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
});
