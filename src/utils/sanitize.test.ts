import { describe, expect, test } from 'bun:test';

import { sanitizeOptional, sanitizeText } from './sanitize.ts';

describe('sanitizeText', () => {
  test('passes a plain short string through unchanged', () => {
    expect(sanitizeText('hello world', 80)).toBe('hello world');
  });

  test('strips zero-width characters', () => {
    // ZWSP between every char; resulting string should equal the input minus them.
    const dirty = 'h\u200Be\u200Cl\u200Dl\u2060o';
    expect(sanitizeText(dirty, 80)).toBe('hello');
  });

  test('strips bidi override characters that enable homograph spoofing', () => {
    const dirty = 'good\u202Edab';
    expect(sanitizeText(dirty, 80)).toBe('gooddab');
  });

  test('strips BOM', () => {
    expect(sanitizeText('\uFEFFtitle', 80)).toBe('title');
  });

  test('collapses runs of whitespace to a single space', () => {
    expect(sanitizeText('a    b\t\tc\nd', 80)).toBe('a b c d');
  });

  test('collapses CJK ideographic space', () => {
    expect(sanitizeText('早\u3000安', 80)).toBe('早 安');
  });

  test('trims leading and trailing whitespace', () => {
    expect(sanitizeText('   hi   ', 80)).toBe('hi');
  });

  test('truncates to maxLen with an ellipsis when overflow', () => {
    const out = sanitizeText('abcdefghij', 5);
    expect(out.length).toBe(5);
    expect(out.endsWith('\u2026')).toBe(true);
    expect(out).toBe('abcd\u2026');
  });

  test('does not truncate when exactly at maxLen', () => {
    expect(sanitizeText('abcde', 5)).toBe('abcde');
  });

  test('handles maxLen of 0 by returning empty string', () => {
    expect(sanitizeText('hello', 0)).toBe('');
  });

  test('rejects input exceeding 10KB', () => {
    // Over 5120 JS chars → over the 10KB byte gate (we treat 2 bytes/char).
    const huge = 'a'.repeat(6000);
    expect(() => sanitizeText(huge, 100)).toThrow(/exceeds hard limit/);
  });

  test('accepts input just under 10KB', () => {
    const big = 'a'.repeat(5000);
    const out = sanitizeText(big, 5000);
    expect(out.length).toBe(5000);
  });

  test('throws TypeError on non-string', () => {
    expect(() => sanitizeText(42 as unknown as string, 10)).toThrow(TypeError);
  });

  test('throws on negative maxLen', () => {
    expect(() => sanitizeText('hi', -1)).toThrow(RangeError);
  });

  test('throws on non-finite maxLen', () => {
    expect(() => sanitizeText('hi', Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('sanitizeOptional', () => {
  test('returns undefined for undefined / null / empty-after-cleanup', () => {
    expect(sanitizeOptional(undefined, 80)).toBeUndefined();
    expect(sanitizeOptional(null, 80)).toBeUndefined();
    expect(sanitizeOptional('   ', 80)).toBeUndefined();
    expect(sanitizeOptional('\u200B\u200C', 80)).toBeUndefined();
  });

  test('returns the sanitized string when non-empty', () => {
    expect(sanitizeOptional('  hello  ', 80)).toBe('hello');
  });
});
