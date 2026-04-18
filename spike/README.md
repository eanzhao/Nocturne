# Vivliostyle spike

Part 1 of [issue #9](https://github.com/eanzhao/Nocturne/issues/9). Validates that the Vivliostyle CLI can render a realistic Nocturne `daily_brief_v1` page to a print-worthy PDF under Bun's Node-compat layer, before the rest of v0 commits to the print path.

## Why this exists

Nocturne v0 ships with only a client-side `window.print()` Export-as-PDF path. v0.1 *may* add a server-side `GET /v/{slug}.pdf` endpoint — but only if Vivliostyle runs cleanly as a subprocess spawned from the Bun + Hono server.

If it doesn't, the project has a real architectural fork (documented in the issue body):

- **A.** Drop the server-side PDF promise entirely. Keep `window.print()` as the only export path.
- **B.** Commit to spawning headless Chrome via Puppeteer in v0.1. Bigger install, more ops surface.

The spike exists so that decision isn't made under deadline pressure.

## What's in here

- `executive-broadsheet-sample.html` — hand-authored static HTML + inline CSS that renders a realistic `daily_brief_v1` page using the `executive-broadsheet` aesthetic tokens from `DESIGN.md`. Self-contained — no external font loads, no JS, no external CSS. The content includes hero, dek, hero quote, four `top_priorities` with action lines, a seven-row timeline, a six-row watchlist with severity dots (`high` / `med` / `low`), a notes column, a centered pull-quote, and a chrome zone + provenance strip at the bottom.
- `run-vivliostyle.sh` — bash wrapper that shells out to `bunx @vivliostyle/cli build`. This intentionally mirrors how the eventual v0.1 server-side renderer would invoke Vivliostyle (subprocess, not an in-process import), so the spike stays representative.
- `out.pdf` — generated artifact (gitignored).

## Running

From the repo root:

```bash
bash spike/run-vivliostyle.sh
```

The first run downloads a Chromium-for-Vivliostyle payload (~150MB into `~/.cache/`) and is slow. Subsequent runs are fast.

Open `spike/out.pdf` in any PDF viewer to judge whether it feels print-worthy.

## Outcome (2026-04-17, Bun 1.3.11 on macOS 24.6.0)

**PASS.** `bunx --bun @vivliostyle/cli@latest build` ran end-to-end with no Bun/Node-compat errors:

```
INFO Start building
INFO Launching PDF build environment
INFO Building pages
INFO Building PDF
INFO Processing PDF
SUCCESS Finished building spike/out.pdf
📗 Built successfully!
```

The produced file is a valid `PDF document, version 1.7`, ~400KB, rendering the full `executive-broadsheet` layout including the three-column grid, the hero quote with top/bottom rules, the severity dots in brick-red / muted-brown / 30%-ink-black, and the provenance strip.

### What this means for v0.1

Vivliostyle-under-Bun-as-subprocess is viable. The project can keep the "server-side `GET /v/{slug}.pdf` in v0.1" option open without needing the puppeteer fork or dropping the promise. A follow-up issue should still be filed to:

1. Measure cold-start and warm-start build latency (`out.pdf` generation time) under a production-ish load.
2. Decide whether we spawn per-request or keep a long-lived worker pool.
3. Figure out where Vivliostyle's bundled Chromium lives in the deployed binary (it's not inside `dist/nocturne` today — the `bun build --compile` artifact would need a sidecar).

None of those are blockers for v0. They're sizing questions for v0.1.

### Caveats worth noting

- The spike uses only font fallbacks (Georgia / serif / sans-serif / monospace). The Nocturne production path will need to decide font-embedding policy before the real `GET /v/{slug}.pdf` endpoint ships — Vivliostyle will happily embed whatever the browser sees, which means the renderer's CSS is load-bearing for PDF fidelity.
- `bunx --bun @vivliostyle/cli@latest` pins the *latest* at build time. The follow-up issue should pin an exact version in a dedicated `pdf-worker` package.json (never in the main `package.json` — keeps the Bun build artifact lean).
