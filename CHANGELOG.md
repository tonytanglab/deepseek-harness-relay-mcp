# 更新记录

本文件记录尚未发布及已发布的 DeepSeek Harness 重要变化。设计理由和替代方案由 Agent Note 保存；这里仅记录交付事实、兼容影响和实际验证。

## Unreleased

<!--
新记录插入在本注释下方，按时间倒序排列。

写入前必须执行：
Get-Date -Format 'yyyy-MM-dd HH:mm'

标题格式：
### YYYY-MM-DD HH:mm | [类别] 简短结果

类别使用：
[FEAT] 新能力
[FIX] 缺陷修复
[SECURITY] 安全或权限修复
[PERF] 性能改进
[REFACTOR] 不新增能力的结构调整
[TEST] 测试基础设施
[DOCS] 文档或项目规范
[BUILD] 构建、依赖、发布或 CI
[BREAKING] 明确的不兼容变更

正文模板：
- **变更内容**：说明用户、模型、插件作者或维护者能够观察到的结果，以及权威实现路径。
- **影响范围**：列出 package、公共 API、配置、事件、磁盘/wire 格式或平台；不要罗列每个内部文件。
- **兼容与恢复**：仅在存在迁移、格式变化、中断恢复、回滚限制或已知边界时填写；不适用则省略。
- **Agent Note**：非平凡修改链接到拥有该决策的 Agent Note；机械修改可省略。
- **验证结果**：写明实际命令、PASS/FAIL/SKIP、平台及未覆盖项，不得把未运行检查写成通过。

示例结构：

### 2026-08-17 14:30 | [FIX] 修复某项行为
- **变更内容**：……
- **影响范围**：……
- **兼容与恢复**：……
- **Agent Note**：`.agents/notes/implemented/bug-fix/yyyy-mm-dd-topic.md`
- **验证结果**：`pnpm exec vitest run …` PASS；`pnpm run typecheck` PASS；真实 Windows 专项未运行。

规则：
1. 每次代码修改必须记录；同一用户结果的连续修改合并为一条，不按 commit 机械拆分。
2. 纯文档修改仅在影响用户、贡献流程或发布内容时记录。
3. 记录必须使用简体中文，最新条目位于 `Unreleased` 顶部。
4. 不回填无法从权威证据确认的历史版本或验证结果。
5. 失败、跳过和既有无关失败必须如实保留。
6. 发布时把本期条目移动到 `## <version> — YYYY-MM-DD`，随后保留空的 `Unreleased`。
-->

### 2026-08-18 13:38 | [FIX] 让 Codex 项目默认共用用户级 KEY
- **变更内容**：Codex MCP 现在保留工作区独立运行目录，同时把外层 Harness Home 的 `.credentials.yaml` 作为用户级凭据源传给每个托管 Web 服务；凭据解析按“进程环境变量 > 项目覆盖 > 用户级默认 > 环境文件”执行。模型设置页新增“所有项目 / 仅当前项目”保存范围，切换到所有项目时先写入用户级凭据再移除项目覆盖，删除单个项目的供应商配置也不再误删用户级 KEY。
- **影响范围**：`@deepseek-ai/dsh-credentials` 的可选 scope 元数据、`@deepseek-ai/dsh-credentials-local` 双文档解析与热更新、Host 凭据 RPC、Codex MCP/Bundle 环境传递、模型设置 UI 及相关中英文文档；凭据值不进入 RPC 新字段、日志或变更记录，既有公共字段与磁盘 YAML 格式保持兼容。
- **兼容与恢复**：直接启动 Harness 时仍沿用单一项目凭据文件；Codex 默认用户级路径为外层 `<DSH_HOME>/.credentials.yaml`，已有工作区文件继续作为更高优先级项目覆盖。升级插件后需新建 Codex 任务才能加载新版 MCP；如需回退，旧版本会忽略新增的可选 scope 字段并继续读取工作区文件。
- **Agent Note**：`.agents/notes/implemented/feature/2026-08-18-codex-global-credentials.md`
- **验证结果**：聚焦 Vitest 295 PASS、1 SKIP；真实 Windows 打包 Codex profile E2E 1/1 PASS，覆盖无继承环境变量时从用户级凭据文件启动；`npm run typecheck`、`npm run build`、`npm run lint:contracts-ready`、`npm run doc-sync`（28/28）及 `git diff --check` PASS。包含全部 MCP 测试的扩展聚焦集有 316 PASS、1 SKIP、1 个本次范围外既有事件保留顺序断言 FAIL；`npm run hygiene` 在首项 `rescope-vendor:check` 因本次范围外 26 个既有 pre-rescope token 残留 FAIL 并短路，后续 `knip`、`publint`、workspace constraints、许可、源码/产物 invariant、Cordis 配置、NodeNext 消费、运行时闭包与 vendored links 子门禁均单独 PASS。

