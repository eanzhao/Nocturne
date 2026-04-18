/** @jsxImportSource hono/jsx */
import type { AestheticSpec } from '../../schema/aesthetic-spec.ts';
import type { DailyBrief } from '../../schema/daily-brief.ts';
import { sanitizeOptional } from '../../utils/sanitize.ts';

/**
 * Dispatch table for the pull-quote's visual role. Each entry takes the
 * already-sanitized text and returns the block markup for that role.
 *
 * - `hero-center` — a giant quote in the center column (executive-broadsheet).
 * - `coda` — footer-ish single italic line after the body (quiet-ledger).
 * - `epigraph` — top-of-column tag-line before content (guji-classical).
 * - `none` — never render.
 *
 * The spec picks a role with `spec.pull_quote_role`. Using a table keeps
 * the role a *data* decision, not a branching-code decision.
 */
const pullQuoteRenderers: Record<
  AestheticSpec['pull_quote_role'],
  (text: string) => unknown
> = {
  'hero-center': (text) => (
    <blockquote class="hero-quote" role="doc-pullquote">
      <p>{text}</p>
    </blockquote>
  ),
  coda: (text) => (
    <blockquote class="pull-quote pull-quote--coda" role="doc-pullquote">
      <p>{text}</p>
    </blockquote>
  ),
  epigraph: (text) => (
    <blockquote class="pull-quote pull-quote--epigraph" role="doc-pullquote">
      <p>{text}</p>
    </blockquote>
  ),
  none: () => null,
};

/**
 * Pull quote renderer. The `brief` exposes `hero_quote` — we feed that
 * into the role renderer selected by spec.pull_quote_role. When the role
 * is `none` OR the quote is empty, we return null (integral-hide).
 */
export function PullQuote({
  brief,
  spec,
}: {
  brief: DailyBrief;
  spec: AestheticSpec;
}) {
  if (spec.pull_quote_role === 'none') return null;
  const text = sanitizeOptional(brief.hero_quote, 280);
  if (text === undefined) return null;
  const render = pullQuoteRenderers[spec.pull_quote_role];
  // Renderers always return JSX.Element; the `unknown` in the table
  // is because TS can't express a JSX-polymorphic lookup without help.
  return render(text) as never;
}
