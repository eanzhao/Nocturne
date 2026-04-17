# Nocturne — Design System

> **Nocturne has no unified design system. It has a vocabulary of coexisting aesthetics.**

Each `AestheticSpec` is its own miniature design system. The LLM at runtime picks one per page based on content mood. A `命理` report and a `daily_brief` share zero visual DNA — and that is the point.

This file is the contract that keeps future work from collapsing three specs into one house style.

---

## Meta-stance

The thing you are NOT allowed to do:

- Introduce "shared" typography, color, or spacing that override per-spec tokens.
- Refactor specs toward a single base CSS that "all three could extend."
- Pick a "hero font" for Nocturne. Nocturne has no single typeface.
- Add a "Nocturne brand color." There is no brand color. The closest thing is the chrome-zone `NOCTURNE` wordmark, which is rendered in each spec's own `fonts.label`, in each spec's own `palette.fg`.

The thing you MUST do:

- When adding a new aesthetic, write a new `AestheticSpec` JSON that commits to its own fonts, palette, spacing, writing_mode, hero treatment, and severity style. Don't parameterize off an existing spec.
- When modifying an existing spec, modify only that spec's JSON. Never touch another spec's tokens in the same change.
- When in doubt, generate a mockup before writing CSS. The `~/.gstack/projects/eanzhao-Nocturne/designs/` directory is the visual reference.

---

## What IS shared across specs (the thin layer)

The renderer enforces these because they are structural, not aesthetic:

1. **Base grid unit**: 4px. Every spec's `spacing` scales off this.
2. **Rendering pipeline**: Hono JSX → static HTML string → (optional) Vivliostyle PDF. Never client-side hydration, never `dangerouslySetInnerHTML`.
3. **Content schema**: `daily_brief_v1` today. Adds (`explainer_v1`, `divination_report_v1`, ...) later. Each content schema works across all compatible specs.
4. **Chrome zone** on every `/v/{slug}` page: `Export as PDF` button, rating widget (good/bad → `POST /v/{slug}/rate`), copy-permalink, page-metadata strip (`Issue #<seq> · <date> · <model> · NOCTURNE`). Specs control **chrome style** (monochrome / CJK brush / mono-ascii), not chrome existence.
5. **XSS policy**: all block text renders as text nodes, never raw HTML. No Markdown-to-HTML in v0.
6. **Cache policy**: `/v/{slug}` returns `Cache-Control: public, max-age=31536000, immutable`. Pages are permanent artifacts.

---

## The three v0 aesthetics

Each links to the authoritative spec JSON (lives in `src/renderer/specs/`) and its approved mockup.

### `executive-broadsheet` — default for daily_brief

FT / Economist / broadsheet-era editorial. Two or three columns, cream `#f7f1df` ground, dark charcoal body, one brick-red accent `#c84a23` reserved for urgency.

`severity` dot colors for watchlist (A11y AA minimum vs `bg`):
- `high` → `#b23d18` (accent, AA compliant 5.1:1)
- `med`  → `#6b5e4d` (muted brown)
- `low`  → rgba(31,25,19,0.30) (hairline at 30% opacity)

Only 3 colors. Any additional "shade" that might drift in during implementation is forbidden.

- **Spec**: [`src/renderer/specs/executive-broadsheet.json`](src/renderer/specs/executive-broadsheet.json)
- **Mockup**: [`~/.gstack/projects/eanzhao-Nocturne/designs/daily-brief-specs-20260418/variant-A-executive-broadsheet.png`](~/.gstack/projects/eanzhao-Nocturne/designs/daily-brief-specs-20260418/variant-A-executive-broadsheet.png)
- **Fits**: daily briefs, news-shaped updates, high-info-density structured content.

### `quiet-ledger` — single-column restrained

Private-accountant worktable. Single 620px column centered on warm off-white `#faf6ea`. Serif prose, IBM Plex Mono for every number and label. Monochrome — emphasis via weight and spacing only.

- **Spec**: [`src/renderer/specs/quiet-ledger.json`](src/renderer/specs/quiet-ledger.json)
- **Mockup**: [`~/.gstack/projects/eanzhao-Nocturne/designs/daily-brief-specs-20260418/variant-B-quiet-ledger.png`](~/.gstack/projects/eanzhao-Nocturne/designs/daily-brief-specs-20260418/variant-B-quiet-ledger.png)
- **Fits**: contemplative briefs, "today hold the rhythm" days, slow reads, printed-to-pocket-notebook archives.

### `guji-classical` — East Asian vertical classical

Ming/Qing woodblock-printed book page. Vertical text flow, right-to-left column order, aged bamboo paper `#f3e7c8`, ink black, one vermilion seal `#9f2020`.

- **Spec**: [`src/renderer/specs/guji-classical.json`](src/renderer/specs/guji-classical.json)
- **Mockup**: [`~/.gstack/projects/eanzhao-Nocturne/designs/daily-brief-specs-20260418/variant-C-guji-classical.png`](~/.gstack/projects/eanzhao-Nocturne/designs/daily-brief-specs-20260418/variant-C-guji-classical.png)
- **Fits**: `命理报告`, classical-text citations, 仪式感 content. Requires CJK font packs and `writing-mode: vertical-rl` CSS.

---

## AestheticSpec schema

Every spec JSON must include (see the design plan doc for full schema):

```jsonc
{
  "id": "...",
  "writing_mode": "horizontal-lr" | "vertical-rl",
  "hero_priority_treatment": "first-as-hero" | "all-equal" | "single-only",
  "block_zones": { "left": [...], "right": [...], "center": [...] },
  "overflow_strategy": { "<block>": { "max": N, "on_overflow": "..." } },
  "pull_quote_role": "hero-center" | "coda" | "epigraph" | "none",
  "severity_style": "colored-dot" | "bracketed-text" | "traditional-mark",
  "fonts":   { "headline": "...", "body": "...", "label": "...", "mono": "..." },
  "palette": { "bg": "...", "fg": "...", "muted": "...", "accent": "...", "hairline": "..." },
  "spacing": { "base": 4, "column_gap": N, "column_count_desktop": N, "max_width": N },
  "print":   { "paper": "A4"|"A5", "orientation": "portrait"|"landscape", "margin_mm": N }
}
```

Adding a new spec is a JSON file + its CSS (which reads from the tokens) + an approved mockup. No renderer code change.

---

## Anti-slop guardrails

These patterns are forbidden across all specs:

1. Purple / violet / indigo gradients
2. 3-column feature grids with icons-in-colored-circles (the canonical AI-generated SaaS pattern)
3. Uniform bubbly border-radius on every element
4. Decorative blobs, floating circles, wavy SVG dividers
5. Emoji as design elements
6. Colored left-border on cards
7. Generic "Welcome to Nocturne" hero copy — all copy is content-driven

If a new spec drifts toward any of these, reject the spec.

---

## Changelog

- **2026-04-18** — Initial DESIGN.md. 3 v0 specs committed: `executive-broadsheet`, `quiet-ledger`, `guji-classical`. Mockups approved by human. `signal-poster` spec rejected during design review.
