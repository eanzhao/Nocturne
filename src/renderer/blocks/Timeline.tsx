/** @jsxImportSource hono/jsx */
import type { AestheticSpec } from '../../schema/aesthetic-spec.ts';
import type { DailyBrief } from '../../schema/daily-brief.ts';
import { sanitizeText } from '../../utils/sanitize.ts';

/**
 * Timeline block — chronological list of `time → item` pairs.
 *
 * Integral-hide: if the input timeline is empty, this returns null and
 * the block leaves no trace in the layout.
 *
 * Overflow strategy `expand-column` means "do not truncate" — we emit
 * every row and let the layout absorb it. `truncate-with-count` is
 * supported for parity with the other list blocks.
 */
export function Timeline({
  brief,
  spec,
}: {
  brief: DailyBrief;
  spec: AestheticSpec;
}) {
  const items = brief.timeline;
  if (items.length === 0) return null;

  const overflow = spec.overflow_strategy.timeline;
  const truncate = overflow?.on_overflow === 'truncate-with-count';
  const max = overflow?.max ?? items.length;
  const visible = truncate ? items.slice(0, max) : items;
  const omitted = truncate ? Math.max(0, items.length - visible.length) : 0;

  return (
    <section class="timeline-section">
      <h2 class="block-label">Timeline</h2>
      <div class="timeline">
        {visible.map((row) => (
          <>
            <div class="time">{sanitizeText(row.time, 16)}</div>
            <div class="item">{sanitizeText(row.item, 200)}</div>
          </>
        ))}
      </div>
      {omitted > 0 ? (
        <div class="overflow-coda">+{omitted} omitted</div>
      ) : null}
    </section>
  );
}
