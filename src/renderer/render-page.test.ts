import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { AestheticSpecSchema, loadSpecs } from '../schema/aesthetic-spec.ts';
import { DailyBriefBlock, type DailyBrief } from '../schema/daily-brief.ts';
import type { AestheticSpec } from '../schema/aesthetic-spec.ts';
import { renderPage, type RenderCtx } from './render-page.tsx';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPECS_DIR = join(__dirname, 'specs');

/** Frozen fixture shared across every snapshot test — realistic busy day. */
const FIXTURE_BASE = Object.freeze({
  content_type: 'daily_brief_v1',
  title: 'A Thursday in mid-April',
  dek: 'Three decisions before noon and one long afternoon.',
  date_label: '2026-04-17',
  hero_quote:
    'Attention is the scarcest resource. Protect it before it is gone.',
  summary:
    'Two priorities are load-bearing and one is optional. The afternoon is reserved for deep work on the renderer; evening is a reading block.',
  top_priorities: [
    {
      title: 'Ship the renderer PR',
      why_it_matters: 'Blocks issues #7 and #8 from landing.',
      action: 'Open PR; request Eanz to review.',
    },
    {
      title: 'Call Mom',
      why_it_matters: 'Been a week.',
      action: 'Before 8pm.',
    },
    {
      title: 'Run errands',
      why_it_matters: 'Groceries running low.',
    },
  ],
  timeline: [
    { time: '09:00', item: 'Standup — ship rate for the week' },
    { time: '11:30', item: 'Lunch with Kai' },
    { time: '14:00', item: 'Deep work: renderer pass' },
    { time: '18:00', item: 'Close laptop, reading block' },
  ],
  watchlist: [
    {
      label: 'CI flakiness',
      severity: 'med',
      note: 'e2e flake last night, keep an eye on tomorrow morning.',
    },
    {
      label: 'Supabase rate-limit budget',
      severity: 'high',
      note: 'at 70% — will trip next week at current pace.',
    },
    {
      label: 'Disk space on box-01',
      severity: 'low',
    },
  ],
  notes: [
    {
      heading: 'Idea',
      body: 'Add a mobile-fallback media query for guji-classical that flips writing-mode horizontally under 768px.',
    },
    {
      body: 'Water the plants.',
    },
  ],
} as const);

const CTX: RenderCtx = {
  user_id: 'user-00000000',
  seq: 42,
  page_id: 'abc123xyz',
  created_at: '2026-04-17T12:00:00Z',
  model: 'claude-opus-4.7',
};

function buildBrief(spec_id: AestheticSpec['id']): DailyBrief {
  return DailyBriefBlock.parse({ ...FIXTURE_BASE, spec_id });
}

describe('renderPage — all specs', () => {
  const specIds = [
    'executive-broadsheet',
    'quiet-ledger',
    'guji-classical',
  ] as const;

  for (const id of specIds) {
    test(`snapshot: ${id} × full daily_brief_v1 fixture`, async () => {
      const specs = await loadSpecs(SPECS_DIR);
      const spec = specs.get(id)!;
      const html = renderPage(buildBrief(id), spec, CTX);

      // Structural assertions that won't churn on CSS edits.
      expect(html.startsWith('<!doctype html>')).toBe(true);
      expect(html).toContain(`data-writing-mode="${spec.writing_mode}"`);
      expect(html).toContain(`spec-${id}`);
      expect(html).toContain('<title>A Thursday in mid-April</title>');
      expect(html).toContain('data-nocturne="base"');
      expect(html).toContain('data-nocturne="print"');
      expect(html).toContain('data-nocturne="tokens"');
      expect(html).toContain(`--bg: ${spec.palette.bg};`);
      expect(html).toContain(`--fg: ${spec.palette.fg};`);
      expect(html).toContain('data-nocturne-chrome');
      expect(html).toContain('Export as PDF');
      expect(html).toContain('Copy permalink');
      expect(html).toContain('Issue #42');
      expect(html).toContain('2026-04-17');
      expect(html).toContain('NOCTURNE');
      expect(html).toContain('window.print()');
      // Auto-snapshot keyed by spec id.
      expect(html).toMatchSnapshot(`render-${id}`);
    });
  }

  test('html lang matches spec writing_mode (zh-Hans for guji-classical)', async () => {
    const specs = await loadSpecs(SPECS_DIR);
    const classicalHtml = renderPage(
      buildBrief('guji-classical'),
      specs.get('guji-classical')!,
      CTX,
    );
    expect(classicalHtml).toContain('lang="zh-Hans"');
    const broadsheetHtml = renderPage(
      buildBrief('executive-broadsheet'),
      specs.get('executive-broadsheet')!,
      CTX,
    );
    expect(broadsheetHtml).toContain('lang="en"');
  });

  test('includes the spec class on body for per-spec print page rules', async () => {
    const specs = await loadSpecs(SPECS_DIR);
    for (const id of specIds) {
      const html = renderPage(
        buildBrief(id),
        specs.get(id)!,
        CTX,
      );
      expect(html).toMatch(
        new RegExp(`<body[^>]*class="[^"]*\\bspec-${id}\\b`),
      );
    }
  });

  test('guji-classical gets writing-mode vertical-rl on html', async () => {
    const specs = await loadSpecs(SPECS_DIR);
    const html = renderPage(
      buildBrief('guji-classical'),
      specs.get('guji-classical')!,
      CTX,
    );
    expect(html).toContain('data-writing-mode="vertical-rl"');
    expect(html).toContain('writing-mode-vertical-rl');
  });
});

