/** @jsxImportSource hono/jsx */
import { raw } from 'hono/html';

// Import CSS as text at compile time so `bun build --compile` embeds them
// into the single-binary deploy artifact. Previously these were read via
// `fs.readFileSync(__dirname/base.css)` which fails at runtime in a compiled
// binary (import.meta.url points inside the binary, not to a real directory).
import BASE_CSS from './base.css' with { type: 'text' };
import PRINT_CSS from './print.css' with { type: 'text' };

// Per-spec CSS. Each spec owns its own file so visual evolution is local
// (see issue #15 / DESIGN.md § "shared layer is structural, not aesthetic").
// The renderer inlines whichever matches `spec.id`; the others never ship.
import SPEC_CSS_EXECUTIVE_BROADSHEET from './specs/executive-broadsheet.css' with { type: 'text' };
import SPEC_CSS_QUIET_LEDGER from './specs/quiet-ledger.css' with { type: 'text' };
import SPEC_CSS_GUJI_CLASSICAL from './specs/guji-classical.css' with { type: 'text' };

const SPEC_CSS: Record<string, string> = {
  'executive-broadsheet': SPEC_CSS_EXECUTIVE_BROADSHEET,
  'quiet-ledger': SPEC_CSS_QUIET_LEDGER,
  'guji-classical': SPEC_CSS_GUJI_CLASSICAL,
};

import { type AestheticSpec, type BlockName } from '../schema/aesthetic-spec.ts';
import type { DailyBrief } from '../schema/daily-brief.ts';
import { CHROME_SCRIPT, Chrome, ProvenanceStrip, type ChromeCtx } from './blocks/Chrome.tsx';
import { Hero } from './blocks/Hero.tsx';
import { Notes } from './blocks/Notes.tsx';
import { PriorityList } from './blocks/PriorityList.tsx';
import { PullQuote } from './blocks/PullQuote.tsx';
import { Summary } from './blocks/Summary.tsx';
import { Timeline } from './blocks/Timeline.tsx';
import { Watchlist } from './blocks/Watchlist.tsx';

/** ctx object the renderer needs beyond (brief, spec). */
export interface RenderCtx extends ChromeCtx {}

/**
 * Block name → component lookup. The spec's `block_zones` is a map of
 * zone-name → block-name[]; the renderer reads each name, looks up the
 * component here, and drops it in. This is the "lookup tables, not
 * switch/if chains" rule made concrete: adding a new block type =
 * adding a row to this object.
 *
 * Names match the strings used inside AestheticSpec JSON files.
 */
const BLOCK_COMPONENTS: Record<
  BlockName,
  (props: { brief: DailyBrief; spec: AestheticSpec }) => unknown
> = {
  hero_quote: ({ brief, spec }) => <PullQuote brief={brief} spec={spec} />,
  pull_quote: ({ brief, spec }) => <PullQuote brief={brief} spec={spec} />,
  summary: ({ brief }) => <Summary brief={brief} />,
  top_priorities: ({ brief, spec }) => (
    <PriorityList brief={brief} spec={spec} />
  ),
  timeline: ({ brief, spec }) => <Timeline brief={brief} spec={spec} />,
  watchlist: ({ brief, spec }) => <Watchlist brief={brief} spec={spec} />,
  notes: ({ brief, spec }) => <Notes brief={brief} spec={spec} />,
};

// The `Record<BlockName, ...>` typing above forces TS to fail if a new name
// is added to BLOCK_NAMES without a matching component.

/**
 * Writing-mode → html attribute value lookup. `html[writing-mode]` is not
 * a real attribute — we keep the value in a data attribute for CSS hooks
 * AND set a zone-level class so base.css can target `.writing-mode-*`.
 */
const WRITING_MODE_CLASS: Record<AestheticSpec['writing_mode'], string> = {
  'horizontal-lr': 'writing-mode-horizontal-lr',
  'vertical-rl': 'writing-mode-vertical-rl',
};

/**
 * Writing-mode → `lang` attribute default. Guji uses Simplified Chinese,
 * everything else falls back to `en` (callers can override later via the
 * brief if needed — v0 keeps this simple).
 */
const LANG_BY_WRITING_MODE: Record<AestheticSpec['writing_mode'], string> = {
  'horizontal-lr': 'en',
  'vertical-rl': 'zh-Hans',
};

/**
 * Writing-mode → `dir` attribute. Only relevant when we add RTL specs
 * later; for v0 every mode is `ltr` at the element level (vertical-rl is
 * a CSS writing-mode, not a BIDI direction).
 */
const DIR_BY_WRITING_MODE: Record<AestheticSpec['writing_mode'], string> = {
  'horizontal-lr': 'ltr',
  'vertical-rl': 'ltr',
};

/** Keys we read from `spec.palette` to mint CSS vars. */
const PALETTE_KEYS = ['bg', 'fg', 'muted', 'accent', 'hairline'] as const;

/** Keys we read from `spec.fonts` to mint CSS vars. */
const FONT_KEYS = ['headline', 'body', 'label', 'mono'] as const;

// BASE_CSS + PRINT_CSS are imported as text at the top of this file (see
// `with { type: "text" }` imports) — that embeds them at compile time.

/**
 * Build the `:root` CSS variable block from the active spec.
 *
 * We inline these (not ship a second stylesheet) because the tokens change
 * per page — the renderer would otherwise need one CSS file per spec, which
 * is exactly what DESIGN.md says we are NOT doing in v0.
 */
