---
name: nocturne-format
description: Use when the user wants to turn raw text (an LLM reply, an article, a daily brief, a report) into a beautifully-rendered HTML page on disk via the local Nocturne CLI. Triggers include "render this as a page", "make this into HTML", "format this for reading", "generate a Nocturne", or any request to produce a shareable/presentable rendering of free-form content. Requires NOCTURNE_OPENAI_API_KEY in the environment.
---

# Nocturne Format (Local CLI)

Nocturne turns free-form content into a hand-crafted newspaper/broadsheet-style HTML page. This skill invokes the local CLI — it does NOT hit any network-hosted Nocturne service.

## When to use

Use this when the user says any of:
- "Render this as a Nocturne"
- "Format this as an HTML page"
- "Turn this into a shareable report"
- "Generate a broadsheet / brief from this"

Do NOT use for: Markdown preview, plain HTML, simple formatting, or anything that does not call for a full typeset page.

## Prerequisites

- Working directory must be a Nocturne checkout (or a descendant) — check for `package.json` with `"name": "nocturne"` and an `src/cli/format.ts`.
- `bun` on PATH.
- Env var `NOCTURNE_OPENAI_API_KEY` set. If it is missing, ask the user for it before running.
- Optional overrides: `NOCTURNE_OPENAI_BASE_URL` (e.g. OpenRouter), `NOCTURNE_OPENAI_MODEL`, `NOCTURNE_OUT_DIR`.

## How to invoke

Prefer **stdin**, because it avoids creating a throwaway file:

```bash
printf '%s' "$CONTENT" | bun run format
```

Where `$CONTENT` is the raw text. The CLI prints the absolute path of the generated HTML file on stdout. Capture it and present it to the user as a `file://` URL or open it in their browser with `open` (macOS) / `xdg-open` (Linux).

If the content is already in a file:

```bash
bun run format --in ./content.md
```

To pick a specific output location:

```bash
bun run format --in ./content.md --out ~/Desktop/my-page.html
```

## Exit codes & error handling

- `0` — success; stdout has the output path.
- Non-zero — any failure (missing key, empty input, planner error, spec error, malformed args). Error is on stderr; surface it verbatim to the user.

## Known local-mode limitations (tell the user if asked)

- The "Good / Bad" rate buttons and the archive ("All your Nocturnes") link inside the generated page are inert on `file://` — they would hit an HTTP server that is not running in CLI mode. The page content itself is complete.
- Export-as-PDF works by browser print; just `Cmd/Ctrl+P` the opened page.

## Do NOT

- Do NOT start the HTTP server (`bun run dev`) just to render one page. The CLI is the local path.
- Do NOT write NyxID / chrono-storage / Supabase env vars; those are for the hosted HTTP server, not the CLI.
- Do NOT commit `.env` files with real API keys.