describe('XSS safety', () => {
  test('title with <script> payload is escaped, no raw <script>alert in body markup', async () => {
    const specs = await loadSpecs(SPECS_DIR);
    const spec = specs.get('executive-broadsheet')!;
    const brief = DailyBriefBlock.parse({
      ...FIXTURE_BASE,
      title: '<script>alert(1)</script>',
      spec_id: 'executive-broadsheet',
    });
    const html = renderPage(brief, spec, CTX);

    // The body must not contain the unescaped payload. The renderer DOES
    // emit a legitimate inline <script> for the chrome buttons; we check
    // the escape of the payload specifically, not "no <script> anywhere".
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  test('hero_quote with angle brackets is escaped in rendered output', async () => {
    const specs = await loadSpecs(SPECS_DIR);
    const spec = specs.get('executive-broadsheet')!;
    const brief = DailyBriefBlock.parse({
      ...FIXTURE_BASE,
      hero_quote: '<img src=x onerror=alert(2)>',
      spec_id: 'executive-broadsheet',
    });
    const html = renderPage(brief, spec, CTX);
    expect(html).not.toContain('<img src=x onerror=alert(2)>');
    expect(html).toContain('&lt;img src=x onerror=alert(2)&gt;');
  });

  test('priority title with bidi override character is stripped before render', async () => {
    const specs = await loadSpecs(SPECS_DIR);
    const spec = specs.get('quiet-ledger')!;
    const brief = DailyBriefBlock.parse({
      content_type: 'daily_brief_v1',
      title: 'safe title',
      spec_id: 'quiet-ledger',
      top_priorities: [{ title: 'good\u202Edab' }],
    });
    const html = renderPage(brief, spec, CTX);
    expect(html).not.toContain('\u202E');
    expect(html).toContain('gooddab');
  });
});

describe('empty-block behavior', () => {
  test('empty top_priorities renders the fallback copy', async () => {
    const specs = await loadSpecs(SPECS_DIR);
    const spec = specs.get('executive-broadsheet')!;
    const brief = DailyBriefBlock.parse({
      content_type: 'daily_brief_v1',
      title: 'Empty priorities day',
      spec_id: 'executive-broadsheet',
    });
    const html = renderPage(brief, spec, CTX);
    expect(html).toContain('No priorities recorded for today.');
  });

  test('empty watchlist does not render the watchlist section at all', async () => {
    const specs = await loadSpecs(SPECS_DIR);
    const spec = specs.get('executive-broadsheet')!;
    const brief = DailyBriefBlock.parse({
      content_type: 'daily_brief_v1',
      title: 'No watchlist',
      spec_id: 'executive-broadsheet',
      top_priorities: [{ title: 'do a thing' }],
    });
    const html = renderPage(brief, spec, CTX);
    expect(html).not.toContain('class="watchlist-section"');
    expect(html).not.toContain('>Watchlist<');
  });

  test('empty timeline does not render the timeline section', async () => {
    const specs = await loadSpecs(SPECS_DIR);
    const spec = specs.get('quiet-ledger')!;
    const brief = DailyBriefBlock.parse({
      content_type: 'daily_brief_v1',
      title: 'No timeline',
      spec_id: 'quiet-ledger',
    });
    const html = renderPage(brief, spec, CTX);
    expect(html).not.toContain('class="timeline-section"');
  });

  test('empty notes does not render the notes section', async () => {
    const specs = await loadSpecs(SPECS_DIR);
    const spec = specs.get('quiet-ledger')!;
    const brief = DailyBriefBlock.parse({
      content_type: 'daily_brief_v1',
      title: 'No notes',
      spec_id: 'quiet-ledger',
    });
    const html = renderPage(brief, spec, CTX);
    expect(html).not.toContain('class="notes-section"');
  });

  test('missing hero_quote does not render a pull quote block', async () => {
    const specs = await loadSpecs(SPECS_DIR);
    const spec = specs.get('executive-broadsheet')!;
    const brief = DailyBriefBlock.parse({
      content_type: 'daily_brief_v1',
      title: 'No quote',
      spec_id: 'executive-broadsheet',
      top_priorities: [{ title: 'do things' }],
    });
    const html = renderPage(brief, spec, CTX);
    expect(html).not.toContain('role="doc-pullquote"');
  });
});

describe('overflow handling', () => {
  test('8 priorities → first 5 + "+3 omitted" coda for executive-broadsheet', async () => {
    const specs = await loadSpecs(SPECS_DIR);
    const spec = specs.get('executive-broadsheet')!;
    const brief = DailyBriefBlock.parse({
      content_type: 'daily_brief_v1',
      title: 'Busy day',
      spec_id: 'executive-broadsheet',
      top_priorities: Array.from({ length: 8 }, (_, i) => ({
        title: `Priority ${i + 1}`,
      })),
    });
    const html = renderPage(brief, spec, CTX);

    expect(html).toContain('Priority 1');
    expect(html).toContain('Priority 5');
    expect(html).not.toContain('Priority 6');
    expect(html).not.toContain('Priority 7');
    expect(html).not.toContain('Priority 8');
    expect(html).toContain('+3 omitted');
  });

  test('guji-classical truncates top_priorities to 3 per spec override', async () => {
    const specs = await loadSpecs(SPECS_DIR);
    const spec = specs.get('guji-classical')!;
    const brief = DailyBriefBlock.parse({
      content_type: 'daily_brief_v1',
      title: 'Busy classical day',
      spec_id: 'guji-classical',
      top_priorities: Array.from({ length: 5 }, (_, i) => ({
        title: `事 ${i + 1}`,
      })),
    });
    const html = renderPage(brief, spec, CTX);
    expect(html).toContain('事 1');
    expect(html).toContain('事 3');
    expect(html).not.toContain('事 4');
    expect(html).toContain('+2 omitted');
  });
});

describe('severity rendering dispatch', () => {
  test('executive-broadsheet uses colored dots with CSS var colors', async () => {
    const specs = await loadSpecs(SPECS_DIR);
    const spec = specs.get('executive-broadsheet')!;
    const brief = buildBrief('executive-broadsheet');
    const html = renderPage(brief, spec, CTX);
    expect(html).toContain('class="sev-dot sev-high"');
    expect(html).toContain('class="sev-dot sev-med"');
    expect(html).toContain('--severity-high: #b23d18;');
  });

  test('quiet-ledger uses bracketed text severity', async () => {
    const specs = await loadSpecs(SPECS_DIR);
    const spec = specs.get('quiet-ledger')!;
    const brief = buildBrief('quiet-ledger');
    const html = renderPage(brief, spec, CTX);
    expect(html).toContain('[HIGH]');
    expect(html).toContain('[MED]');
    expect(html).toContain('class="sev-bracket"');
  });

  test('guji-classical uses traditional glyph marks from spec', async () => {
    const specs = await loadSpecs(SPECS_DIR);
    const spec = specs.get('guji-classical')!;
    const brief = buildBrief('guji-classical');
    const html = renderPage(brief, spec, CTX);
    expect(html).toContain('class="sev-mark"');
    expect(html).toContain('●');
    expect(html).toContain('○');
  });
});

describe('hero priority treatment', () => {
  test('first-as-hero adds .is-hero to the first priority for executive-broadsheet', async () => {
    const specs = await loadSpecs(SPECS_DIR);
    const spec = specs.get('executive-broadsheet')!;
    const brief = buildBrief('executive-broadsheet');
    const html = renderPage(brief, spec, CTX);
    expect(html).toContain('class="priority-item is-hero"');
  });

  test('all-equal does NOT add .is-hero to any priority item for quiet-ledger', async () => {
    const specs = await loadSpecs(SPECS_DIR);
    const spec = specs.get('quiet-ledger')!;
    const brief = buildBrief('quiet-ledger');
    const html = renderPage(brief, spec, CTX);
    // CSS contains `.is-hero` rules; we only care whether any
    // priority-item element got the class applied.
    expect(html).not.toContain('class="priority-item is-hero"');
  });
});

describe('chrome + provenance', () => {
  test('owner_slug → "All your Nocturnes" link', async () => {
    const specs = await loadSpecs(SPECS_DIR);
    const spec = specs.get('executive-broadsheet')!;
    const brief = buildBrief('executive-broadsheet');
    const html = renderPage(brief, spec, { ...CTX, owner_slug: 'eanz' });
    expect(html).toContain('href="/u/eanz"');
    expect(html).toContain('All your Nocturnes');
  });

  test('no owner_slug → no "All your Nocturnes" link', async () => {
    const specs = await loadSpecs(SPECS_DIR);
    const spec = specs.get('executive-broadsheet')!;
    const brief = buildBrief('executive-broadsheet');
    const html = renderPage(brief, spec, CTX);
    expect(html).not.toContain('All your Nocturnes');
  });

  test('provenance strip contains seq, date, model, wordmark', async () => {
    const specs = await loadSpecs(SPECS_DIR);
    const spec = specs.get('executive-broadsheet')!;
    const brief = buildBrief('executive-broadsheet');
    const html = renderPage(brief, spec, CTX);
    expect(html).toMatch(/class="provenance-strip"/);
    expect(html).toContain('Issue #42');
    expect(html).toContain('2026-04-17');
    expect(html).toContain('claude-opus-4.7');
    expect(html).toContain('NOCTURNE');
  });
});

describe('spec schema sanity (loads cleanly before render)', () => {
  test('every spec in src/renderer/specs parses', async () => {
    const specs = await loadSpecs(SPECS_DIR);
    expect(specs.size).toBe(3);
    for (const spec of specs.values()) {
      const parsed = AestheticSpecSchema.safeParse(spec);
      expect(parsed.success).toBe(true);
    }
  });
});
