/** @jsxImportSource hono/jsx */
import type { DailyBrief } from '../../schema/daily-brief.ts';
import { sanitizeText, sanitizeOptional } from '../../utils/sanitize.ts';

/**
 * Masthead / hero block.
 *
 * Renders the title, optional dek (standfirst), and date label. This is
 * the only block guaranteed to render on every page — a DailyBrief without
 * a title is invalid at the schema layer.
 *
 * `hero_quote` is rendered by the separate PullQuote block when the spec's
 * `pull_quote_role === 'hero-center'`, not here, to keep zone semantics
 * consistent.
 *
 * Date-label precedence:
 *   1. `brief.date_label` — ONLY when the planner extracted a real date
 *      from the source content (see planner-prompt.ts: "OMIT unless the
 *      source content contains an explicit date").
 *   2. `createdAt` render-time fallback — the Nocturne-stamped ISO date,
 *      shown as a calendar date in the reader's locale. This keeps the
 *      masthead meaningful even when the source was undated, without
 *      letting the model hallucinate a date from its training data.
 */
export function Hero({
  brief,
  createdAt,
}: {
  brief: DailyBrief;
  createdAt: string;
}) {
  const title = sanitizeText(brief.title, 200);
  const dek = sanitizeOptional(brief.dek, 280);
  const dateLabel =
    sanitizeOptional(brief.date_label, 80) ?? formatCreatedAt(createdAt);

  return (
    <header class="masthead">
      {dateLabel !== undefined ? (
        <div class="date-label">{dateLabel}</div>
      ) : null}
      <h1 class="title">{title}</h1>
      {dek !== undefined ? <p class="dek">{dek}</p> : null}
    </header>
  );
}

/**
 * Render-time fallback date. We emit an ISO calendar date (YYYY-MM-DD)
 * in UTC — the same shape the provenance strip uses, so the masthead and
 * the footer don't disagree about which day "today" is. A malformed
 * `createdAt` (which shouldn't happen — the pipeline always passes
 * `new Date().toISOString()`) returns undefined rather than a crash.
 */
function formatCreatedAt(isoString: string): string | undefined {
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString().slice(0, 10);
}
