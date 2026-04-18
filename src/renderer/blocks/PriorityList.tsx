/** @jsxImportSource hono/jsx */
import type { AestheticSpec } from '../../schema/aesthetic-spec.ts';
import type { DailyBrief } from '../../schema/daily-brief.ts';
import { sanitizeOptional, sanitizeText } from '../../utils/sanitize.ts';

/**
 * Fallback text rendered when a DailyBrief has zero priorities.
 *
 * The schema permits `top_priorities: []`, and in that case we want the
 * block to render SOMETHING (a human reading an empty list would assume
 * the page broke) — but only here, never for the other list blocks. This
 * is specific to priorities because "no priorities today" is a real and
 * meaningful state for a daily brief.
 */
const EMPTY_FALLBACK = 'No priorities recorded for today.';

/**
 * Top-priorities list.
 *
 * Respects two spec-driven knobs:
 *
 *   - `hero_priority_treatment = 'first-as-hero'` → item[0] gets the
 *     `.is-hero` class (larger display).
 *   - `overflow_strategy.top_priorities.max` → truncates to N items,
 *     and when the input had more, appends an "+K omitted" coda.
 *
 * Uses spec.overflow_strategy ONLY via structured lookup, never a
 * hard-coded number.
 */
export function PriorityList({
  brief,
  spec,
}: {
  brief: DailyBrief;
  spec: AestheticSpec;
}) {
  const items = brief.top_priorities;

  if (items.length === 0) {
    return (
      <section class="priority-list-section">
        <h2 class="block-label">Top Priorities</h2>
        <p class="empty-fallback">{EMPTY_FALLBACK}</p>
      </section>
    );
  }

  const overflow = spec.overflow_strategy.top_priorities;
  const max = overflow?.max ?? items.length;
  const visible = items.slice(0, max);
  const omitted = Math.max(0, items.length - visible.length);

  const treatment = spec.hero_priority_treatment;
  // `.is-hero` (first-as-hero) is a mild emphasis. `.is-dominant` (new,
  // used by front-page-daily) turns the first item into the page's huge
  // headline + lead graf. `.is-only` (single-only) tells per-spec CSS to
  // render as a focused full-span card (keynote-sheet uses this shape in
  // a different place — its priorities cluster lives in the pillars
  // column, not as a single-only centerpiece — but the treatment still
  // applies if a spec opts in).
  const firstClassExtra =
    treatment === 'dominant-lead'
      ? ' is-hero is-dominant'
      : treatment === 'first-as-hero'
      ? ' is-hero'
      : treatment === 'single-only'
      ? ' is-only'
      : '';

  const overflowCoda =
    omitted > 0 && overflow?.on_overflow !== 'truncate-hard' ? (
      <div class="overflow-coda">+{omitted} omitted</div>
    ) : null;

  return (
    <section class="priority-list-section">
      <h2 class="block-label">Top Priorities</h2>
      <ol class="priority-list">
        {visible.map((item, idx) => {
          const title = sanitizeText(item.title, 80);
          const why = sanitizeOptional(item.why_it_matters, 200);
          const action = sanitizeOptional(item.action, 120);
          const cls =
            idx === 0
              ? `priority-item${firstClassExtra}`
              : 'priority-item';
          return (
            <li class={cls}>
              <div class="num">{String(idx + 1).padStart(2, '0')}</div>
              <div class="title">{title}</div>
              {why !== undefined ? <div class="why">{why}</div> : null}
              {action !== undefined ? (
                <div class="action">{action}</div>
              ) : null}
            </li>
          );
        })}
      </ol>
      {overflowCoda}
    </section>
  );
}
