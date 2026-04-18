/**
 * Shared route error mappers.
 *
 * `IndexError` is the typed Postgres-layer failure raised by `src/index/supabase.ts`.
 * Different route groups need different surface codes because the operations
 * they perform are semantically different — a `duplicate` on `/format` is a
 * page_id collision, the same code on `/u/share` is a share-token collision,
 * and a read-path `unavailable` on `/u/{slug}` has nothing to do with writes.
 *
 * Each factory returns a Hono `onError` handler that maps `IndexError` to a
 * route-group-appropriate response. Anything else re-throws.
 */
import type { ErrorHandler } from "hono";
import { IndexError } from "../index/supabase.ts";

/**
 * Error handler for the archive sub-app (`GET /u/{slug}`).
 *
 * Reads only — no duplicate case can arise. A Postgres outage surfaces as
 * 503 `archive_unavailable`; timeouts and constraint failures as 500
 * `archive_read_failed`.
 */
export function archiveErrorHandler(): ErrorHandler {
  return (err, c) => {
    if (err instanceof IndexError) {
      if (err.code === "unavailable") {
        return c.json({ error: "archive_unavailable" }, 503);
      }
      return c.json({ error: "archive_read_failed" }, 500);
    }
    throw err;
  };
}

/**
 * Error handler for the share-token sub-app (`POST/GET/DELETE /u/share`).
 *
 * Duplicate = share-token hash collision → `share_token_conflict` (500, would
 * warrant a retry with a new random token if we ever added one). Unavailable
 * = 503. Everything else = 500 `share_write_failed`.
 */
export function archiveShareErrorHandler(): ErrorHandler {
  return (err, c) => {
    if (err instanceof IndexError) {
      if (err.code === "duplicate") {
        return c.json({ error: "share_token_conflict" }, 500);
      }
      if (err.code === "unavailable") {
        return c.json({ error: "share_unavailable" }, 503);
      }
      return c.json({ error: "share_write_failed" }, 500);
    }
    throw err;
  };
}

