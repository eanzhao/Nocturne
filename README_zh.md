# Nocturne

把任意 LLM 回复变成一份排版精美的报纸风 HTML 页面。

> [English README](README.md)

ChatGPT / Claude 的回复信息密度很高，但要分享给别人基本只剩两条路：截图（糊），或者复制粘贴到 Notion / 飞书自己排（累）。Nocturne 做一件事 —— 输入一段文字，输出一个 HTML：报纸级排版、响应式布局，任何设备上都好看。

```bash
printf '%s' "$CONTENT" | nocturne-format
# → /Users/you/out/ab12cd3ef.html
```

## 快速开始 — 用 Claude Code

把下面这段话贴给 Claude Code（任意目录），它会自动 clone、编译、安装二进制，并把 user-level skill 拷过去 —— 之后任意一个 Claude Code 会话都能自动调用 Nocturne：

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

> **推荐搭配 [NyxID](https://github.com/ChronoAIProject/NyxID) 使用。** NyxID 帮你托管各家 LLM（OpenAI、Anthropic、DeepSeek、Gemini、...）的 API key，Nocturne 永远不直接持有凭证。`nyxid login` 一次之后，Nocturne 自动读 `~/.nyxid/access_token`，通过 NyxID 的 LLM gateway 路由请求。没有 NyxID 的话，回落到 `NOCTURNE_OPENAI_API_KEY`，任意 OpenAI 兼容接口都能用。

## 手动安装

先装 [Bun](https://bun.sh/) ≥ 1.3、git。macOS 或 Linux 都行。

```bash
git clone git@github.com:eanzhao/Nocturne.git ~/Code/Nocturne
cd ~/Code/Nocturne
bun install

# 编译原生二进制到 ~/.bun/bin
bun build --compile --minify \
  --target=bun-darwin-arm64 \
  ./src/cli/format.ts \
  --outfile ~/.bun/bin/nocturne-format
# targets: bun-darwin-arm64 / bun-darwin-x64 / bun-linux-x64

# (可选) 装上 agent skill，让 Claude Code 自动识别
mkdir -p ~/.claude/skills/nocturne
cp .claude/skills/nocturne-format/SKILL.md ~/.claude/skills/nocturne/SKILL.md

nocturne-format status
```

## 用法

```bash
# stdin → ./out/<slug>.html
echo "本周回顾：CLI 上线、关了 3 个 PR..." | nocturne-format

# 从文件读
nocturne-format --in report.md

# 指定输出位置
nocturne-format --in report.md --out ~/Desktop/page.html

# 查看当前走哪条鉴权路径
nocturne-format status
```

CLI 把生成的 HTML 绝对路径打到 stdout。用 `open`（macOS）或 `xdg-open`（Linux）打开即可。

### 选模型

在 NyxID 模式下，`NOCTURNE_OPENAI_MODEL` 按前缀路由到对应的 provider：

| 前缀         | Provider（NyxID slug）        |
| ------------ | ----------------------------- |
| `gpt-*`      | `openai` 或 `openai-codex`    |
| `claude-*`   | `anthropic`                   |
| `deepseek-*` | `deepseek`                    |
| `gemini-*`   | `gemini`                      |

跑 `nocturne-format status` 可以看你 NyxID 账户上哪些 provider 是 `ready` 状态。

### 环境变量（都是可选）

| 变量                       | 默认值                        | 说明                                              |
| -------------------------- | ----------------------------- | ------------------------------------------------- |
| `NOCTURNE_OPENAI_API_KEY`  | _(未设置)_                    | 没登录 NyxID 时的兜底。                           |
| `NOCTURNE_OPENAI_BASE_URL` | `https://api.openai.com/v1`   | 兜底路径用；NyxID 模式下忽略此项。                |
| `NOCTURNE_OPENAI_MODEL`    | `gpt-4o-mini`                 | 两种模式共用；gateway 按前缀路由。                |
| `NOCTURNE_OUT_DIR`         | `./out`                       | `--out` 未指定时用这个目录。                      |

## 架构

```
 你的 CLI / agent
      │
      ▼
 nocturne-format (~/.bun/bin)
      │
      ├── 读 ~/.nyxid/{base_url,access_token}     ← 首选
      │       │
      │       └─▶ GET /api/v1/llm/status          （有没有 ≥1 个 ready provider？）
      │       └─▶ POST {gateway_url}/chat/completions
      │
      └── 兜底用 NOCTURNE_OPENAI_API_KEY            ← fallback
              └─▶ POST {base_url}/chat/completions

     OpenAI 兼容响应  ──▶  Nocturne planner + renderer  ──▶  HTML 文件
```

登录完全属于 `nyxid` CLI。Nocturne 只读不写 —— 多个 NyxID 集成工具共享同一套鉴权 session。

## HTTP 服务（NyxID downstream 部署用）

Nocturne 还能作为 HTTP 服务部署，挂在 NyxID 代理的 `/api/v1/proxy/s/nocturne/format` 后面。上面的 CLI 与这条路径完全独立 —— 多数用户永远不需要跑这个服务。如果你要：

```bash
bun install
cp .env.example .env        # 填 DATABASE_URL、NYXID_*、CHRONO_STORAGE_URL
bun run dev                 # http://localhost:7701
curl localhost:7701/health

# 应用 v0-alpha Supabase migration
psql "$(cat ~/.supabase-credentials)" -f db/migrations/001_nocturne_schema.sql

# 构建 linux-x64 部署二进制
bun run build               # → dist/nocturne
```

服务暴露 `POST /format`（收 `{ content }`，返 `{ url }`）、`GET /v/{slug}` (SSR)、`GET /u/{slug}`（分层权限归档）、以及 share-token 相关接口。完整契约和 NyxID 生态架构见 [AGENTS.md](AGENTS.md)。

## 状态

v0-alpha，持续开发中。进行中的 workstream 见 [issue tracker](https://github.com/eanzhao/Nocturne/issues?q=label%3Av0-alpha)。技术栈：**TypeScript + Bun + Hono + Supabase Postgres + chrono-storage + NyxID**。

---

属于 [NyxID](https://github.com/ChronoAIProject/NyxID) 生态的一部分。
