/** @jsxImportSource hono/jsx */

/**
 * Pure CSS-only decorative strip. Reads no data.
 *
 * Used by historical and broadside specs (loc-broadside-1870,
 * rijks-ledger-1650, nypl-botanical) where per-spec CSS draws
 * period-appropriate ornaments inside this container.
 *
 * aria-hidden because it carries no semantic content — everything
 * visible is decorative.
 */
export function OrnamentStrip() {
  return <div class="ornament-strip" role="presentation" aria-hidden="true" />;
}
