# Design: Style batch — 15 new aesthetic specs + multimodal foundation

**Date**: 2026-04-19
**Status**: Draft for user review
**Branch**: `feat/nyxid-auth-consume`

## Intent

1. Add **15 new visual specs** to Nocturne, expanding the library from 5 editorial/print styles to 20 styles across editorial, art-movement, historical public-domain, and open-source-CSS genres.
2. Lay down the **schema foundation** for a future multimodal pipeline (Harry Potter "Daily Prophet" vision: AI-generated images and short videos flowing alongside text in newspaper layouts), without implementing the generation pipeline itself this round.
3. Pay down related tech debt: stale `V0_RAW_SPECS` list, print.css `@page` boilerplate, and snapshot test strategy that will not scale past 10 specs.

This spec scopes **what** gets built and **in what order**. The full step-by-step implementation plan is a separate artifact (writing-plans output).

---

## The 15 specs

Each name below is final (brand-proximate names were de-branded per trade-dress risk review).

### Category A — Editorial variants (5)
Authored from general knowledge of editorial typography; no scraping of branded sources.

| id | genre | paper × orientation |
|---|---|---|
| `compact-weekly-review` | compact news-weekly (de-branded from Economist-adjacent) | A4 portrait |
| `literary-longform` | literary magazine long-form (de-branded from Harper's-adjacent) | A4 portrait |
| `scholarly-figure` | scientific journal with figure + caption grammar | A4 portrait |
| `continental-broadsheet` | European broadsheet newspaper (de-branded from Le Monde-adjacent) | A4 portrait |
| `cjk-horizontal-broadsheet` | modern CJK horizontal newspaper (de-branded from Asahi-adjacent) | A4 portrait |

### Category B — Art-movement specs (4)
Authored from general knowledge of art-movement visual grammar.

| id | genre | paper × orientation |
|---|---|---|
| `swiss-grid` | Müller-Brockmann Swiss International | A4 portrait |
| `bauhaus-modular` | Bauhaus-school geometric composition | A4 landscape |
| `constructivist-agitprop` | Russian Constructivism agitprop poster | A4 portrait |
| `brutalist-raw` | web brutalism | A4 portrait |

### Category C — Historical public-domain (3)
Authored from codex-delivered research on specific real sources; every palette hex and font choice traceable to a named public-domain source.

| id | source | paper × orientation |
|---|---|---|
| `loc-broadside-1870` | Library of Congress 1870s American broadside collection | A4 portrait |
| `nypl-botanical` | NYPL Public Domain botanical plates | A4 portrait |
| `rijks-ledger-1650` | Rijksmuseum Dutch 17th-century ledgers | A4 landscape |

### Category D — Open-source CSS inspirations (3)
Authored from codex-delivered research on MIT/CC0 CSS libraries; the libraries' own visual languages are open licensed.

| id | source | paper × orientation |
|---|---|---|
| `tufte-sidenotes` | Tufte CSS (MIT, edwardtufte.github.io/tufte-css) | A4 portrait |
| `sakura-zen` | Sakura CSS (MIT) | A4 portrait |
| `pico-classless` | Pico CSS (MIT) | A4 portrait |

---

## Schema foundation for multimodal (this round, even though generation is deferred)

The "Daily Prophet" vision needs newspaper pages where text, AI-generated images, and short AI-generated videos flow together. This round lands the **schema**, **block vocabulary**, and **graceful fallback rendering** — but not the generation pipeline, provider abstraction, quota system, or trust-boundary proxy. Those are separate follow-up work (issues #22–#27).

### New types in `src/schema/daily-brief.ts`

```ts
// LLM-authored. No URLs. Ever.
visual_intents?: Array<{
  block_ref: string;                         // "fig1", "fig2" — unique per brief
  kind: 'image' | 'video';
  prompt?: string;                            // subject the image depicts
  style_hint?: string;                        // per-block style override
  caption?: string;
  credit?: string;
  alt?: string;                               // required for `ok`-state rendering; a11y
  aspect_ratio?: string;                      // free form: "16:9" | "3:2" | "1:1"
  column_span?: 'narrow' | 'medium' | 'wide' | 'full';   // semantic; renderer maps
  placement_hint?: 'lead' | 'inset' | 'aside' | 'break';
}>

// Brief-level state (defaults to 'ready' today, since all briefs are synchronous)
brief_status?: 'queued' | 'planning' | 'generating' | 'partial'
             | 'ready'  | 'failed'   | 'cancelled';
revision?: number;
idempotency_key?: string;

// User-level style override for the whole page
visual_style_override?: string;

// Sidenote support (for Tufte-style specs)
sidenotes?: Array<{
  anchor_ref: string;
  text: string;
}>;
```

### New types NOT in the LLM schema (system-authored)

`VisualAsset` is authored by the generator pipeline, not the LLM. It is merged with `visual_intents` at render time.

```ts
// Lives alongside the brief, system-written.
visual_assets?: Array<{
  block_ref: string;                           // matches a visual_intent.block_ref
  object_ref: string;                          // internal handle, NOT a URL
  provider: string;                            // "flux-schnell" | "sdxl-engraving" | etc.
  revision: number;                            // must match brief.revision
  status: 'pending' | 'ok' | 'failed' | 'blocked' | 'skipped';
  mime: string;
  dims?: { w: number; h: number };
  duration_ms?: number;                        // video only
  poster_ref?: string;                         // video poster object ref
  checksum?: string;
  moderation?: { state: 'ok' | 'blocked'; reason?: string };
}>;
```

This round: `visual_assets` is always null. The renderer treats `visual_intents` as "reserved slots" and degrades to typographic-only layouts (caption + credit, no image) when no matching asset is present.

### New field in `src/schema/aesthetic-spec.ts`

```ts
visual_style_hint: string;  // baseline style for all figures in this spec
```

Every AestheticSpec must have this filled. Empty string is not acceptable — pick a meaningful style even for specs that rarely use figures (e.g., `brutalist-raw` might be `"raw unretouched photograph, high contrast, no filters"`).

### New `BLOCK_NAMES` in `src/schema/aesthetic-spec.ts`

| new name | what it reads | used by |
|---|---|---|
| `ornament_strip` | nothing (pure CSS decoration) | loc-broadside-1870, rijks-ledger-1650, nypl-botanical |
| `geometric_module` | nothing (CSS-driven shapes) | bauhaus-modular |
| `diagonal_slab` | nothing (CSS diagonal cuts) | constructivist-agitprop |
| `sidenote_column` | `sidenotes[]` field from DailyBrief | tufte-sidenotes, literary-longform |
| `figure_plate` | one `visual_intent` + matching `visual_asset` if any | nypl-botanical, scholarly-figure, loc-broadside-1870 |
| `figure_strip` | N `visual_intents` + matching assets if any | bauhaus-modular, constructivist-agitprop |

### Graceful fallback rendering (this round's actual behavior)

When a spec's `block_zones` includes `figure_plate` or `figure_strip`:
- If `visual_intents` has a matching block_ref AND `visual_assets` has it in `ok` state → render the image/video
- If intent present but asset missing/pending/blocked → render typographic placeholder: caption in italic, credit in small caps, decorative border, the shape the final figure will take (preserves page layout)
- If intent absent → block renders nothing (zero-height)

Decorative blocks (`ornament_strip`, `geometric_module`, `diagonal_slab`) always render, since they carry no content.

---

## Pre-requisite work (must land before any of the 15 specs)

Split out as its own mini-batch; per codex review, mixing it with the 15-spec work causes quality collapse.

1. **Schema extension** — `visual_intents`, `visual_assets`, `brief_status`, `revision`, `idempotency_key`, `visual_style_override`, `sidenotes` added to `daily-brief.ts`. `visual_style_hint` added to `aesthetic-spec.ts`. 6 new BLOCK_NAMES. All existing 5 specs get `visual_style_hint` backfilled (one-liner per spec describing their default figure aesthetic, even though they don't use figures today).
2. **Block components** — 6 new React components in `src/renderer/blocks/` with snapshot tests for render-with-asset, render-without-asset, and render-without-intent.
3. **`BLOCK_COMPONENTS` map** updated in `render-page.tsx`.
4. **Planner prompt** updated in `src/llm/planner-prompt.ts` to document when to populate `visual_intents` (today: never, since no generator exists, but the schema is documented for future use).
5. **Bug fix: stale `V0_RAW_SPECS`** in `src/core/pipeline.ts` — currently missing `front-page-daily` and `keynote-sheet`. Fix backports them, then the 15 new specs are added to this list as they land.
6. **`print.css` @page helper** — extract a Sass-mixin-like CSS custom-property pattern so each spec declares paper/orientation/margin in a compact block rather than 15 repeated boilerplate `@page` definitions.
7. **Snapshot strategy** — current test snapshots the entire HTML per spec; with 20 specs the snapshot file would hit ~15,000 lines and drown real regression signal. Switch to **structural assertions + key CSS-token presence** for all specs, and keep full-HTML snapshots only for the 2 specs with the most layout complexity (front-page-daily, bauhaus-modular as a representative of the new set).
8. **Differentiation matrix** — authored as `docs/superpowers/specs/2026-04-19-differentiation-matrix.md`. 6 dimensions (information density / heading hierarchy / quotation treatment / decorative grammar / whitespace rhythm / alignment strategy); every spec must differ from its nearest neighbor in ≥3 dimensions. This is a **check** run before each spec ships, not a retroactive audit.

---

## Workflow phases

```
Phase 0  — Pre-req (single work unit)
           Items 1–8 above. Lands as one atomic PR. All existing tests pass.
           Duration: ~0.5 day.

Phase 1  — Codex research (parallel; 6 sources)
           Dispatch 6 codex-rescue agents concurrently with the research brief
           (template in this doc, § "Codex research brief"). Each returns a
           ResearchSheet for one of the α-specs (C×3 + D×3).
           Duration: ~15 min wall clock (parallel), ~2 hr work.

Phase 2  — Family sampler: 4 specs, one per category
           Pick representatives:
             • A: `compact-weekly-review`
             • B: `swiss-grid`
             • C: `tufte-sidenotes`  (α, eats codex sheet)
             • D: `loc-broadside-1870` (α, eats codex sheet)
           Each ships with JSON + full-custom CSS + all 8 integration points.
           CHECKPOINT: user reviews these 4 against the differentiation matrix
           and calls out anything that's off-direction. Return to Phase 2 if
           needed; do not start Phase 3 until the 4 samplers are approved.

Phase 3  — Remaining 11 specs (batched by category)
           Batch 3A: rest of A (4 specs)
           Batch 3B: rest of B (3 specs)
           Batch 3C: rest of C (2 specs, α, each with codex sheet)
           Batch 3D: rest of D (2 specs, α, each with codex sheet)
           Each batch runs in a separate PR.
           After each batch: `bun test` passes, visual QA, differentiation-
           matrix check, user spot-checks palette and layout.

Phase 4  — Planner prompt update
           Update `src/llm/planner-prompt.ts` to teach the LLM when to choose
           each of the 15 new specs. Wait until all 15 land, otherwise the
           planner references ids that don't exist yet.
```

---

## Per-spec deliverable (applies to every one of the 15)

### Files touched
1. `src/renderer/specs/<id>.json` — new, ~40 lines, validated against `AestheticSpecSchema`
2. `src/renderer/specs/<id>.css` — new, 100–200 lines, full custom layout
3. `src/renderer/render-page.tsx` — `import` + `SPEC_CSS` map entry
4. `src/schema/daily-brief.ts` — `spec_id` enum member
5. `src/core/pipeline.ts` — `import` + push to `V0_RAW_SPECS`
6. `src/renderer/render-page.test.ts` — `specIds` array member (auto-generates structural snapshot)
7. `src/renderer/print.css` — `@page <id>` block (paper/orientation/margin_mm)
8. Differentiation-matrix entry in `docs/superpowers/specs/2026-04-19-differentiation-matrix.md`

### Rules (enforced by pre-req work + reviewer checklist)

- id in kebab-case, no brand names
- description ≤200 chars, English, tells the planner when to choose this spec
- writing_mode = `horizontal-lr` unless CJK-vertical is the point
- fonts: at least 2 fallback layers; historical/CJK specs include Noto/Source fallback
- palette.accent may be `null` for monochrome specs
- spacing differs from nearest neighbor in ≥1 of {column_count, max_width}
- block_zones: ≥2 zones; no single zone holds all blocks
- overflow_strategy covers every block listed in block_zones
- print @page fills all three of size / orientation / margin_mm
- CSS file 100–200 lines (pre-req script checks this)
- visual_style_hint filled with a meaningful one-liner
- differentiation matrix entry shows distinct choices in ≥3 dimensions from nearest neighbor

---

## Codex research brief (for α-specs only)

This is the **exact** text sent to codex for each of the 6 α-specs. Variables in `<...>`.

```
# 任务：为 Nocturne 提取 <style-name> 的视觉 DNA

## 上下文
Nocturne 渲染 LLM 输出为报纸风 HTML 页面。已有 5 个编辑/印刷 spec。
本轮在扩 15 个 spec，需要真实源的精确提色和版式特征
（不能是你记忆里的泛泛描述）。

## 目标源
<URL>

## 版权前提（已预筛）
<license>。你只需提取设计特征，不要复制代码/文本。

## 产出格式（严格遵守）

### 1. Palette
- bg:       #xxxxxx
- fg:       #xxxxxx
- muted:    #xxxxxx
- accent:   #xxxxxx  (或 null)
- hairline: #xxxxxx
方法：WebFetch 原站，解析 CSS 变量或 computed color。不确定时写 TBD，
不得编造。

### 2. Fonts (stack)
- headline: "..."
- body:     "..."
- label:    "..."
- mono:     "..."

### 3. 版式特征（3-5 条）
- 栏数、栏宽、栏间距（具体像素/em）
- 标题层级（字号、字重、行高）
- 段落节奏、引文处理、边注/装饰
- 独有视觉记号

### 4. 版权声明
- License: <...>
- Source URL: <...>
- 备注: <...>

### 5. visual_style_hint（1 行，给 AestheticSpec 用）
<style 描述，会直接嵌入 AestheticSpec JSON>

### 6. 一段话总结（≤80 字中文）
给 planner 用。

## 禁止
- 编造 hex → 标 TBD
- 复制源文案
- 推荐非 MIT/CC0/PD 的源
```

---

## Explicitly out of scope (future phases — tracked as issues)

- [#22] Async generation pipeline + persistent state machine
- [#23] Trust boundary: VisualIntent/VisualAsset split, media proxy, CSP
- [#24] Multimodal renderer: column-span, video, print fallback
- [#25] Visual Director: layered style hints (spec < brief < block)
- [#26] Image/video generator provider abstraction
- [#27] Quotas, TTL, garbage collection for generated media

These are foundation-laying decisions for the Daily Prophet vision. They are tracked so that the scope boundary of this round is unambiguous: **lay down the schema, land the 15 specs, do not build the executor**.

---

## Risks & mitigations

| risk | mitigation |
|---|---|
| CSS-only visual-diversity among B-class specs (bauhaus / constructivist) feels weak | 3 new decorative blocks (`geometric_module`, `diagonal_slab`, `ornament_strip`) give these specs layout-level, not just palette-level, differentiation |
| 15 specs in one work unit cause quality collapse | Split into pre-req + sampler + 4 batches; checkpoint after sampler |
| Trade-dress risk from brand-adjacent specs | All 5 A-class names de-branded |
| Snapshot-test bloat drowning regression signal | Structural assertions + key-token presence; full-HTML snapshot only for 2 representative specs |
| Codex hallucinating hex values when research fails | Brief explicitly requires TBD when uncertain; I review every ResearchSheet before using it |
| Schema churn when generation pipeline lands | Schema designed from codex's red-team review; `VisualIntent`/`VisualAsset` split, `column_span` semantic, `brief_status` state machine already accounted for |
| User unfamiliar with CSS can't eyeball visual quality | Each batch renders fixture pages and either gets browser-preview or claude-preview screenshots for user review |

---

## Open questions (for user review of this spec)

1. **Pre-req PR structure** — items 1–8 touch ~19 files. Two choices:
   - (a) Single PR: all schema + blocks + tests + print + matrix + bug fix land together.
   - (b) Two PRs: PR1 = schema extension + block components + BLOCK_COMPONENTS (items 1–3), PR2 = tests + print + matrix + V0_RAW_SPECS fix (items 5–8). Safer review, more merge overhead.
2. **Sampler C-pick** — `loc-broadside-1870` stress-tests the schema hardest (uses `ornament_strip` + `figure_plate` + historical palette). Alternative: swap to `tufte-sidenotes` for a gentler sampler that stress-tests `sidenote_column` instead. Which do you prefer?
3. **Matrix review** — `differentiation-matrix.md` is authored by me during Phase 0. Should codex also review the matrix for completeness before Phase 2 starts, or is my single pass sufficient?