function buildRootVariables(spec: AestheticSpec): string {
  const lines: string[] = [];
  for (const key of PALETTE_KEYS) {
    const val = spec.palette[key];
    if (val !== null && val !== undefined) {
      lines.push(`  --${key}: ${val};`);
    }
  }
  for (const key of FONT_KEYS) {
    lines.push(`  --font-${key}: ${spec.fonts[key]};`);
  }
  lines.push(`  --space-base: ${spec.spacing.base}px;`);
  lines.push(`  --column-gap: ${spec.spacing.column_gap}px;`);
  lines.push(
    `  --column-count-desktop: ${spec.spacing.column_count_desktop};`,
  );
  lines.push(`  --max-width: ${spec.spacing.max_width}px;`);
  lines.push(`  --writing-mode: ${spec.writing_mode};`);

  if (spec.severity_style === 'colored-dot' && spec.severity_colors) {
    lines.push(`  --severity-high: ${spec.severity_colors.high};`);
    lines.push(`  --severity-med: ${spec.severity_colors.med};`);
    lines.push(`  --severity-low: ${spec.severity_colors.low};`);
  }

  return `:root {\n${lines.join('\n')}\n}`;
}

/**
 * Render one zone's worth of blocks. The spec lists block names inside
 * each zone — we look each one up and render it, skipping (returning
 * null) names the lookup doesn't know about. Unknown names do not throw
 * at render time because the spec is validated at load time by
 * `AestheticSpecSchema` + the loader.
 */
function renderZone(
  zoneName: string,
  blockNames: BlockName[],
  brief: DailyBrief,
  spec: AestheticSpec,
) {
  const cssClass = `zone zone-${zoneName}`;
  return (
    <section class={cssClass} data-zone={zoneName}>
      {blockNames.map((name) => BLOCK_COMPONENTS[name]({ brief, spec }) as unknown)}
    </section>
  );
}

/**
 * Entry point. Returns a fully-formed HTML document string.
 *
 * The document shape is:
 *
 *   <!doctype html>
 *   <html lang dir class=writing-mode-* class=spec-*>
 *     <head>
 *       <meta … />
 *       <title>…</title>
 *       <style>:root { …tokens… }</style>
 *       <style>…base.css…</style>
 *       <style>…print.css…</style>
 *     </head>
 *     <body>
 *       <div class=page>
 *         <Hero … />
 *         <div class=layout layout-zones-N>
 *           <section class=zone zone-<name> data-zone=<name>> …blocks… </section>
 *           …
 *         </div>
 *         <Chrome ctx=… />
 *         <ProvenanceStrip ctx=… />
 *       </div>
 *       <script>…chrome behavior…</script>
 *     </body>
 *   </html>
 */
export function renderPage(
  brief: DailyBrief,
  spec: AestheticSpec,
  ctx: RenderCtx,
): string {
  const lang = LANG_BY_WRITING_MODE[spec.writing_mode];
  const dir = DIR_BY_WRITING_MODE[spec.writing_mode];
  const wmClass = WRITING_MODE_CLASS[spec.writing_mode];
  const specClass = `spec-${spec.id}`;

  const zoneEntries = Object.entries(spec.block_zones);
  const zoneCountClass = `layout-zones-${zoneEntries.length}`;

  const rootVars = buildRootVariables(spec);

  // Hero is mandatory (title is required by schema). It lives outside the
  // zone grid so it always anchors the top of the page.
  const heroHtml = (<Hero brief={brief} />).toString();

  const zonesHtml = zoneEntries
    .map(([name, blocks]) =>
      renderZone(name, blocks, brief, spec).toString(),
    )
    .join('');

  const chromeHtml = (<Chrome ctx={ctx} />).toString();
  const provenanceHtml = (<ProvenanceStrip ctx={ctx} />).toString();

  // Build the head. Each <style> block is its own element so a CSP
  // `style-src 'unsafe-inline'` violation would be trivially locatable.
  const head = `
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="generator" content="Nocturne" />
  <meta name="nocturne:spec" content="${escapeAttr(spec.id)}" />
  <title>${escapeText(brief.title)}</title>
  <style data-nocturne="tokens">${rootVars}</style>
  <style data-nocturne="base">${BASE_CSS}</style>
  <style data-nocturne="spec" data-spec-id="${escapeAttr(spec.id)}">${SPEC_CSS[spec.id] ?? ''}</style>
  <style data-nocturne="print">${PRINT_CSS}</style>`;

  const bodyClass = `${wmClass} ${specClass}`;

  const html = `<!doctype html>
<html lang="${escapeAttr(lang)}" dir="${escapeAttr(dir)}" class="${escapeAttr(wmClass)}" data-writing-mode="${escapeAttr(spec.writing_mode)}">
<head>${head}
</head>
<body class="${escapeAttr(bodyClass)}">
  <div class="page">
    ${heroHtml}
    <div class="layout ${escapeAttr(zoneCountClass)}">${zonesHtml}</div>
    ${chromeHtml}
    ${provenanceHtml}
  </div>
  <script>${CHROME_SCRIPT}</script>
</body>
</html>`;

  // `raw` only matters when passed back into JSX; we return the finished
  // string directly. Keep the import to document intent.
  void raw;
  return html;
}

/** Minimal attribute escaper for the hand-written outer shell. */
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Minimal text escaper for the hand-written outer shell. */
function escapeText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
