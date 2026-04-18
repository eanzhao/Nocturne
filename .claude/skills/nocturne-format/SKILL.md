---
name: nocturne-format
description: Use when the user wants to turn raw text (an LLM reply, an article, a daily brief, a report) into a beautifully-rendered HTML page on disk via the local Nocturne CLI. Triggers include "render this as a page", "make this into HTML", "format this for reading", "generate a Nocturne", or any request to produce a shareable/presentable rendering of free-form content. Uses NyxID-brokered LLM providers when available, falls back to a direct OpenAI-compatible key otherwise.
---

# Nocturne Format (Local CLI)

Nocturne turns free-form content into a hand-crafted newspaper/broadsheet-style HTML page. This skill invokes the local CLI from inside the Nocturne checkout — it does NOT hit any network-hosted Nocturne service.

## When to use

Use this when the user says any of:
- "Render this as a Nocturne"
- "Format this as an HTML page"
- "Turn this into a shareable report"
- "Generate a broadsheet / brief from this"

Do NOT use for: Markdown preview, plain HTML, simple formatting, or anything that does not call for a full typeset page.

## LLM resolution order

The CLI picks its LLM source automatically:

1. **NyxID (preferred)** — if `~/.nyxid/access_token` exists AND `/api/v1/llm/status` reports ≥1 ready provider, routes through the NyxID LLM gateway. The user logs in via `nyxid login` (separate CLI); Nocturne never owns login.
2. **Direct OpenAI-compatible (fallback)** — if `NOCTURNE_OPENAI_API_KEY` is set.
3. Neither → the CLI errors with a hint pointing at both paths.

Check which is live:

```bash
bun run format status
```

## Prerequisites

- Working directory must be a Nocturne checkout — `package.json` has `"name": "nocturne"` and `src/cli/format.ts` exists.
- `bun` on PATH.
- EITHER `nyxid login` done once (tokens in `~/.nyxid/`, ≥1 LLM provider configured on the NyxID dashboard), OR `NOCTURNE_OPENAI_API_KEY` exported.
- Optional: `NOCTURNE_OPENAI_MODEL` (default `gpt-4o-mini`; in NyxID mode the gateway routes by prefix — `gpt-*`, `claude-*`, `deepseek-*`, `gemini-*`), `NOCTURNE_OPENAI_BASE_URL` (ignored in NyxID mode), `NOCTURNE_OUT_DIR` (default `./out`).

If neither is configured, ask the user which path they want.

## How to invoke

Prefer **stdin**:

```bash
printf '%s' "$CONTENT" | bun run format
```

From a file:

```bash
bun run format --in ./content.md
```

Specific output:

```bash
bun run format --in ./content.md --out ~/Desktop/my-page.html
```

## Exit codes & error handling

- `0` — success; stdout has the output path.
- Non-zero — stderr has `error: ...`. Common cases:
  - `no planner source available` → run `nyxid login` or set `NOCTURNE_OPENAI_API_KEY`.
  - `planner upstream HTTP 4xx/5xx` → provider issue; try a different model prefix.
  - `planner returned invalid output` → usually a model that doesn't honor `response_format: json_object` (Anthropic via NyxID often hits this). Switch to an OpenAI-family or DeepSeek model.

Warnings may precede the output path on stderr (e.g. "NyxID path unavailable: ...") — that means fallback fired; the page still generated.

## Known local-mode limitations (tell the user if asked)

- The "Good / Bad" rate buttons and the archive link inside the rendered page are inert on `file://` — they target an HTTP server that is not running in CLI mode.
- Export-as-PDF works via browser print; just `Cmd/Ctrl+P` the opened page.

## Do NOT

- Do NOT start the HTTP server (`bun run dev`) just to render one page. The CLI is the local path.
- Do NOT write NyxID / chrono-storage / Supabase server-side env vars for the CLI; those are for the hosted server only.
- Do NOT commit `.env` files with real API keys.
