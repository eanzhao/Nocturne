/** @jsxImportSource hono/jsx */
import type { DailyBrief } from '../../schema/daily-brief.ts';
import { sanitizeOptional } from '../../utils/sanitize.ts';

/**
 * Standalone prose `summary` field. If absent or sanitizes to empty, the
 * block omits itself entirely (integral-hide rule — empty blocks never
 * render, they leave no trace in the layout).
 */
export function Summary({ brief }: { brief: DailyBrief }) {
  const text = sanitizeOptional(brief.summary, 1000);
  if (text === undefined) return null;
  return (
    <section class="summary">
      <p>{text}</p>
    </section>
  );
}
