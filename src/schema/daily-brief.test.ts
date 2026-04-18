import { describe, expect, it, test } from 'bun:test';

import { DailyBriefBlock } from './daily-brief.ts';

describe('DailyBriefBlock', () => {
  test('parses a minimal valid brief', () => {
    const input = {
      content_type: 'daily_brief_v1',
      title: 'Morning digest',
      spec_id: 'executive-broadsheet',
    };
    const result = DailyBriefBlock.parse(input);
    expect(result.title).toBe('Morning digest');
    expect(result.spec_id).toBe('executive-broadsheet');
    expect(result.content_type).toBe('daily_brief_v1');
  });

  test('parses a fully populated brief', () => {
    const input = {
      content_type: 'daily_brief_v1',
      title: 'A busy Thursday',
      dek: 'Three decisions to make before noon.',
      date_label: '2026-04-17',
      spec_id: 'quiet-ledger',
      hero_quote: 'Small steps, each morning.',
      summary: 'Today is mostly about shipping the spec pass.',
      top_priorities: [
        {
          title: 'Review schema PR',
          why_it_matters: 'Downstream renderer blocks on this.',
          action: 'Open PR and request review.',
        },
      ],
      timeline: [{ time: '09:00', item: 'Standup' }],
      watchlist: [
        { label: 'CI status', severity: 'med', note: 'flaky e2e last night' },
      ],
      notes: [{ heading: 'Reminder', body: 'Water the plants.' }],
    };
    const result = DailyBriefBlock.parse(input);
    expect(result.top_priorities).toHaveLength(1);
    expect(result.watchlist[0]?.severity).toBe('med');
  });

  test('rejects an unknown spec_id', () => {
    const input = {
      content_type: 'daily_brief_v1',
      title: 'Hi',
      spec_id: 'signal-poster',
    };
    const result = DailyBriefBlock.safeParse(input);
    expect(result.success).toBe(false);
  });

  test('rejects a title longer than 200 characters', () => {
    const input = {
      content_type: 'daily_brief_v1',
      title: 'x'.repeat(201),
      spec_id: 'executive-broadsheet',
    };
    const result = DailyBriefBlock.safeParse(input);
    expect(result.success).toBe(false);
  });

  test('defaults list-valued blocks to empty arrays when omitted', () => {
    const input = {
      content_type: 'daily_brief_v1',
      title: 'Empty day',
      spec_id: 'guji-classical',
    };
    const result = DailyBriefBlock.parse(input);
    expect(result.top_priorities).toEqual([]);
    expect(result.timeline).toEqual([]);
    expect(result.watchlist).toEqual([]);
    expect(result.notes).toEqual([]);
  });

  test('rejects wrong content_type literal', () => {
    const input = {
      content_type: 'explainer_v1',
      title: 'Nope',
      spec_id: 'executive-broadsheet',
    };
    const result = DailyBriefBlock.safeParse(input);
    expect(result.success).toBe(false);
  });
});

describe('DailyBriefBlock — multimodal extensions', () => {
  const minimalValid = {
    content_type: 'daily_brief_v1' as const,
    title: 'T',
    spec_id: 'executive-broadsheet' as const,
  };

  it('parses without any multimodal fields', () => {
    const result = DailyBriefBlock.safeParse(minimalValid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.visual_intents).toBeUndefined();
      expect(result.data.visual_assets).toBeUndefined();
      expect(result.data.brief_status).toBeUndefined();
      expect(result.data.revision).toBeUndefined();
      expect(result.data.idempotency_key).toBeUndefined();
      expect(result.data.visual_style_override).toBeUndefined();
      expect(result.data.sidenotes).toBeUndefined();
    }
  });

  it('accepts a full visual_intent', () => {
    const result = DailyBriefBlock.safeParse({
      ...minimalValid,
      visual_intents: [
        {
          block_ref: 'fig1',
          kind: 'image',
          prompt: 'a steam locomotive',
          style_hint: 'sepia engraving',
          caption: 'Figure 1',
          credit: 'Generated via Nocturne',
          alt: 'A steam locomotive approaching a water tower',
          aspect_ratio: '3:2',
          column_span: 'wide',
          placement_hint: 'lead',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects visual_intent.kind outside enum', () => {
    const result = DailyBriefBlock.safeParse({
      ...minimalValid,
      visual_intents: [{ block_ref: 'x', kind: 'audio' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects visual_intent.column_span outside enum', () => {
    const result = DailyBriefBlock.safeParse({
      ...minimalValid,
      visual_intents: [{ block_ref: 'x', kind: 'image', column_span: 'huge' as never }],
    });
    expect(result.success).toBe(false);
  });

  it('accepts up to 12 visual_intents', () => {
    const intents = Array.from({ length: 12 }, (_, i) => ({
      block_ref: `fig${i}`,
      kind: 'image' as const,
    }));
    const result = DailyBriefBlock.safeParse({ ...minimalValid, visual_intents: intents });
    expect(result.success).toBe(true);
  });

  it('rejects more than 12 visual_intents', () => {
    const intents = Array.from({ length: 13 }, (_, i) => ({
      block_ref: `fig${i}`,
      kind: 'image' as const,
    }));
    const result = DailyBriefBlock.safeParse({ ...minimalValid, visual_intents: intents });
    expect(result.success).toBe(false);
  });

  it('accepts visual_assets with status enum', () => {
    const result = DailyBriefBlock.safeParse({
      ...minimalValid,
      visual_assets: [
        {
          block_ref: 'fig1',
          object_ref: 'nocturne-media/u1/p1/fig1.png',
          provider: 'flux-schnell',
          revision: 1,
          status: 'ok',
          mime: 'image/png',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects visual_asset.status outside enum', () => {
    const result = DailyBriefBlock.safeParse({
      ...minimalValid,
      visual_assets: [
        {
          block_ref: 'fig1',
          object_ref: 'x',
          provider: 'y',
          revision: 1,
          status: 'uploading' as never,
          mime: 'image/png',
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('accepts brief_status enum', () => {
    for (const status of ['queued', 'planning', 'generating', 'partial', 'ready', 'failed', 'cancelled'] as const) {
      const result = DailyBriefBlock.safeParse({ ...minimalValid, brief_status: status });
      expect(result.success).toBe(true);
    }
  });

  it('accepts revision as non-negative integer', () => {
    expect(DailyBriefBlock.safeParse({ ...minimalValid, revision: 0 }).success).toBe(true);
    expect(DailyBriefBlock.safeParse({ ...minimalValid, revision: 42 }).success).toBe(true);
    expect(DailyBriefBlock.safeParse({ ...minimalValid, revision: -1 }).success).toBe(false);
    expect(DailyBriefBlock.safeParse({ ...minimalValid, revision: 1.5 }).success).toBe(false);
  });

  it('accepts sidenotes up to 10', () => {
    const sidenotes = Array.from({ length: 10 }, (_, i) => ({
      anchor_ref: `s${i}`,
      text: 'note',
    }));
    expect(DailyBriefBlock.safeParse({ ...minimalValid, sidenotes }).success).toBe(true);
    const tooMany = [...sidenotes, { anchor_ref: 's10', text: 'note' }];
    expect(DailyBriefBlock.safeParse({ ...minimalValid, sidenotes: tooMany }).success).toBe(false);
  });

  it('rejects sidenote text over 200 chars', () => {
    const result = DailyBriefBlock.safeParse({
      ...minimalValid,
      sidenotes: [{ anchor_ref: 's1', text: 'x'.repeat(201) }],
    });
    expect(result.success).toBe(false);
  });
});
