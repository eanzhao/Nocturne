# `src/renderer/blocks/` — TODO for issue #5 (renderer)

This directory will hold the per-block JSX renderers consumed by the Hono SSR
pipeline. Issue #5 owns the actual implementation. Issue #9 (Vivliostyle spike
+ print CSS + Export-as-PDF client wiring) only leaves the contracts below so
the renderer doesn't have to re-discover them.

## Export-as-PDF button — contract issue #5 must satisfy

The chrome zone on every `/v/{slug}` page renders an **Export as PDF** control.
Issue #9 Part 3 (client wiring) is NOT implemented here — it is a component
that belongs to the renderer, and lives with its siblings (rating widget,
copy-permalink, provenance strip). When issue #5 builds the chrome-zone block:

1. **Markup shape** (exact classes matter — `print.css` keys off them):

   ```html
   <div class="chrome-zone" data-nocturne-chrome>
     <button type="button" class="chrome-btn" data-action="export-pdf">
       Export as PDF
     </button>
     <!-- siblings: rating widget, copy-permalink, ... -->
     <div class="export-pdf-popover"
          data-nocturne-popover="export-pdf"
          hidden>
       Use &ldquo;Save as PDF&rdquo; in your browser&rsquo;s print dialog.
     </div>
   </div>
   ```

2. **Behavior** (vanilla JS, no framework — matches the "never client-side
   hydration" rule in DESIGN.md §"What IS shared across specs"):

   - On click, call `window.print()`.
   - BEFORE calling `print()`, unhide the popover
     (`popover.hidden = false`) so the user sees the hint if their browser's
     print dialog is slow to appear.
   - Dismiss the popover on any `click` that is not inside the popover.
     `document.addEventListener('click', ...)` once, with a guard that
     ignores the same click that opened it.
   - The popover must NOT appear in the printed output. `print.css` already
     hides it via `@media print` — do not add a competing hide rule.

3. **Why no server-side PDF yet**: the Vivliostyle spike in `spike/` passed
   (see `spike/README.md`), which means a `GET /v/{slug}.pdf` endpoint is
   viable for v0.1. But v0 ships with `window.print()` only, per the issue.
   The button must therefore NEVER render an `<a href="…pdf">` variant in
   v0 — even if the server endpoint lands later, the UX decision is made
   by a separate product issue, not silently by the renderer.

4. **Styling**: pulled from each spec's `fonts.label` + `palette.fg`. No
   shared button CSS; per DESIGN.md there is no shared Nocturne button
   look.

5. **Print CSS already hides**: `.chrome-zone`, everything inside it, and
   the popover. See `src/renderer/print.css`.

## Out of scope for issue #9

- The actual `<button>` component.
- The rating widget (good/bad → `POST /v/{slug}/rate`).
- The copy-permalink button.
- The provenance strip renderer.
- Any per-spec block renderers (`priority`, `timeline`, `watchlist`, …).

All of those belong to issue #5.