### 2026-08-18 11:11 | [FIX] 让 Windows Harness MCP 取消有界收敛
- **变更内容**：Windows 正常进程树终止改为异步发起 `taskkill /T /F`，避免搜索超时或会话取消在 Web 事件循环内同步阻塞；`cancel_run` 在取消 RPC 失败或 `stopGraceMs` 内未取得持久终态与 Agent idle 时，会终止不健康的工作区 Web 服务树并返回失败快照。
- **影响范围**：`@deepseek-ai/dsh-subprocess-local` 的 Windows 正常终止路径、`@deepseek-ai/dsh-mcp-codex` 的取消结算，以及同一工作区共享 Web 进程中的并行运行；未修改会话事件、磁盘格式或 MCP 工具 schema。
- **兼容与恢复**：正常取消仍结算为 `cancelled` 并保留服务；无法收敛时，共享进程内所有活动 run 都明确失败，之后可通过相同工作区或持久 `sessionId` 启动新服务并续聊。Node `exit` 阶段仍使用同步进程树终止兜底。
- **Agent Note**：`.agents/notes/implemented/feature/2026-08-17-codex-mcp-visible-session-supervision.md`
- **验证结果**：MCP 监管器聚焦 Vitest 12/12 PASS；`pnpm run typecheck`、`pnpm run lint:contracts-ready`、真实 Windows 打包 MCP stdio/Web 进程树组合测试、三组翻译配对检查、`pnpm run doc-sync`（28/28）和 `pnpm run website:build` PASS。`pnpm run hygiene` 在首项 `rescope-vendor:check` 因本次范围外 26 个既有 pre-rescope token 残留 FAIL，并按聚合命令设计短路；`git diff --check` PASS。

### 2026-08-18 10:45 | [FIX] 保留纯 reasoning 的 Harness MCP 运行结果
- **变更内容**：`@deepseek-ai/dsh-mcp-codex` 的内联 assistant 投影优先返回回答 `text` 块；成功运行没有回答文本时，回退到可见的 `reasoning` 块，避免 Web 会话可见 K3 结果而 MCP `assistantText` 为空。
- **影响范围**：Harness 内置 Codex MCP 包及其快照语义；未修改工具 schema、会话事件、磁盘格式或外部薄插件连接配置。
- **兼容与恢复**：正常回答仍只返回 `text`；仅纯 reasoning 运行的既有空结果变为有界 UTF-8 文本，完整内容仍由 Web 会话保留。
- **Agent Note**：`.agents/notes/implemented/feature/2026-08-17-codex-mcp-visible-session-supervision.md`
- **验证结果**：该测试已并入 MCP 监管器聚焦 Vitest 12/12 PASS；`pnpm run typecheck`、`pnpm run lint:contracts-ready`、构建及真实 Windows MCP stdio/Web 组合验证 PASS；`pnpm run doc-sync`（28/28）和 `pnpm run website:build` PASS。

