/**
 * Shared route error mappers.
 *
 * `IndexError` is the typed Postgres-layer failure raised by `src/index/supabase.ts`.
 * Multiple routes hit the index; this central helper keeps the HTTP contract
 * consistent so an index outage on `/format` and on `/u/share` produce the
 * same shape of error body.
 */
import type { Context } from "hono";
import { IndexError } from "../index/supabase.ts";

/**
 * Install a Hono `onError` handler that maps `IndexError` to typed 500
 * responses. Unknown errors re-throw so Hono's default handler takes over.
 *
 * Usage:
 *   const app = new Hono();
 *   app.get(...); app.post(...);
 *   installIndexErrorHandler(app);
 *   return app;
 */
export function mapIndexError(err: unknown, c: Context): Response | null {
  if (err instanceof IndexError) {
    if (err.code === "duplicate") {
      return c.json({ error: "duplicate_page_id" }, 500);
    }
    if (err.code === "unavailable") {
      return c.json({ error: "index_unavailable" }, 503);
    }
    // timeout, constraint, and any unknown IndexError code map to the generic
    // write-failed — the upstream docstring says callers "see a typed
    // IndexError and decide", and 500 with a stable code is the decision.
    return c.json({ error: "index_write_failed" }, 500);
  }
  return null;
}
