# Nocturne

Turn any LLM reply into a beautifully-typeset newspaper-style HTML page.

> [中文版 README](README_zh.md)

ChatGPT and Claude produce dense, structured content — but sharing it is either a screenshot (blurry) or a copy-paste into Notion / Lark (tedious). Nocturne is a single command that takes raw text in and writes an HTML file out: broadsheet typography, responsive layout, shareable on any device.

```bash
printf '%s' "$CONTENT" | nocturne-format
# → /Users/you/out/ab12cd3ef.html
```

## Quickstart — Claude Code

Paste this into Claude Code (any directory) and it will clone, build, install the binary, and copy the user-level skill so all future Claude Code sessions can invoke Nocturne automatically:

```
Please set up the Nocturne CLI on this machine:

1. git clone git@github.com:eanzhao/Nocturne.git ~/Code/Nocturne  (skip if already present)
2. cd ~/Code/Nocturne && bun install
3. bun run test   (sanity check — should be all green)
4. Compile a local binary for this host and install it to ~/.bun/bin:
     bun build --compile --minify --target=bun-darwin-arm64 ./src/cli/format.ts --outfile ~/.bun/bin/nocturne-format
   (on Linux: --target=bun-linux-x64 ; on Intel Mac: --target=bun-darwin-x64)
5. Copy the user-level skill so future sessions discover the CLI:
     mkdir -p ~/.claude/skills/nocturne
     cp ~/Code/Nocturne/.claude/skills/nocturne-format/SKILL.md ~/.claude/skills/nocturne/SKILL.md
6. Verify:
     nocturne-format status
     nocturne-format --help

If the user wants NyxID-brokered LLM access (recommended), also suggest they:
   - Install the nyxid CLI from the NyxID project
   - Run `nyxid login`
   - Configure at least one LLM provider on the NyxID dashboard
Otherwise suggest exporting NOCTURNE_OPENAI_API_KEY=sk-... for the fallback path.
```

> **Recommended: pair Nocturne with [NyxID](https://github.com/ChronoAIProject/NyxID).** NyxID brokers your LLM provider credentials (OpenAI, Anthropic, DeepSeek, Gemini, …) so Nocturne never touches raw API keys. After `nyxid login`, Nocturne uses `~/.nyxid/access_token` automatically and routes through NyxID's LLM gateway. Without NyxID, it falls back to `NOCTURNE_OPENAI_API_KEY` for any OpenAI-compatible endpoint.

## Manual install

Prereqs: [Bun](https://bun.sh/) ≥ 1.3, git, macOS or Linux.

```bash
git clone git@github.com:eanzhao/Nocturne.git ~/Code/Nocturne
cd ~/Code/Nocturne
bun install

# Compile a native binary into ~/.bun/bin
bun build --compile --minify \
  --target=bun-darwin-arm64 \
  ./src/cli/format.ts \
  --outfile ~/.bun/bin/nocturne-format
# targets: bun-darwin-arm64 / bun-darwin-x64 / bun-linux-x64

# (Optional) install the agent skill so Claude Code can auto-invoke it
mkdir -p ~/.claude/skills/nocturne
cp .claude/skills/nocturne-format/SKILL.md ~/.claude/skills/nocturne/SKILL.md

nocturne-format status
```

## Usage

```bash
# stdin → ./out/<slug>.html
echo "Weekly retro: shipped the CLI, closed 3 PRs..." | nocturne-format

# file input
nocturne-format --in report.md

# explicit output
nocturne-format --in report.md --out ~/Desktop/page.html

# show which auth path is active
nocturne-format status
```

The CLI prints the absolute path to the generated HTML on stdout; open it with `open` (macOS) or `xdg-open` (Linux).

### Picking a model

In NyxID mode, `NOCTURNE_OPENAI_MODEL` is routed by prefix to whichever provider is `ready`:

| Prefix       | Provider (NyxID slug)         |
| ------------ | ----------------------------- |
| `gpt-*`      | `openai` or `openai-codex`    |
| `claude-*`   | `anthropic`                   |
| `deepseek-*` | `deepseek`                    |
| `gemini-*`   | `gemini`                      |

Run `nocturne-format status` to see which providers are ready on your NyxID account.

### Environment variables (all optional)

| Variable                   | Default                      | Notes                                                        |
| -------------------------- | ---------------------------- | ------------------------------------------------------------ |
| `NOCTURNE_OPENAI_API_KEY`  | _(unset)_                    | Fallback when NyxID isn't available.                         |
| `NOCTURNE_OPENAI_BASE_URL` | `https://api.openai.com/v1`  | Fallback only. Ignored in NyxID mode.                        |
| `NOCTURNE_OPENAI_MODEL`    | `gpt-4o-mini`                | Shared by both modes; gateway routes by prefix.              |
| `NOCTURNE_OUT_DIR`         | `./out`                      | Where `--out` is not explicitly set.                         |

## Architecture

```
 your CLI / agent
      │
      ▼
 nocturne-format (~/.bun/bin)
      │
      ├── reads ~/.nyxid/{base_url,access_token}   ← preferred
      │       │
      │       └─▶ GET /api/v1/llm/status           (is there ≥1 ready provider?)
      │       └─▶ POST {gateway_url}/chat/completions
      │
      └── else uses NOCTURNE_OPENAI_API_KEY        ← fallback
              └─▶ POST {base_url}/chat/completions

     any OpenAI-compatible response  ──▶  Nocturne planner+renderer  ──▶  HTML file
```

Login is owned by the separate `nyxid` CLI. Nocturne reads tokens, never writes them — this keeps a single auth session shared across every NyxID-integrated tool.

## HTTP server (for NyxID downstream deployments)

Nocturne also ships as an HTTP service that sits behind the NyxID proxy at `/api/v1/proxy/s/nocturne/format`. The CLI above is independent of this path — most users never run the server. If you do:

```bash
bun install
cp .env.example .env        # fill in DATABASE_URL, NYXID_*, CHRONO_STORAGE_URL
bun run dev                 # http://localhost:7701
curl localhost:7701/health

# Apply the v0-alpha Supabase migration
psql "$(cat ~/.supabase-credentials)" -f db/migrations/001_nocturne_schema.sql

# Build a linux-x64 deploy binary
bun run build               # → dist/nocturne
```

The service exposes `POST /format` (accepts `{ content }`, returns `{ url }`), `GET /v/{slug}` (SSR), `GET /u/{slug}` (tiered-privacy archive), and share-token endpoints. See [AGENTS.md](AGENTS.md) for the full contract and the NyxID ecosystem layout.

## Status

v0-alpha — actively developed. See the [issue tracker](https://github.com/eanzhao/Nocturne/issues?q=label%3Av0-alpha) for active workstreams. Stack: **TypeScript + Bun + Hono + Supabase Postgres + chrono-storage + NyxID**.

---

Part of the [NyxID](https://github.com/ChronoAIProject/NyxID) ecosystem.
