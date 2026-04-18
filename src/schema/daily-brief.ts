import { z } from 'zod';

const VisualIntentSchema = z.object({
  block_ref: z.string().min(1).max(32),
  kind: z.enum(['image', 'video']),
  prompt: z.string().max(500).optional(),
  style_hint: z.string().max(200).optional(),
  caption: z.string().max(200).optional(),
  credit: z.string().max(120).optional(),
  alt: z.string().max(200).optional(),
  aspect_ratio: z.string().max(16).optional(),
  column_span: z.enum(['narrow', 'medium', 'wide', 'full']).optional(),
  placement_hint: z.enum(['lead', 'inset', 'aside', 'break']).optional(),
});

const VisualAssetSchema = z.object({
  block_ref: z.string().min(1).max(32),
  object_ref: z.string().min(1).max(512),
  provider: z.string().min(1).max(64),
  revision: z.number().int().nonnegative(),
  status: z.enum(['pending', 'ok', 'failed', 'blocked', 'skipped']),
  mime: z.string().min(1).max(64),
  dims: z.object({ w: z.number().int().positive(), h: z.number().int().positive() }).optional(),
  duration_ms: z.number().int().nonnegative().optional(),
  poster_ref: z.string().max(512).optional(),
  checksum: z.string().max(128).optional(),
  moderation: z
    .object({
      state: z.enum(['ok', 'blocked']),
      reason: z.string().max(200).optional(),
    })
    .optional(),
});

export const DailyBriefBlock = z.object({
  content_type: z.literal('daily_brief_v1'),
  title: z.string().max(200),
  dek: z.string().max(280).optional(),
  date_label: z.string().max(80).optional(),
  spec_id: z.enum([
    'executive-broadsheet',
    'quiet-ledger',
    'guji-classical',
    'front-page-daily',
    'keynote-sheet',
  ]),
  hero_quote: z.string().max(280).optional(),
  summary: z.string().max(1000).optional(),
  top_priorities: z
    .array(
      z.object({
        title: z.string().max(80),
        why_it_matters: z.string().max(200).optional(),
        action: z.string().max(120).optional(),
      }),
    )
    .max(10)
    .default([]),
  timeline: z
    .array(
      z.object({
        time: z.string().max(16),
        item: z.string().max(200),
      }),
    )
    .max(20)
    .default([]),
  watchlist: z
    .array(
      z.object({
        label: z.string().max(80),
        severity: z.enum(['low', 'med', 'high']),
        note: z.string().max(200).optional(),
      }),
    )
    .max(20)
    .default([]),
  notes: z
    .array(
      z.object({
        heading: z.string().max(80).optional(),
        body: z.string().max(1000),
      }),
    )
    .max(10)
    .default([]),

  /* -----------------------------------------------------------------
   * Multimodal extensions (see docs/superpowers/specs/
   *   2026-04-19-style-batch-design.md). Schema landed now; the
   * generator pipeline is deferred to issues #22–#27. All renderer
   * blocks gracefully degrade when assets are absent.
   * ----------------------------------------------------------------- */
  visual_intents: z.array(VisualIntentSchema).max(12).optional(),
  visual_assets: z.array(VisualAssetSchema).max(12).optional(),
  brief_status: z
    .enum(['queued', 'planning', 'generating', 'partial', 'ready', 'failed', 'cancelled'])
    .optional(),
  revision: z.number().int().nonnegative().optional(),
  idempotency_key: z.string().max(128).optional(),
  visual_style_override: z.string().max(200).optional(),
  sidenotes: z
    .array(
      z.object({
        anchor_ref: z.string().min(1).max(32),
        text: z.string().max(200),
      }),
    )
    .max(10)
    .optional(),
});

export type DailyBrief = z.infer<typeof DailyBriefBlock>;
export type VisualIntent = z.infer<typeof VisualIntentSchema>;
export type VisualAsset = z.infer<typeof VisualAssetSchema>;
