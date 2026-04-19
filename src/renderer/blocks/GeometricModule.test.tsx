/** @jsxImportSource hono/jsx */
import { describe, expect, it } from 'bun:test';
import { GeometricModule } from './GeometricModule.tsx';

describe('GeometricModule', () => {
  it('renders a decorative div with aria-hidden', () => {
    const html = String(GeometricModule());
    expect(html).toContain('geometric-module');
    expect(html).toContain('role="presentation"');
    expect(html).toContain('aria-hidden="true"');
  });
});
