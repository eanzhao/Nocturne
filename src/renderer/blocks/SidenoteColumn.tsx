/** @jsxImportSource hono/jsx */
import type { DailyBrief } from '../../schema/daily-brief.ts';
import { sanitizeText } from '../../utils/sanitize.ts';

/**
 * Sidenote column block.
 *
 * Reads `brief.sidenotes` (optional on the schema). Renders each as a
 * `<div>` with `data-anchor-ref` so per-spec CSS can style the
 * connecting thread to the main text.
 *
 * Integral-hide: if sidenotes is missing or empty, returns null and
 * the block simply does not appear in the page. The zone it was
 * allocated to collapses per the spec's grid.
 */
export function SidenoteColumn({ brief }: { brief: DailyBrief }) {
  const items = brief.sidenotes;
  if (!items || items.length === 0) return null;

  return (
    <aside class="sidenote-column">
      {items.map((note) => (
        <div class="sidenote-item" data-anchor-ref={note.anchor_ref}>
          {sanitizeText(note.text, 200)}
        </div>
      ))}
    </aside>
  );
}
