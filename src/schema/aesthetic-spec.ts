import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Canonical list of block names the renderer knows how to mount.
 *
 * This is the single source of truth — both the schema (below) and
 * `src/renderer/render-page.tsx`'s `BLOCK_COMPONENTS` map key off it. A
 * spec JSON that mentions a name not in this list fails validation at
 * load time, so a typo like `"priortities"` surfaces on boot rather than
 * silently producing a half-rendered page.
 */
export const BLOCK_NAMES = [
  'hero_quote',
  'pull_quote',
  'summary',
  'top_priorities',
  'timeline',
  'watchlist',
  'notes',
] as const;

export type BlockName = (typeof BLOCK_NAMES)[number];

const paperValue = z.enum(['A4', 'A5']);

const severityColors = z.object({
  high: z.string(),
  med: z.string(),
  low: z.string(),
});

const severityMarks = z.object({
  high: z.string(),
  med: z.string(),
  low: z.string(),
});

const overflowEntry = z.object({
  max: z.number().int().nonnegative(),
  on_overflow: z.string(),
});

export const AestheticSpecSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  writing_mode: z.enum(['horizontal-lr', 'vertical-rl']),
  fonts: z.object({
    headline: z.string().min(1),
    body: z.string().min(1),
    label: z.string().min(1),
    mono: z.string().min(1),
  }),
  palette: z.object({
    bg: z.string().min(1),
    fg: z.string().min(1),
    muted: z.string().min(1),
    accent: z.string().min(1).nullable(),
    hairline: z.string().min(1),
  }),
  spacing: z.object({
    base: z.number().int().positive(),
    column_gap: z.number().int().nonnegative(),
    column_count_desktop: z.number().int().positive(),
    max_width: z.number().int().positive(),
  }),
  hero_priority_treatment: z.enum(['first-as-hero', 'all-equal', 'single-only']),
  block_zones: z.record(z.string(), z.array(z.enum(BLOCK_NAMES))),
  overflow_strategy: z.record(z.string(), overflowEntry),
  pull_quote_role: z.enum(['hero-center', 'coda', 'epigraph', 'none']),
  severity_style: z.enum(['colored-dot', 'bracketed-text', 'traditional-mark']),
  severity_colors: severityColors.optional(),
  severity_marks: severityMarks.optional(),
  mobile_fallback: z.enum(['horizontal-lr', 'vertical-rl']).optional(),
  print: z.object({
    paper: z.union([paperValue, z.array(paperValue).nonempty()]),
    orientation: z.enum(['portrait', 'landscape']),
    margin_mm: z.number().nonnegative(),
    cjk_vertical: z.boolean().optional(),
  }),
});

export type AestheticSpec = z.infer<typeof AestheticSpecSchema>;

/**
 * Reads every `*.json` file in `specsDir`, validates each against
 * `AestheticSpecSchema`, and returns a map keyed by `id`.
 *
 * Fails fast: if any file is malformed JSON, fails validation, or two
 * specs share an id, this throws — the renderer should never run with a
 * partially loaded spec set.
 */
export async function loadSpecs(
  specsDir: string,
): Promise<Map<string, AestheticSpec>> {
  const entries = await readdir(specsDir);
  const jsonFiles = entries.filter((name) => name.endsWith('.json')).sort();

  const specs = new Map<string, AestheticSpec>();
  for (const file of jsonFiles) {
    const fullPath = join(specsDir, file);
    const raw = await readFile(fullPath, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid JSON in ${fullPath}: ${msg}`);
    }
    const result = AestheticSpecSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `AestheticSpec validation failed for ${fullPath}: ${result.error.message}`,
      );
    }
    const spec = result.data;
    if (specs.has(spec.id)) {
      throw new Error(
        `Duplicate AestheticSpec id "${spec.id}" (second occurrence in ${fullPath})`,
      );
    }
    specs.set(spec.id, spec);
  }
  return specs;
}
