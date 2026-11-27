# AGENTS.md —— 给非 Claude Code 的 agent（codex CLI 等）

本仓库是「智数协同平台」（Node.js + Express + SQLite + 原生前端，PM2 部署在内网服务器 192.168.1.100）。日常由 Claude Code 开发，规则写在 `CLAUDE.md`。**本文件只是索引**：规则全文以 `CLAUDE.md` 为准，两者不一致时按 `CLAUDE.md` 做，并告诉使用者。

使用者是产品负责人，不是工程师。决策点交给使用者，给出推荐项，不替使用者拍板。**始终用中文交流**，代码、路径和技术术语保持原文。

## 开工前按顺序读

1. `C:\Users\FY\.claude\CLAUDE.md` —— 全局协作原则（codex 审查的四阶段工作流、共享协作原则索引）。
2. 本仓库 `CLAUDE.md` —— 项目信息、文档治理、点名协议、多线并行开发、部署规则。
3. `C:\Users\FY\.claude\projects\E-------------\memory\MEMORY.md` —— 本项目的长期记忆索引，按需打开条目。
4. `docs/local/PROJECT_STATUS.md`（读主工作区 `E:\数据开发与治理规范手册` 里 main 分支这一份）—— 平台状态与待办权威源。
5. `E:\_backups\claude-memory\切换agent接手入口.md` —— 各项工作当前做到哪、各线的锚点入口、Claude Code 特有机制在别的工具里怎么替代、备份与还原。
6. 你要接手的那项工作的锚点或长任务摘要（`E:\projects\长任务摘要\index.html`，每段末尾的「下次开场」可直接作为接续指令）。

## 硬规则（详见 `CLAUDE.md` 对应节）

- **生产**：不在生产服务器上写入、停服或运行业务代码，不读生产凭证文件。部署只在使用者在场时按 `/deploy` 流程做（`.claude/skills/deploy/`），每次单独请示。
- **本机**：不碰 3000 端口和主工作区业务库。测试一律跑临时实例（`wbs-server/scripts/lib/test-env.js`）；全量验证是 `node wbs-server/scripts/run-verify-family.js`。
- **多线并行**：一条线对应一个 worktree（`E:\sdh-lines\<线名>`）、一个会话、一份锚点。线内不改 `docs/local/PROJECT_STATUS.md` 和 MEMORY.md；合入 main 只在使用者在场时用 `node scripts/lines/line.js merge` 做；线内不装包。
- **审查**：每个提交送 codex 审到 0 个 HIGH，归档到 `docs/local/codex审查记录/<模块>/`（精简版 + `_originals/*.final.txt` + README 时间线）。**如果你就是 codex，自己写的代码不能由自己审**，请使用者决定由谁审。
- **写法**：新端点与新表放 `wbs-server/routes/<模块>/`；页面引用本地 JS / CSS 写 `?v=auto`；测试临时文件放进程私有临时目录。
- **文档**：方案每个版本单独存文件；改文本用编辑工具，不用 shell 管线或 `node -e` 写文件；记录里的时刻用 `date` 现取。
- **凭证**：不写进日志、记忆和提交。`docs/local/servers.env` 含测试服务器凭据，不外传、不贴进对话。

## 与 Claude Code 机制的对应

- `CLAUDE.md`、项目记忆、skill 在 Claude Code 里自动加载；你需要按上面的顺序手动读。skill 在 `C:\Users\FY\.claude\skills\<名>\SKILL.md` 与本仓库 `.claude/skills/`，把正文当操作规程。`/remember`、`/report`、`/tidy-docs` 只在使用者明确要求时做。
- 子 agent、长任务心跳、互斥标记等机制的替代做法，见接手入口文档 §3。
- codex 审查脚本：`C:\Users\FY\.claude\skills\codex-cli-bridge\scripts\invoke_codex.ps1`。它把材料拼进提示词，在本仓库之外的目录以只读沙箱运行，所以本文件不影响 codex 审查的口径。
