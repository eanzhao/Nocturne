import { z } from 'zod';

export const DailyBriefBlock = z.object({
  content_type: z.literal('daily_brief_v1'),
  title: z.string().max(200),
  dek: z.string().max(280).optional(),
  date_label: z.string().max(80).optional(),
  spec_id: z.enum(['executive-broadsheet', 'quiet-ledger', 'guji-classical']),
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
});

export type DailyBrief = z.infer<typeof DailyBriefBlock>;
