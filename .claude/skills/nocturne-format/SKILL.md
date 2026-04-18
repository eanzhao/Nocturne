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

1. **NyxID (preferred)** — if `~/.nyxid/access_token` exists AND `/api/v1/llm/status` reports ≥1 ready provider, routes through the NyxID LLM gateway. The user logs in via `nyxid login` (separate CLI).
2. **Direct OpenAI-compatible (fallback)** — if `api_key` is set (config file or `NOCTURNE_OPENAI_API_KEY` env var).
3. Neither → the CLI errors with a hint pointing at both paths.

Check which is live:

```bash
nocturne-format status
# or the installed binary: nocturne-format status
```

## Config — `nocturne-format config`

The CLI has a first-class config store at `~/.config/nocturne/config.json` (chmod 0600). Use it instead of asking the user to edit dotfiles.

```bash
nocturne-format config list
nocturne-format config get <key>
nocturne-format config set <key> <value>
nocturne-format config unset <key>
```

**Keys:** `model` · `base-url` · `out-dir` · `api-key` (kebab or snake accepted).

Env vars with the same meaning override the file at runtime:

| Env var                     | Config key  |
| --------------------------- | ----------- |
| `NOCTURNE_OPENAI_MODEL`     | `model`     |
| `NOCTURNE_OPENAI_BASE_URL`  | `base-url`  |
| `NOCTURNE_OPENAI_API_KEY`   | `api-key`   |
| `NOCTURNE_OUT_DIR`          | `out-dir`   |

### Model-prefix routing (NyxID mode)

The gateway picks the provider from the model prefix:

| Prefix       | NyxID provider slug         |
| ------------ | --------------------------- |
| `gpt-*`      | `openai` or `openai-codex`  |
| `claude-*`   | `anthropic`                 |
| `deepseek-*` | `deepseek`                  |
| `gemini-*`   | `gemini`                    |

Run `nocturne-format status` to see which providers are `ready`. Pick a model matching one of them. Common pitfall: `gpt-4o-mini` routes to `openai-codex` only if the user has the ChatGPT Codex connector — that connector rejects non-codex models. If the user's ready set is `{anthropic, deepseek, openai-codex}`, set the model to `deepseek-chat` (JSON-mode friendly, cheap, fast):

```bash
nocturne-format config set model deepseek-chat
```

## Prerequisites (repo checkout)

- Working directory has `package.json` with `"name": "nocturne"` and `src/cli/format.ts`.
- `bun` on PATH.
- EITHER `nyxid login` done once, OR `api-key` configured via the `config` subcommand / env.
- Optional: `model` / `base-url` / `out-dir` via `config set`.

If nothing is configured, ask the user which path they want before running.

## How to invoke

Prefer **stdin**:

```bash
printf '%s' "$CONTENT" | nocturne-format
```

From a file:

```bash
nocturne-format --in ./content.md
```

Specific output:

```bash
nocturne-format --in ./content.md --out ~/Desktop/my-page.html
```

## Exit codes & error handling

- `0` — success; stdout has the output path.
- Non-zero — stderr has `error: ...`. Common cases:
  - `no planner source available` → `nyxid login` or `config set api-key sk-...`.
  - `planner upstream HTTP 4xx/5xx` → provider issue; try a different model prefix (suggest `deepseek-chat` as a safe default via `config set model deepseek-chat`).
  - `planner returned invalid output` → usually a model that doesn't honor `response_format: json_object` (Anthropic via NyxID often hits this). Switch to OpenAI-family or DeepSeek.

Warnings may precede the output path on stderr (e.g. "NyxID path unavailable: ...") — the fallback fired; the page still generated.

## Known local-mode limitations (tell the user if asked)

- The "Good / Bad" rate buttons and the archive link inside the rendered page are inert on `file://` — they target an HTTP server that is not running in CLI mode.
- Export-as-PDF works via browser print; just `Cmd/Ctrl+P` the opened page.

## Do NOT

- Do NOT start the HTTP server (`bun run dev`) just to render one page. The CLI is the local path.
- Do NOT write NyxID / chrono-storage / Supabase server-side env vars for the CLI; those are for the hosted server only.
- Do NOT hand-edit `~/.config/nocturne/config.json` when the `config` subcommand works — it chmods to 0600 and validates the schema on write.
- Do NOT commit `.env` files with real API keys.
