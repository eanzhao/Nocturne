/** @jsxImportSource hono/jsx */
import { describe, expect, it } from 'bun:test';
import { FigurePlate } from './FigurePlate.tsx';
import type { DailyBrief, VisualIntent, VisualAsset } from '../../schema/daily-brief.ts';

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

const intent: VisualIntent = {
  block_ref: 'fig1',
  kind: 'image',
  prompt: 'a steam locomotive',
  caption: 'Figure 1',
  credit: 'Generated',
  alt: 'A steam locomotive',
  aspect_ratio: '3:2',
  column_span: 'wide',
};

const okAsset: VisualAsset = {
  block_ref: 'fig1',
  object_ref: 'nocturne-media/u1/p1/fig1.png',
  provider: 'flux-schnell',
  revision: 1,
  status: 'ok',
  mime: 'image/png',
};

describe('FigurePlate', () => {
  it('returns null when no matching intent exists', () => {
    const el = FigurePlate({ brief: makeBrief(), blockRef: 'fig1' });
    expect(el).toBeNull();
  });

  it('renders typographic placeholder when intent present but asset absent', () => {
    const brief = makeBrief({ visual_intents: [intent] });
    const html = String(FigurePlate({ brief, blockRef: 'fig1' }));
    expect(html).toContain('figure-plate');
    expect(html).toContain('data-block-ref="fig1"');
    expect(html).toContain('data-state="placeholder"');
    expect(html).toContain('Figure 1');
    expect(html).toContain('Generated');
    // No img/video when asset absent
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<video');
  });

  it('renders typographic placeholder when asset status is not ok', () => {
    const brief = makeBrief({
      visual_intents: [intent],
      visual_assets: [{ ...okAsset, status: 'pending' }],
    });
    const html = String(FigurePlate({ brief, blockRef: 'fig1' }));
    expect(html).toContain('data-state="placeholder"');
    expect(html).not.toContain('<img');
  });

  it('renders img when image asset status is ok', () => {
    const brief = makeBrief({
      visual_intents: [intent],
      visual_assets: [okAsset],
    });
    const html = String(FigurePlate({ brief, blockRef: 'fig1' }));
    expect(html).toContain('data-state="ok"');
    expect(html).toContain('<img');
    expect(html).toContain('src="/m/page-id-placeholder/fig1"');
    expect(html).toContain('alt="A steam locomotive"');
  });

  it('renders video when video asset status is ok', () => {
    const videoIntent: VisualIntent = { ...intent, kind: 'video' };
    const videoAsset: VisualAsset = { ...okAsset, mime: 'video/mp4', poster_ref: 'x.jpg' };
    const brief = makeBrief({
      visual_intents: [videoIntent],
      visual_assets: [videoAsset],
    });
    const html = String(FigurePlate({ brief, blockRef: 'fig1' }));
    expect(html).toContain('<video');
    expect(html).toContain('autoplay');
    expect(html).toContain('loop');
    expect(html).toContain('muted');
    expect(html).toContain('playsinline');
    expect(html).toContain('poster="/m/page-id-placeholder/fig1/poster"');
  });

  it('applies column_span as a data attribute', () => {
    const brief = makeBrief({ visual_intents: [intent] });
    const html = String(FigurePlate({ brief, blockRef: 'fig1' }));
    expect(html).toContain('data-column-span="wide"');
  });

  it('escapes caption and credit', () => {
    const brief = makeBrief({
      visual_intents: [{ ...intent, caption: '<x>', credit: '<y>' }],
    });
    const html = String(FigurePlate({ brief, blockRef: 'fig1' }));
    expect(html).not.toContain('<x>');
    expect(html).toContain('&lt;x&gt;');
  });
});
