/** @jsxImportSource hono/jsx */
import type { AestheticSpec } from '../../schema/aesthetic-spec.ts';
import type { DailyBrief } from '../../schema/daily-brief.ts';
import { sanitizeOptional, sanitizeText } from '../../utils/sanitize.ts';

/**
 * Freeform notes block.
 *
 * Integral-hide: empty notes → block not rendered. Multiple notes get a
 * per-item heading when supplied; headings are optional so we render a
 * `<div>` wrapper regardless.
 */
export function Notes({
  brief,
  spec,
}: {
  brief: DailyBrief;
  spec: AestheticSpec;
}) {
  const items = brief.notes;
  if (items.length === 0) return null;

  const overflow = spec.overflow_strategy.notes;
  const max = overflow?.max ?? items.length;
  const visible = items.slice(0, max);
  const omitted = Math.max(0, items.length - visible.length);

  return (
    <section class="notes-section">
      <h2 class="block-label">Notes</h2>
      <div class="notes">
        {visible.map((note) => {
          const heading = sanitizeOptional(note.heading, 80);
          const body = sanitizeText(note.body, 1000);
          return (
            <div class="notes-item">
              {heading !== undefined ? (
                <div class="heading">{heading}</div>
              ) : null}
              <div class="body">{body}</div>
            </div>
          );
        })}
      </div>
      {omitted > 0 ? (
        <div class="overflow-coda">+{omitted} omitted</div>
      ) : null}
    </section>
  );
}
