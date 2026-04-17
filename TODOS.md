# Nocturne — TODOs

Deferred work items. Each item has a date, why-it-matters, and enough context to pick up cold.

---

## 2026-04-18 — CJK webfont strategy for `guji-classical`

**What**: Decide and implement a production CJK webfont strategy for the `guji-classical` aesthetic spec. Without this, the spec falls back to the browser's default CJK serif and the entire classical aesthetic collapses.

**Why**: `guji-classical` is 1 of 3 v0 AestheticSpecs. It ships with CSS `font-family: "FangZheng Shu Song", "Noto Serif CJK SC", serif` — but those fonts are not loaded by default.

- Google Fonts is unreliable inside the GFW (Nocturne's explicit moat is China-reachability, so GF CDN is out).
- Adobe CJK CDN works but each Noto Serif CJK weight is ~15 MB — 2 weights × desktop + mobile = unacceptable payload.
- Self-host subsetted WOFF2: ~2 MB per weight after frequency-based glyph subsetting.

**Recommended direction** (not yet validated):
1. Self-host subsetted Noto Serif CJK SC Regular + Bold, generated with `glyphhanger` or `pyftsubset`.
2. Subset based on the top-5k most-frequent modern Simplified Chinese characters + the specific CJK glyphs used in the three hand-crafted `guji-classical` sample pages (for the mockup).
3. Serve from the Aliyun ECS directly (same origin as the rendered page, so no CDN cold-start).
4. For uncovered characters, fall back to system CJK serif with a `font-display: swap` — graceful degradation.

**Depends on / blocked by**: first `guji-classical` page with real Chinese content (so we know the glyph frequency). Can't meaningfully subset until we have a sample corpus.

**Pros**: completes the `guji-classical` aesthetic; keeps China-reachable deploy story intact.

**Cons**: 2-4h research + 1-2h subset generation + retest on mobile CJK render. Not quick.

**Context**: the `guji-classical` mockup generated via GPT-image already has character hallucinations — that's a model limitation, not a font limitation. Real rendered HTML with proper fonts will be faithful to the content; the font pipeline just needs to exist.
