// Ambient module declarations for non-JS assets imported via Bun's compile-time
// `with { type: "..." }` attributes. Without these TypeScript cannot type the
// imports at build time.

declare module "*.css" {
  const text: string;
  export default text;
}
