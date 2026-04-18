# Nocturne

Turn an LLM reply into a newspaper-style HTML page. Part of the [NyxID](https://github.com/ChronoAIProject/NyxID) ecosystem.

> [中文版 README](README_zh.md)

## What is this?

ChatGPT and Claude produce dense, structured content, but the only ways to share it are a screenshot (blurry) or a copy-paste into Notion / Lark (tedious). Nocturne does one thing: takes raw text in, writes an HTML file out.

- Broadsheet typography, responsive layout, device-agnostic
- LLM picks the spec (executive / quiet / 古籍) and composes the page
- Works with NyxID-brokered providers (recommended) or any OpenAI-compatible endpoint
- The binary is ~60 MB Bun bundle, runs offline except for the LLM call

```bash
printf '%s' "$CONTENT" | nocturne-format
# → /Users/you/out/ab12cd3ef.html
```

## Current status

| Capability | Status | Notes |
|---|---|---|
| `nocturne-format` CLI | ✅ | stdin / `--in` / `--out`, local HTML generation |
| NyxID LLM gateway | ✅ | Reads `~/.nyxid/` tokens, routes through `/api/v1/llm/gateway/v1` |
| OpenAI-compatible fallback | ✅ | `NOCTURNE_OPENAI_API_KEY` → OpenAI / OpenRouter / llama.cpp |
| Agent skill (Claude Code / Cursor) | ✅ | Paste the setup prompt — automatic clone + build + install |
| 3 aesthetic specs | ✅ | `executive-broadsheet` / `quiet-ledger` / `guji-classical` (vertical CJK) |
| HTTP service (NyxID downstream) | 🟡 | v0-alpha; lives behind the NyxID proxy, most users don't run it |
| Per-spec CSS evolution | 🔲 | Architecture in place, visual differentiation pending |

## Recommended: pair with NyxID

NyxID brokers your LLM credentials (OpenAI, Anthropic, DeepSeek, Gemini, …) so Nocturne never touches raw API keys. After `nyxid login`, Nocturne reads `~/.nyxid/access_token` automatically and routes through NyxID's LLM gateway.

**Don't have NyxID yet?** Sign up with invite code **`NYX-TW58O1WE`** — 20 slots available on this code.

Without NyxID, Nocturne falls back to `NOCTURNE_OPENAI_API_KEY` against any OpenAI-compatible endpoint.

## Quickstart — Claude Code

Paste the following into Claude Code (any directory). It clones, builds, installs the binary, and copies the user-level skill so every future Claude Code session can invoke Nocturne automatically.

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
   - Sign up with invite code NYX-TW58O1WE if they don't have an account yet (20 slots)
   - Run `nyxid login`
   - Configure at least one LLM provider on the NyxID dashboard
Otherwise suggest exporting NOCTURNE_OPENAI_API_KEY=sk-... for the fallback path.
```

## Manual setup

Prereqs: [Bun](https://bun.sh/) ≥ 1.3, git, macOS or Linux.

```bash
git clone git@github.com:eanzhao/Nocturne.git ~/Code/Nocturne
cd ~/Code/Nocturne
bun install
bun run test

# Compile the CLI into ~/.bun/bin (pick your target)
bun build --compile --minify \
  --target=bun-darwin-arm64 \
  ./src/cli/format.ts \
  --outfile ~/.bun/bin/nocturne-format

# Install the agent skill (optional — needed only for Claude Code / Cursor)
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

The CLI prints the absolute path of the generated HTML to stdout. Open it with `open` (macOS) or `xdg-open` (Linux).

## Picking a model

`NOCTURNE_OPENAI_MODEL` is routed by prefix to whichever provider is ready on your NyxID account:

| Prefix | Provider (NyxID slug) |
|---|---|
| `gpt-*` | `openai` / `openai-codex` |
| `claude-*` | `anthropic` |
| `deepseek-*` | `deepseek` |
| `gemini-*` | `gemini` |

Run `nocturne-format status` to see your ready providers.

## Environment variables (all optional)

| Variable | Default | Notes |
|---|---|---|
| `NOCTURNE_OPENAI_API_KEY` | _(unset)_ | Fallback when NyxID isn't available. |
| `NOCTURNE_OPENAI_BASE_URL` | `https://api.openai.com/v1` | Fallback only; ignored in NyxID mode. |
| `NOCTURNE_OPENAI_MODEL` | `gpt-4o-mini` | Shared by both modes; gateway routes by prefix. |
| `NOCTURNE_OUT_DIR` | `./out` | Where output goes when `--out` is not set. |

## Project structure

```
Nocturne/
├── src/
│   ├── cli/                # format CLI + NyxID auth consumer + status subcommand
│   ├── core/pipeline.ts    # planner → spec lookup → render (storage-agnostic)
│   ├── llm/                # OpenAI-compat client (shared by CLI + HTTP)
│   ├── renderer/           # JSX renderer, base CSS, per-spec CSS
│   │   └── specs/          # executive-broadsheet / quiet-ledger / guji-classical
│   ├── routes/             # HTTP-service endpoints (optional deploy)
│   └── server.ts           # Bun.serve entry for downstream-service mode
├── .claude/skills/         # Repo-local agent skill
├── db/migrations/          # Supabase schema (HTTP-service mode)
└── deploy/                 # systemd + nginx configs (HTTP-service mode)
```

## HTTP service (optional — NyxID downstream deployment)

Nocturne also ships as an HTTP service that sits behind the NyxID proxy at `/api/v1/proxy/s/nocturne/format`. The CLI above is independent of this path — most users never run the server. See [AGENTS.md](AGENTS.md) for the full contract.

```bash
bun install
cp .env.example .env        # fill DATABASE_URL, NYXID_*, CHRONO_STORAGE_URL
bun run dev                 # http://localhost:7701

psql "$(cat ~/.supabase-credentials)" -f db/migrations/001_nocturne_schema.sql
bun run build               # linux-x64 binary → dist/nocturne
```

## References

- [NyxID](https://github.com/ChronoAIProject/NyxID) — the identity + credential broker Nocturne integrates with
- [AGENTS.md](AGENTS.md) — architecture notes, HTTP contract, NyxID integration details
- [DESIGN.md](DESIGN.md) — design language for the aesthetic specs
- [Issue tracker](https://github.com/eanzhao/Nocturne/issues) — active workstreams
