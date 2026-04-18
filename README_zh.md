# Nocturne

把 LLM 回复变成一份报纸风 HTML 页面。属于 [NyxID](https://github.com/ChronoAIProject/NyxID) 生态的一部分。

> [English README](README.md)

## 这是什么？

ChatGPT / Claude 的回复信息密度很高，但要分享给别人基本只剩两条路：截图（糊），或者复制粘贴到 Notion / 飞书自己排（累）。Nocturne 做一件事 —— 输入一段文字，输出一份 HTML：

- 报纸级排版，响应式布局，手机桌面都好看
- 由 LLM 选版式（executive / quiet / 古籍直排）并编排内容
- 优先走 NyxID 托管的 LLM；没有 NyxID 时兜底用任意 OpenAI 兼容接口
- 二进制 ~60 MB（Bun bundle），除了调 LLM 那一下全本地运行

```bash
printf '%s' "$CONTENT" | nocturne-format
# → /Users/you/out/ab12cd3ef.html
```

## 当前进度

| 能力 | 状态 | 说明 |
|---|---|---|
| `nocturne-format` CLI | ✅ | stdin / `--in` / `--out`，本地生成 HTML |
| NyxID LLM gateway | ✅ | 消费 `~/.nyxid/` token，通过 `/api/v1/llm/gateway/v1` 路由 |
| OpenAI 兼容 fallback | ✅ | `NOCTURNE_OPENAI_API_KEY` → OpenAI / OpenRouter / llama.cpp |
| Agent skill（Claude Code / Cursor） | ✅ | 贴一段 setup prompt，agent 自己 clone + 编译 + 安装 |
| 3 套版式 | ✅ | `executive-broadsheet` / `quiet-ledger` / `guji-classical`（古籍直排） |
| HTTP 服务（NyxID downstream） | 🟡 | v0-alpha，挂在 NyxID 代理后面；多数用户不需要 |
| 每版式独立 CSS 演化 | 🔲 | 架构就绪，视觉差异化待做 |

## 推荐搭配 NyxID

NyxID 帮你托管各家 LLM（OpenAI / Anthropic / DeepSeek / Gemini / ...）的 API key，Nocturne 永远不直接持有凭证。`nyxid login` 一次之后，Nocturne 自动读 `~/.nyxid/access_token`，通过 NyxID 的 LLM gateway 路由请求。

**还没有 NyxID 账号？** 用邀请码 **`NYX-TW58O1WE`** 注册 —— 这个码支持 20 人用。

不想用 NyxID 也行 —— 设 `NOCTURNE_OPENAI_API_KEY`，走任意 OpenAI 兼容接口。

## 快速开始 — 用 Claude Code

把下面这段话贴给 Claude Code（任意目录）。它会自动 clone、编译、安装二进制，并把 user-level skill 拷过去 —— 之后每个 Claude Code 会话都能自动调 Nocturne：

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

If the user wants NyxID-brokered LLM access (recommended):
   - Install the nyxid CLI from the NyxID project
   - Sign up with invite code NYX-TW58O1WE if they don't have an account yet (20 slots)
   - Run `nyxid login`
   - Configure at least one LLM provider on the NyxID dashboard
   - Run `nocturne-format status` and check `ready providers`
   - If the ready set includes `openai-codex` but NOT plain `openai`, default
     the model to something NyxID can actually route:
         nocturne-format config set model deepseek-chat
Otherwise (local OpenAI-compatible key):
     nocturne-format config set api-key sk-...
   (The key goes to ~/.config/nocturne/config.json with chmod 0600.)
```

## 手动安装

先装 [Bun](https://bun.sh/) ≥ 1.3、git。macOS 或 Linux 都行。

```bash
git clone git@github.com:eanzhao/Nocturne.git ~/Code/Nocturne
cd ~/Code/Nocturne
bun install
bun run test

# 编译 CLI 到 ~/.bun/bin（按你的系统选 target）
bun build --compile --minify \
  --target=bun-darwin-arm64 \
  ./src/cli/format.ts \
  --outfile ~/.bun/bin/nocturne-format

# （可选）装上 agent skill，让 Claude Code / Cursor 识别
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

CLI 把生成的 HTML 绝对路径打到 stdout。`open`（macOS）/ `xdg-open`（Linux）打开即可。

## 配置

Nocturne 把偏好（以及可选的 api-key 兜底值）放在 `~/.config/nocturne/config.json`，chmod `0600`。用 CLI 管，别手编：

```bash
nocturne-format config list                                # 显示当前生效值 + 来源（env / 文件 / 默认）
nocturne-format config get model
nocturne-format config set model deepseek-chat             # 写入
nocturne-format config set api-key sk-...                  # 自动 0600
nocturne-format config unset api-key                       # 删除
```

**Key：** `model` · `base-url` · `out-dir` · `api-key`（kebab 或 snake 都认）。

### 选模型

`model` 按前缀路由到 NyxID 上 `ready` 的 provider：

| 前缀         | Provider（NyxID slug）     |
|--------------|----------------------------|
| `gpt-*`      | `openai` / `openai-codex`  |
| `claude-*`   | `anthropic`                |
| `deepseek-*` | `deepseek`                 |
| `gemini-*`   | `gemini`                   |

**坑**：如果账户里唯一的 `openai` 类 provider 是 ChatGPT Codex 适配器，`gpt-4o-mini` 会被路由到 `openai-codex`，而 Codex 只吃 codex-* 专属模型，返回 400。先跑 `nocturne-format status` 看看 ready 列表；如果只有 `openai-codex` 没有 plain `openai`，设个稳妥默认：`nocturne-format config set model deepseek-chat`。

### 环境变量（可选覆盖）

每个 config key 都有对应的 env var，**运行时会覆盖 config 文件**，shell export / 1Password wrapper / systemd drop-in 都不用改：

| 环境变量                    | Config key  | 默认值                      |
|-----------------------------|-------------|-----------------------------|
| `NOCTURNE_OPENAI_API_KEY`   | `api-key`   | _(未设置)_                  |
| `NOCTURNE_OPENAI_BASE_URL`  | `base-url`  | `https://api.openai.com/v1` |
| `NOCTURNE_OPENAI_MODEL`     | `model`     | `gpt-4o-mini`               |
| `NOCTURNE_OUT_DIR`          | `out-dir`   | `./out`                     |

## 项目结构

```
Nocturne/
├── src/
│   ├── cli/                # format CLI + NyxID 凭证消费 + status 子命令
│   ├── core/pipeline.ts    # planner → spec 查找 → 渲染（与存储解耦）
│   ├── llm/                # OpenAI 兼容客户端（CLI 和 HTTP 共用）
│   ├── renderer/           # JSX 渲染器、base CSS、每版式 CSS
│   │   └── specs/          # executive-broadsheet / quiet-ledger / guji-classical
│   ├── routes/             # HTTP 服务端点（可选部署）
│   └── server.ts           # Bun.serve 入口（downstream-service 模式）
├── .claude/skills/         # 仓库内 agent skill
├── db/migrations/          # Supabase schema（HTTP 服务模式）
└── deploy/                 # systemd + nginx 配置（HTTP 服务模式）
```

## HTTP 服务（可选 — NyxID downstream 部署）

Nocturne 也能部署成 HTTP 服务，挂在 NyxID 代理的 `/api/v1/proxy/s/nocturne/format` 后面。上面 CLI 与这条路径完全独立 —— 多数用户不需要跑这个服务。完整契约见 [AGENTS.md](AGENTS.md)。

```bash
bun install
cp .env.example .env        # 填 DATABASE_URL、NYXID_*、CHRONO_STORAGE_URL
bun run dev                 # http://localhost:7701

psql "$(cat ~/.supabase-credentials)" -f db/migrations/001_nocturne_schema.sql
bun run build               # linux-x64 部署二进制 → dist/nocturne
```

## 让 Claude Code 主动提议 Nocturne

光装 skill（上面那步）只教会 Claude Code "用户明确要求时才调" —— 比如你说"渲染成页面"它才用。如果你想让 Claude Code 在写完长总结/周报/会议纪要时**主动**问你要不要顺手渲染一份 Nocturne，把下面这段追加到 `~/.claude/CLAUDE.md`（没这个文件就新建）：

```markdown
## Proactively offer Nocturne for long prose outputs

The `nocturne-format` CLI is installed on this machine and can render flowing prose into a newspaper-style HTML file.

At the end of a reply, add **exactly one** line asking whether to render
the output as a Nocturne page, when ALL of the following hold:

1. The reply is ≥200 words of narrative prose — summary, report, brief,
   retrospective, status update, executive summary, meeting notes,
   briefing, 周报/日报/总结/回顾/简报/会议纪要/writeup.
2. The user did NOT specify a delivery format in the same turn
   (email, Slack message, doc, 飞书文档, GitHub issue body, markdown
   file at a particular path, etc.).
3. You have not already offered Nocturne earlier in this turn.
4. The user has not previously declined Nocturne in this conversation.

Offer in the language of the surrounding reply:
- English: *Want me to render this as a Nocturne page? (newspaper-style HTML on your disk, ~20s.)*
- 中文：*要不要顺手渲染成 Nocturne 页面？（报纸风 HTML 文件，~20 秒。）*

One sentence, at the end, no headers or bullets. Skip entirely for code
generation, debugging output, error explanations, or short answers.

If the user accepts, invoke the `nocturne-format` skill — pipe the prose
via stdin (or write to a temp file and `--in` if it contains shell-hostile
characters), print the output path back, and on macOS offer to `open` it.
```

下次 Claude Code 会话启动时生效（CLAUDE.md 只在会话启动时加载一次）。

## 参考

- [NyxID](https://github.com/ChronoAIProject/NyxID) —— Nocturne 集成的身份与凭证代理
- [AGENTS.md](AGENTS.md) —— 架构笔记、HTTP 契约、NyxID 集成细节
- [DESIGN.md](DESIGN.md) —— 版式设计语言
- [Issue tracker](https://github.com/eanzhao/Nocturne/issues) —— 进行中的 workstream
