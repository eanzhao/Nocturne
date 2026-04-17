# Nocturne — Agent / Contributor Guide

一句话：Nocturne 把一段 LLM 输出变成一份可分享的排版页面。目前处于设计阶段，没有代码。

本文档给接手的 agent / 人记录 **仓库周边生态** 与 **当前设计倾向**，让你不用把周围几个项目都读一遍就能开工。

---

## 相关仓库（全部在 `~/Code/` 下，与本仓库平行）

| 目录 | 仓库 | 角色 | 对 Nocturne 的意义 |
|------|------|------|------|
| `../NyxID/` | [NyxID](https://github.com/ChronoAIProject/NyxID) | 自托管身份 + 凭证代理（Rust / Axum + MongoDB） | **Nocturne 的上游。** 提供用户鉴权、代理调用、身份传递、LLM Gateway。Nocturne 注册为 downstream service，通过 `/api/v1/proxy/s/nocturne/...` 被调用。<br>**生产实例**：API `https://nyx-api.chrono-ai.fun`，Dashboard `https://nyx.chrono-ai.fun`。 |
| `../chrono-storage/` | chrono-storage | 通用多桶文件存储（Bun / Hono + S3/MinIO） | **Nocturne 的存储层。** 纯 S3 抽象，无鉴权、无用户概念；靠上游服务约定 key 前缀来做隔离。 |
| `../aevatar/` | Aevatar | 多 Agent 协作运行时 + Workflow YAML 编排（.NET） | 潜在调用方之一。Aevatar workflow 里的某个角色产出长文时，可通过 NyxID 调 Nocturne 出成品页。 |

### NyxID 对 Nocturne 暴露的关键能力

- **代理调用**：调用方打 `POST /api/v1/proxy/s/nocturne/format`，NyxID 校验用户 → 注入凭证/身份 → 转发到 Nocturne。Nocturne 不需要自己做登录系统。
- **身份传递（identity propagation）**：NyxID 可在代理请求里附 `X-NyxID-User-Id` / `X-NyxID-User-Email` header，或短期 RS256 JWT (`X-NyxID-Identity-Token`，TTL 60s)。Nocturne 把这个 user id 当做**唯一数据归属键**。
- **LLM Gateway**：`/api/v1/llm/gateway/v1/...` OpenAI-compatible 接口，凭用户自己的 provider 凭证做路由。Nocturne 做"版面编辑"时用这个，费用与模型选择走用户的 NyxID 绑定，Nocturne 不替用户付钱。
- **Delegation Token**：Nocturne 作为 downstream service 可在服务配置里开 `inject_delegation_token` → NyxID 在代理调用时注入 5 分钟 TTL 的 `X-NyxID-Delegation-Token`，Nocturne 拿着这个反向调 NyxID 的 LLM Gateway / 其他 proxy。

### chrono-storage 的接口轮廓

- 单端口 HTTP：默认 `3805`。
- 关键操作（详见 `../chrono-storage/docs/Api.md`）：
  - `POST /api/buckets/{bucket}/objects?key=<key>&contentType=...`（body = 原始二进制，流式直传 S3）
  - `GET /api/buckets/{bucket}/objects?key=...`（通过 HEAD 拿 metadata；通过 `GET .../presigned-url` 拿可分享链接）
  - `DELETE /api/buckets/{bucket}/objects/batch?prefix=<prefix>`（按前缀批量删除，完美匹配"用户注销时清理"）
- **重要性质**：chrono-storage **没有鉴权层**，是受信内网服务。任何能访问到它的调用方都能读写任意 bucket。Nocturne 必须把它放在内网/同网段，不要直接暴露。

---

## Nocturne 的当前倾向设计（README 之外的补充）

### 存储层：用 chrono-storage，不新造轮子

原 README 列了 "KV / Postgres / R2" 三条备选。实际上 **chrono-storage 已经把 R2/S3 这条路径封装完毕**，直接用即可：

- **Bucket**：`nocturne`（单桶；多桶只会增加运维复杂度）
- **Key 约定**：`{nyxid_user_id}/{page_id}.html`
  - `nyxid_user_id` 来自 `X-NyxID-User-Id` header；整个 Nocturne 不自己发 user id，不自己存用户表
  - `page_id` 走 URL-safe 随机串（例如 base62(20) ≈ 120 bit 熵），足够不可猜
- **为什么这样分**：
  - 用户注销/撤回 → 一条 `DELETE .../batch?prefix={user_id}/` 清干净
  - "列出我的所有页面" → `GET .../objects?prefix={user_id}/`
  - 存储成本、归属审计天然清晰

### 公开 URL 如何设计

用户提问："公开 URL 里要暴露 user id 吗？"
- `/v/{user_id}/{page_id}` —— 简单，但把 NyxID UUID 露在外面，用户在社交分享里会看到自己的 id。
- `/v/{page_id}` —— 干净，但需要一个"slug → (user_id, key)"的索引。
- **当前倾向**：URL 只出 `{page_id}`；索引用 **一个 JSON 清单对象**（每用户一份：`{user_id}/_index.json`，列出该用户所有 page_id）+ **一条全局 slug→owner 映射**（可以是另一个 bucket 或一个小 KV）。如果嫌索引麻烦，可以把 user_id 嵌进 page_id 的 opaque 编码里（HMAC 绑定），渲染时解出来去 chrono-storage 拿文件。最终选型留到实现前再定。

### 渲染路径

两种：
1. **Nocturne 读文件 + 返回 HTML**：控制力最强，可以注入最新 CSS、做 A/B、统计。写路径是 PUT 到 chrono-storage，读路径是 Nocturne fetch 后响应。
2. **重定向到 presigned URL**：最便宜，`GET /v/{id}` 302 到 chrono-storage 的 presigned URL，加上 CDN 基本零成本。缺点是改样式要重写所有历史对象。

**当前倾向**：选 1。代码路径简单得多（Next.js / Bun Hono 一个 handler），并且未来如果要做"升级 CSS 就立刻应用于全部历史页"会感谢今天的自己。

### 接口契约（拟定）

```
POST /format                          (内网) 或 /api/v1/proxy/s/nocturne/format (经 NyxID)
Headers: X-NyxID-User-Id: <uuid>      (由 NyxID 注入；直接内网调用时测试用)
Body:
{
  "content": "...",              // 必填
  "layout": { ... },             // 可选；给了就跳过 LLM 版面编辑
  "theme": "classic|modern"
}

Response:
{ "url": "https://nocturne.example.com/v/<page_id>", "expires_at": "..." }
```

`/v/{page_id}` 做 SSR 或读 chrono-storage 现成 HTML。

### 版面编辑（README 里的 A/B 问题）

- 不传 `layout` → Nocturne 通过 `X-NyxID-Delegation-Token` 回调 NyxID 的 LLM Gateway，拿结构化 JSON → 渲染 → 存 chrono-storage
- 传了 `layout` → 跳过 LLM，直接渲染 + 存

LLM token 成本走用户自己的 NyxID 凭证，Nocturne 无需托管 API key。

---

## 架构草图（修订版）

```
 caller (aevatar / agent / 网页)
       │
       ▼  POST /api/v1/proxy/s/nocturne/format
   NyxID  ─── 身份注入 (X-NyxID-User-Id, delegation token)
       │
       ▼
  Nocturne API
       │
       ├── (可选) 调 NyxID LLM Gateway 做版面编辑
       │
       ├── PUT 到 chrono-storage: nocturne/{user_id}/{page_id}.html
       │
       └── 返回 { url: "/v/{page_id}", expires_at }

 访客
       │
       ▼  GET /v/{page_id}
  Nocturne SSR ──► chrono-storage GET object ──► HTML 响应
```

---

## 状态 / 下一步

- [ ] 在 NyxID 上注册 `nocturne` 为 downstream service（带 `inject_delegation_token`，`identity_propagation=headers`）
- [ ] chrono-storage 里建 `nocturne` bucket
- [ ] 敲定 `POST /format` OpenAPI 契约
- [ ] 敲定 slug → (user_id, key) 的解法（HMAC 方案 vs 索引方案）
- [ ] 最小渲染模板（一种风格先跑通）
- [ ] 项目脚手架（倾向 TypeScript + Bun + Hono；与 chrono-storage 技术栈一致，部署口径也一致）

---

## 给 agent 的提示

- 写代码前读这三份：`../NyxID/docs/API.md`、`../NyxID/docs/DEVELOPER_GUIDE.md`、`../chrono-storage/docs/Api.md`。
- 需要用户 id 时 **只** 从 `X-NyxID-User-Id` header 拿；不要自己发 id、不要信任 body 里的 user 字段。
- 写存储代码时记得 chrono-storage 没鉴权 —— 别把它的地址写到任何对外文档里，别让它的端口监听到公网。
- 技术栈与 chrono-storage 对齐（TypeScript + Bun）能复用 ops 约定（Dockerfile 规约、`/health`、`/openapi.json` 等参见 `../chrono-storage/CLAUDE.md`）。
