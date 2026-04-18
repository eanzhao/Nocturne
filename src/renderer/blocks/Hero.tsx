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
 */
export function Hero({ brief }: { brief: DailyBrief }) {
  const title = sanitizeText(brief.title, 200);
  const dek = sanitizeOptional(brief.dek, 280);
  const dateLabel = sanitizeOptional(brief.date_label, 80);

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
