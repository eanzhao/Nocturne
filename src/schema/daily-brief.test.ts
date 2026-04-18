import { describe, expect, test } from 'bun:test';

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
