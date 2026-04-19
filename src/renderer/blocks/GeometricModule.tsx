/** @jsxImportSource hono/jsx */

/**
 * Pure CSS-only geometric module. Reads no data.
 *
 * Used by Bauhaus-era specs where per-spec CSS paints primary-color
 * geometric forms (circles, squares, triangles) via `border-radius`,
 * `clip-path`, or `conic-gradient` inside this container.
 */
export function GeometricModule() {
  return <div class="geometric-module" role="presentation" aria-hidden="true" />;
}