### 2026-08-17 19:22 | [FIX] 支持 Codex 对活动 Harness 运行实时纠偏
- **变更内容**：新增 `steer_run(runId, task)` MCP 工具，通过 Host `session.prompt(mode: 'steer')` 把持久用户消息插入当前 agent 轮次，并返回 `messageId` 与保持原 run/session 标识的最新快照；终态运行和已请求取消的运行会拒绝纠偏。
- **影响范围**：`@deepseek-ai/dsh-mcp-codex` 公共工具由十个增至十一个，Codex profile 的真实 stdio 流程、keyless transcript、核心与外部薄插件的中英文工作流同步更新；未修改 `agent-loop`、会话事件或磁盘格式。
- **兼容与恢复**：运行中使用 `steer_run`，终态后仍使用 `start_run.sessionId` 续聊；现有十个工具及快照字段保持不变。
- **Agent Note**：`.agents/notes/implemented/feature/2026-08-17-codex-mcp-visible-session-supervision.md`
- **验证结果**：聚焦 Vitest（MCP schema 与监管器）10/10 PASS；`pnpm run typecheck` PASS；真实 Windows MCP stdio/Web 子进程组合测试在主机权限下 PASS，覆盖纠偏、取消和完整进程树停止；keyless Codex profile 快照 PASS；workspace constraints PASS；三组中英文配对记录写入成功。`pnpm run doc-sync` 因依赖目录与新增锁文件不同步而在自动安装阶段 FAIL；随后冻结锁文件的本地依赖恢复在 Windows 上持续 30 分钟仍未完成并被停止，因此 `node_modules` 需重新安装，`doc-sync` 未能复跑。

### 2026-08-17 17:08 | [FEAT] 增加 Codex 调用 Harness 作为子任务的插件
- **变更内容**：新增 Codex MCP 插件，使 Codex 可以把 Harness 作为可见、可监管的子任务来调用。同时提供 `codex` profile 和十工具 MCP 服务；按规范化工作区监管独立 Web 子进程，返回会话深链，并提供事件驱动的运行状态、等待、幂等取消和 session ID 续聊。Web 子进程通过当前 Node 与绝对 `dsh` 入口直接启动，并以严格 UTF-8 JSON 发布 readiness，修复 Windows 内部 `npx.cmd` 启动缺陷。
- **影响范围**：`@deepseek-ai/dsh-mcp-codex`、`@deepseek-ai/dsh-codex`、Host `session.prompt` 回执、Web 启动参数与会话 URL、客户端初始会话选择、CLI profile 模板、Codex 使用文档；未改变会话事件或磁盘格式。
- **兼容与恢复**：`session.prompt` 成功值新增必需 `messageId`；MCP 重启后旧 run ID 不恢复，但持久 session ID 和工作区专属数据可继续使用。浏览器默认不自动打开。
- **Agent Note**：`.agents/notes/implemented/feature/2026-08-17-codex-mcp-visible-session-supervision.md`
- **验证结果**：聚焦 Vitest（MCP 监管、十工具 schema、Web readiness、深链、Host 回执及事件流重连补齐）PASS；真实打包 MCP stdio 组合测试在 Windows 上覆盖成功、取消、续聊及进程树停止并 PASS；新增 keyless transcript 快照 PASS；`pnpm run typecheck`、`pnpm run build`、`pnpm run doc-sync`（28/28）和 `pnpm run website:build` PASS；`publint`、`knip`、workspace constraints、许可、源码/产物 invariant、Cordis 配置、NodeNext 消费、运行时闭包及 vendored links 子门禁 PASS。`pnpm run hygiene` 的首项 `rescope-vendor:check` 因本次范围外 26 个既有 pre-rescope token 残留 FAIL，导致聚合命令短路；`git diff --check` 与 71 个改动文件 UTF-8 无 BOM 检查 PASS。外部薄插件的根目录和嵌套插件 manifest 校验 PASS。
