/** @jsxImportSource hono/jsx */
import { describe, expect, it } from 'bun:test';
import { DiagonalSlab } from './DiagonalSlab.tsx';

describe('DiagonalSlab', () => {
  it('renders a decorative div with aria-hidden', () => {
    const html = String(DiagonalSlab());
    expect(html).toContain('diagonal-slab');
    expect(html).toContain('role="presentation"');
    expect(html).toContain('aria-hidden="true"');
  });
});
