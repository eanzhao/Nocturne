/** @jsxImportSource hono/jsx */
import type { AestheticSpec } from '../../schema/aesthetic-spec.ts';
import type { DailyBrief } from '../../schema/daily-brief.ts';
import { sanitizeOptional, sanitizeText } from '../../utils/sanitize.ts';

type Severity = 'low' | 'med' | 'high';

/**
 * Severity-to-markup lookup. Each entry knows how to render one severity
 * level for one severity_style variant. No switch/if chains — the spec
 * picks the variant by key.
 *
 * - `colored-dot` — tiny colored dot inline before the label.
 *   Colors come from spec.severity_colors (fallback to palette roles).
 * - `bracketed-text` — ASCII-style `[HIGH]` prefix in mono type.
 * - `traditional-mark` — CJK-friendly glyph (●, ○, ＋) from
 *   spec.severity_marks; renders as text.
 *
 * Each renderer returns a Hono JSX `any`-typed element; TSX strict typing
 * for polymorphic JSX children is more trouble than it's worth for a
 * lookup table of this shape.
 */
const severityRenderers: Record<
  AestheticSpec['severity_style'],
  (sev: Severity, spec: AestheticSpec) => unknown
> = {
  'colored-dot': (sev) => (
    <span class={`sev-dot sev-${sev}`} aria-label={sev} />
  ),
  'bracketed-text': (sev) => (
    <span class="sev-bracket" aria-label={sev}>
      [{sev.toUpperCase()}]
    </span>
  ),
  'traditional-mark': (sev, spec) => {
    const mark = spec.severity_marks?.[sev] ?? '·';
    return (
      <span class="sev-mark" aria-label={sev}>
        {mark}
      </span>
    );
  },
  // `none` — spec suppresses severity rendering entirely (keynote-sheet).
  // Returning null drops the indicator without reshaping the item markup.
  none: () => null,
};

/**
 * Watchlist block — items with a severity indicator.
 *
 * Integral-hide: empty watchlist → block not rendered.
 */
export function Watchlist({
  brief,
  spec,
}: {
  brief: DailyBrief;
  spec: AestheticSpec;
}) {
  const items = brief.watchlist;
  if (items.length === 0) return null;

  const overflow = spec.overflow_strategy.watchlist;
  const max = overflow?.max ?? items.length;
  const visible = items.slice(0, max);
  const omitted = Math.max(0, items.length - visible.length);

  const renderSeverity = severityRenderers[spec.severity_style];

  return (
    <section class="watchlist-section">
      <h2 class="block-label">Watchlist</h2>
      <ul class="watchlist">
        {visible.map((item) => {
          const label = sanitizeText(item.label, 80);
          const note = sanitizeOptional(item.note, 200);
          return (
            <li class="watchlist-item">
              {renderSeverity(item.severity, spec) as unknown}
              <span class="label">{label}</span>
              {note !== undefined ? <span class="note">— {note}</span> : null}
            </li>
          );
        })}
      </ul>
      {omitted > 0 ? (
        <div class="overflow-coda">+{omitted} omitted</div>
      ) : null}
    </section>
  );
}
