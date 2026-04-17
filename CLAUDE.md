# CLAUDE.md

本项目的架构、生态位、相关仓库（NyxID / chrono-storage / aevatar）、当前设计倾向与下一步工作项，全部放在 [AGENTS.md](AGENTS.md)。

动手前请先读那份文档 —— 特别是：
- **NyxID 的身份传递约定**：`X-NyxID-User-Id` header / delegation token 的使用
- **chrono-storage 的 key 约定**：单桶 `nocturne`，key = `{nyxid_user_id}/{page_id}.html`
- **chrono-storage 没有鉴权**：只能内网访问
