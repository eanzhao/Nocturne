/** @jsxImportSource hono/jsx */
import type { DailyBrief } from '../../schema/daily-brief.ts';
import { sanitizeOptional, sanitizeText } from '../../utils/sanitize.ts';

/**
 * Masthead banner block — classic newspaper nameplate.
 *
 * Used by `front-page-daily` in place of the generic `Hero`. Emits a
 * three-layer banner: a tiny date-label row, the nameplate wordmark (big,
 * blackletter-ish), and an optional italic dek underneath.
 *
 * The `brief.title` is used as the nameplate text. For a weekly review
 * this reads "Q1 REVIEW" or "THE WEEK IN NOCTURNE"; for a retro it might
 * read "MARCH RETROSPECTIVE". The planner is responsible for phrasing the
 * title as a nameplate-style noun phrase when it picks this spec.
 */
export function Masthead({ brief }: { brief: DailyBrief }) {
  const title = sanitizeText(brief.title, 200);
  const dek = sanitizeOptional(brief.dek, 280);
  const dateLabel = sanitizeOptional(brief.date_label, 80);

  return (
    <header class="masthead-banner">
      <div class="masthead-rule" aria-hidden="true" />
      {dateLabel !== undefined ? (
        <div class="masthead-dateline">{dateLabel}</div>
      ) : null}
      <h1 class="masthead-nameplate">{title}</h1>
      {dek !== undefined ? (
        <p class="masthead-tagline">{dek}</p>
      ) : null}
      <div class="masthead-rule masthead-rule-double" aria-hidden="true" />
    </header>
  );
}
