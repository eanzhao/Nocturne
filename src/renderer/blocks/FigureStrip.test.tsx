/** @jsxImportSource hono/jsx */
import { describe, expect, it } from 'bun:test';
import { FigureStrip } from './FigureStrip.tsx';
import type { DailyBrief } from '../../schema/daily-brief.ts';

function makeBrief(overrides: Partial<DailyBrief> = {}): DailyBrief {
  return {
    content_type: 'daily_brief_v1',
    title: 'T',
    spec_id: 'executive-broadsheet',
    top_priorities: [],
    timeline: [],
    watchlist: [],
    notes: [],
    ...overrides,
  };
}

describe('FigureStrip', () => {
  it('returns null when no visual_intents', () => {
    const el = FigureStrip({ brief: makeBrief() });
    expect(el).toBeNull();
  });

  it('returns null when visual_intents is empty', () => {
    const el = FigureStrip({ brief: makeBrief({ visual_intents: [] }) });
    expect(el).toBeNull();
  });

  it('renders a strip with one FigurePlate per visual_intent', () => {
    const brief = makeBrief({
      visual_intents: [
        { block_ref: 'fig1', kind: 'image', caption: 'Alpha' },
        { block_ref: 'fig2', kind: 'image', caption: 'Beta' },
        { block_ref: 'fig3', kind: 'image', caption: 'Gamma' },
      ],
    });
    const html = String(FigureStrip({ brief }));
    expect(html).toContain('figure-strip');
    expect(html).toContain('data-block-ref="fig1"');
    expect(html).toContain('data-block-ref="fig2"');
    expect(html).toContain('data-block-ref="fig3"');
    expect(html).toContain('Alpha');
    expect(html).toContain('Beta');
    expect(html).toContain('Gamma');
  });
});
