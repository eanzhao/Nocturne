/** @jsxImportSource hono/jsx */
import { describe, expect, it } from 'bun:test';
import { OrnamentStrip } from './OrnamentStrip.tsx';

describe('OrnamentStrip', () => {
  it('renders a decorative div with aria-hidden', () => {
    const html = String(OrnamentStrip());
    expect(html).toContain('ornament-strip');
    expect(html).toContain('role="presentation"');
    expect(html).toContain('aria-hidden="true"');
  });
});
