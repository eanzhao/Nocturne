# Nocturne

把 LLM 回复变成一份可分享的报纸/杂志页面。一次 HTTP POST，换一个好看的 URL。

## 为什么

ChatGPT / Claude 的回复信息密度很高，但想把它分享给别人基本只剩两条路：截图，或者复制粘贴到飞书 / Notion 自己排。前者糊，后者费劲。

Nocturne 做一件事 —— 接收一段 LLM 输出，返回一个 URL：打开就是一份排好版的报纸/杂志风网页，桌面和手机都好看，可收藏、可分享、可长期访问。

## 方案概览

- **一个 HTTP 接口**：`POST /format` 收内容，返回 `{ url, expires_at }`
- **一个渲染站点**：`/v/{id}` 动态渲染页面，响应式 CSS，内容存储 + CDN 缓存
- **挂在 NyxID 下**：作为 [NyxID](https://github.com/ChronoAIProject/NyxID) 生态里的一个 downstream service。调用方通过 `/api/v1/proxy/s/nocturne/format` 调用，凭证由 NyxID 托管注入 —— Nocturne 自身不做用户鉴权系统，只校验来自 NyxID 的 Bearer token

## 架构草图

```
 client / agent
      │
      ▼                        (Nocturne 只需信任 NyxID 注入的凭证)
 NyxID proxy  ────────▶  Nocturne API  ──▶  内容存储 ──▶  渲染页面 /v/{id}
  (/api/v1/proxy/s/nocturne/format)              │
                                                 └─▶  (可选) 版面编辑 LLM
                                                       回调 NyxID 代理
```

技术栈倾向 **TypeScript + Next.js**：一份代码既是 API 也是 SSR 渲染层，部署走 Vercel / Fly.io / 自建 Docker 都轻。

## 待定：排版由谁来做

核心设计问题 —— 两种思路：

### A. 调用方固定排版
客户端在 POST 时就给出结构化内容（标题、导语、正文块、引文、小标题、图位），Nocturne 只做 **渲染**。
- ✅ 快、可控、零 LLM 成本
- ❌ 调用方需要理解版式，agent 得先想好怎么排

### B. Nocturne 内部调 LLM 做版面编辑
客户端只发原始内容，Nocturne **通过 NyxID 代理调用用户自己配置的 LLM**（用户在 Nocturne 设置里指定：`llm-openai` / `llm-anthropic` / `llm-deepseek` ...），让 LLM 做编辑工作：
- 起标题、导语、小标题
- 切版块、挑引文、决定重点与配图位置
- 输出结构化 JSON 交给渲染层

- ✅ 调用方零心智负担，质量上限高
- ❌ 慢、耗 token、需要用户预先绑定 LLM

### 当前倾向：A + B 混合，默认走 B

```
POST /format
{
  "content": "...",            // 必填：原始内容
  "layout": { ... },           // 可选：若提供，跳过 LLM 版面编辑
  "theme": "classic|modern"    // 可选：版式风格
}
```

- 不传 `layout` → 走 B（调 LLM 编辑版面），普通用户省心
- 传了 `layout` → 走 A（只渲染），agent 和追求速度/成本的调用方可控
- LLM 费用走用户自己的 NyxID 凭证，Nocturne 不替用户付钱

这样既保住"一条 POST 就能出图"的体验，也给高级用户留了口子。

## 状态

v0-alpha scaffolding in progress — see [issue tracker](https://github.com/eanzhao/Nocturne/issues?q=label%3Av0-alpha) for the active workstreams. Stack committed: **TypeScript + Bun + Hono + Supabase Postgres + chrono-storage + NyxID**.

## Run locally

```bash
bun install
cp .env.example .env        # fill in DATABASE_URL, NYXID_*, CHRONO_STORAGE_URL
bun run dev                 # http://localhost:7701
curl localhost:7701/health  # {"status":"ok","service":"nocturne",...}
```

Type-check:

```bash
bun run typecheck
```

Build a self-contained linux-x64 binary (used by the `deploy-nocturne` skill):

```bash
bun run build              # produces dist/nocturne
```

Apply the v0-alpha Supabase migration:

```bash
DATABASE_URL="$(cat ~/.supabase-credentials)" \
  psql "$DATABASE_URL" -f db/migrations/001_nocturne_schema.sql
```

## Local CLI (no NyxID, no Postgres, no chrono-storage)

For local use without the NyxID stack, render any content to an HTML file with an OpenAI-compatible API key:

```bash
export NOCTURNE_OPENAI_API_KEY=sk-...
echo "..." | bun run format                # stdin → ./out/<slug>.html
bun run format --in content.md              # file → ./out/<slug>.html
bun run format --in content.md --out ./page.html
```

Supported providers: any OpenAI-compatible chat/completions endpoint — OpenAI, OpenRouter, local `llama.cpp` server, etc. Configure via env vars:

- `NOCTURNE_OPENAI_BASE_URL` (default: `https://api.openai.com/v1`)
- `NOCTURNE_OPENAI_MODEL` (default: `gpt-4o-mini`)
- `NOCTURNE_OUT_DIR` (default: `./out`)

AI agents (Claude Code, Cursor, ...) can discover this CLI automatically via the `.claude/skills/nocturne-format` skill shipped in this repo.

---

Part of the [NyxID](https://github.com/ChronoAIProject/NyxID) ecosystem.
