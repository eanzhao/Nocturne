/** @jsxImportSource hono/jsx */
import { describe, expect, it } from 'bun:test';
import { SidenoteColumn } from './SidenoteColumn.tsx';
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

describe('SidenoteColumn', () => {
  it('returns null when sidenotes is missing', () => {
    const el = SidenoteColumn({ brief: makeBrief() });
    expect(el).toBeNull();
  });

  it('returns null when sidenotes is an empty array', () => {
    const el = SidenoteColumn({ brief: makeBrief({ sidenotes: [] }) });
    expect(el).toBeNull();
  });

  it('renders each sidenote with its anchor_ref and text', () => {
    const brief = makeBrief({
      sidenotes: [
        { anchor_ref: 's1', text: 'First sidenote.' },
        { anchor_ref: 's2', text: 'Second sidenote.' },
      ],
    });
    const html = String(SidenoteColumn({ brief }));
    expect(html).toContain('sidenote-column');
    expect(html).toContain('data-anchor-ref="s1"');
    expect(html).toContain('First sidenote.');
    expect(html).toContain('data-anchor-ref="s2"');
    expect(html).toContain('Second sidenote.');
  });

  it('escapes HTML-special characters in sidenote text', () => {
    const brief = makeBrief({
      sidenotes: [{ anchor_ref: 'x', text: '<script>alert(1)</script>' }],
    });
    const html = String(SidenoteColumn({ brief }));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
