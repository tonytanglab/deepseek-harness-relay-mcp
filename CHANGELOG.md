# CHANGELOG

## 0.2.2

### 2026-08-20 11:57

- 新增仓库级 `harness-relay` Codex Marketplace，通过 npm 包 `harness-relay-mcp` 分发 `deepseek-harness-relay` 插件，并将 Marketplace 包版本纳入 `version.json` 单一真源同步。
- 中英文 README 明确区分 Harness 内部 bundle 与 Codex 外部调用层，补充 GitHub Marketplace 安装、升级、新任务加载、只读验证及可直接交给 AI 的安全安装提示词。
- 增加 Codex Marketplace 发布契约和 Harness 安装边界回归门；Marketplace 文件不进入 npm 发布白名单，不改变包根 `dsh.bundle`、`cordis.patch.yml` 或 Harness `web` profile 的内部安装方式。

## 0.2.1

### 2026-08-20 01:52

- 中英文 README 新增针对性定位说明，明确本项目是第三方 DeepSeek Harness MCP 控制平面，不是直接 DeepSeek 模型包装器，也不宣称官方背书。
- 增加当前官方 Harness、简单 DeepSeek MCP 与 Harness Relay MCP 的能力对比、适用场景和非适用场景，并显式标注对比核验日期为 2026-08-20。
- 补充边界声明：当前官方 `mcp-client` 是 Harness 消费外部 MCP 的接入方向；Relay 仅支持本机回环 Host，且不能保证 Codex 或其他客户端的批准与 auto-review 行为。

### 2026-08-19 23:51

- 增加 npm 官方安装主路径，中英文 README 统一提供 `dsh plugin --profile web add harness-relay-mcp`、配置检查与 profile 启动命令，并保留 Release tarball 作为离线安装方式。
- 将版本单一真源提升至 `0.2.1`，用于同步 npm 包版本、GitHub 标签和 GitHub Release，并增加全新隔离 profile 的 npm 安装验证。

## 0.2.0

### 2026-08-19 23:30

- 完成 `Harness Relay MCP` 0.2.0 开源发布准备：版本单一真源切换为稳定版 `0.2.0`，补齐 GitHub 仓库、问题反馈、主页、作者与检索关键词元数据。
- 新增发布仓库忽略规则，明确排除依赖、运行态、构建目录、覆盖率、日志和本地打包产物；发布包继续由自动构建生成并作为 Release 附件交付。

### 2026-08-19 23:22

- 将产品显示名称统一为 `Harness Relay MCP`，npm/Harness 根模块改为无作用域、无子路径的 `harness-relay-mcp`，使 Harness 插件列表不再显示 `relay/harness` 斜杆名称。
- 将 Cordis entry id、插件名、MCP Server ID 及 Codex、Claude Code、Cursor、OpenCode 生成配置统一为 `harness-relay-mcp`；Codex 插件 ID 保留 `deepseek-harness-relay` 以兼容现有 personal marketplace。
- 包根入口改为 Harness bundle，新增 `./standalone` 导出和 `harness-relay-mcp`、`harness-relay-mcp-proxy` 命令；旧 `dsh-relay` 命令、状态目录和环境变量继续作为兼容层保留。
- 更新中英文 README、Codex 显示元数据和发布契约测试，新增无斜杆模块名与根入口回归门。

### 2026-08-19 22:55

- 完成 001C–001H 内部控制面：新增 schema v3 状态权威、Host 生命周期 lease、endpoint descriptor、Harness 官方 InProcess ApiProxy/原生权限适配、认证回环 Streamable HTTP 和无业务状态 stdio proxy。
- 新增 `@deepseek-ai/dsh-relay/harness` Cordis bundle 与三套预构建产物；Harness 运行时 peers 保留版本约束并标记为可选，使 standalone 安装不产生错误的缺 peer 警告。
- 加入事件驱动监控加速、durable-history rebase、乱序/重复/gap/overflow/断流恢复、attention 通知及 polling 降级；插件卸载或 Host 重启不会取消已提交运行。
- 修复实际 `rpcId` 关联、稳定 authority 身份、陈旧 owner 安全恢复、principal 级幂等隔离、Host 重启后的 proxy 自动恢复和启动服务并发去重。
- 完成隔离 profile 的官方安装、配置加载、MCP 调用、DeepSeek V4-Flash/MAX 参数选择、Web URL 打开、异常终止恢复和卸载测试，并将 bundle 安装到真实 Harness `web` profile；Harness 产品源码保持未修改。
- 更新中英文 README、Harness 委派 Skill、001 计划完成记录、发布白名单与自动化门；全量 116 项测试、严格 TypeScript、MCP smoke 和包校验通过。

### 2026-08-19 22:08

- 完成内部控制面计划 001A/001B：新增语义化 `HarnessGatewayFacade` 与可替换 Provider，HTTP 传输细节和通用 `call/callRemote` 不再泄漏给 Broker；模型、工作区、会话、提示、取消和能力发现统一经模块根出口调用。
- 新增独立 `PermissionGatewayFacade` 与 external provider，将 Harness 原生三档权限的读取、选择和回读确认从权限租约生命周期中解耦，并保持稳定的拒绝与不可用错误。
- 将 `MonitoringFacade` 提升为 composition root 可注入的 authority 级共享实例；增加 Host golden contract、替代 Provider、权限和模块物理边界自动测试。
- 修复 Harness 插件注入的 runtime-context `user/message` 被误判为下一轮用户提示的问题；现在只以带用户 `rpcId` 的消息划分 Relay 所属 turn，可正确对账模型额度错误等终态事件。
- 更新 001 计划的二次审查与执行记录；本轮未修改 DeepSeek Harness 产品源码，后续 state v3、Cordis bundle、HTTP MCP route 和 stdio proxy 仍按阶段门禁后置。

### 2026-08-19 21:58

- 扩展 `delegate-to-deepseek-harness` Skill：在保留默认只读审查模式的同时，允许用户明确委派 Harness 模型通过原生 `workspace-write` 权限完成受限工作区修改，并补充权限升级、并发编辑、脏工作树保护及落盘结果复核要求。

### 2026-08-19 20:54

- 修复 Codex 官方 cachebuster 与版本号单一真源冲突：新增显式 `sync-version --from-plugin` 发布模式，将官方工具生成的 manifest 版本一次性采纳到 `version.json` 和 npm 包，后续日常同步仍只以 `version.json` 为真源。

### 2026-08-19 20:51

- 新增运行停滞检测：活动运行超过可配置时间没有持久事件进展时进入 `needs_attention/run_stalled`，恢复进展后自动回到运行态；`get_run_summary` 同步输出可执行的下一步。
- 新增只读 `reconcile_permissions`，用于显式重试恢复过期或中断的 Harness 原生权限租约；新建会话和复用会话统一纳入租约所有权与终态恢复。
- 修复跨调用方结果串线、取消明确失败后状态未回滚、prepared 操作重复提交及未知 steer/cancel 无法持久对账的问题；Assistant 结果严格限定在当前用户 turn。
- 强化状态落盘与并发一致性：临时文件和目录执行持久化同步，幂等操作在锁内原子认领，会话提交使用跨进程独占租约，终态与进度游标保持单调。
- 补充生命周期恢复、权限租约、运行停滞/恢复、跨进程幂等认领和多进程写入测试，并更新中英文使用说明。

### 2026-08-19 20:43

- 修复工作区授权真源错误：未配置显式 roots 时改用 Harness `workspace.list` 注册表，不再把 `host.describe.cwd` 误当唯一授权目录；显式 roots 仍保持严格边界，已登记工作区直接复用且不重复调用 `workspace.create`。
- 新增独立 `workspace-routing` 与 `session-routing` 模块，以及只读 `list_workspaces`、`list_workspace_sessions` 工具；`start_run`/`start_review` 支持显式 `sessionId` 或 `sessionMode: latest-idle`，默认继续创建隔离的新会话。
- 补充已登记项目、显式 roots、未登记目录、归档/运行中/空白会话和 MCP 参数转发回归测试，并同步更新中英文 README 与 Harness 委派 Skill。

### 2026-08-19 20:28

- 修复多 MCP 进程共享状态文件时的旧快照回退：停止服务、终态运行、待处理状态、操作和权限租约均按单调规则合并；幂等键在锁内原子占位；跨进程锁改用随机所有者令牌并在释放前核验，禁止按文件年龄盲目接管。
- 修复复用会话权限生命周期：提示词已接受但后续对账失败时不再提前恢复权限；明确拒绝、会话丢失、取消和 Admission 超时统一执行终态恢复；过期租约启动时进入 `needs_attention`。
- 增加 `get_operation` 与 `reconcile_operation`，支持按持久 `rpcId` 对账不确定的 start、reply、steer 和 cancel；prepared 运行会使用原 RPC ID 继续首条提示词提交。
- Assistant 结果改为按 turn 事件顺序聚合全部文本；增加历史分页无进展和最大页数保护，以及相同工作区并发 `start_service` 去重。
- 正式暴露只读 `setup_plan`、`setup_doctor`、`get_run_summary` 和 `read_notifications` MCP 工具，修复通知深拷贝、平台不一致校验并明确 OpenCode V2 配置。
- 强化发布门：`prepack` 和 MCP smoke 强制先做严格 TypeScript 检查与构建，发布白名单拒绝敏感文件、运行产物、符号链接及超过 8 MiB 的包内容。
- 默认工作区策略改为使用 Harness 原生工作区目录，允许调用已登记但不在 Host `cwd` 下的项目；显式授权根目录仍保持严格包含校验。
- 新增权限失败点、未知操作恢复、prepared 重放、服务并发去重、六进程状态写入、锁所有权和旧状态回退自动化测试；同步更新中英文 README。

### 2026-08-19 19:33

- 为 `start_run`、`reply_run`、`steer_run` 和 `cancel_run` 增加持久操作日志、调用方幂等键、结构化未知状态及恢复指引。
- 增加固定原生只读权限的 `start_review`；完全访问要求显式确认，复用会话通过权限租约记录并在终态恢复原权限。
- 状态格式升级到 schema v2，加入完整字段校验、v1 迁移、损坏隔离、跨进程文件锁和原子写入；`max-tokens` 结果改为 `incomplete`。
- 新增 Codex、Claude Code、Cursor、OpenCode 的只读配置规划 Facade，以及拒绝将 `pnpm.exe`/`pnpm.cmd` 当作 Node ESM 运行时的启动器校验。
- 新增监控投影 Facade、有界通知缓冲区、游标过期与重同步元数据，以及通知不受支持时的轮询降级能力。
- 更新中英文 README 与 Harness 委派 Skill，并补充幂等、危险权限、状态迁移和损坏恢复自动化测试。

## 0.1.5 - 2026-08-19

- 修复同一 Harness 会话并发启动时的占用竞态，初始化失败时仅释放当前运行持有的占位。
- 修复取消 RPC 失败后仍残留 `cancelRequested` 的误分类问题，并让 `wait_run` / `cancel_run` 的内部 RPC 与轮询共同服从截止时间。
- 恢复 `RunSnapshot.finishedAt` 类型，新增 TypeScript 类型检查命令及并发、取消失败、超时预算回归测试。
- Web 插件包为 `dsh-agents-relay`，MCP Server ID 为 `dsh-relay`。
- `turn/end` 原因按 Harness 协议映射；阻塞、中断及 token 上限不再误报成功。
- `start_run` 拒绝复用已有活动 Relay 运行、错误工作区或子代理会话。
- `cancel_run` 对终态运行保持幂等，并等待被取消 turn 实际结束。
- `wait_run`、`get_run`、`list_runs` 在 Harness Web 短暂不可用时保留运行快照并报告刷新错误。

## 0.1.4 - 2026-08-19

- `wait_run`、`get_run`、`list_runs` 通过 `session.history` 与 `turn/end` 确认真实终态。
- 取消操作仅在 `session.cancel` 成功后写入已取消状态。
- 工作区根目录先解析再校验，禁止通过 `..` 逃逸授权边界。
- `K3 MAX` 与 `DeepSeek V4 Flash MAX` 解析为模型加 `max` 推理强度，而不是不同模型 ID。

## 0.1.3 - 2026-08-19

- MCP stdio 可连接已运行的 Harness Web，使 Codex、Cursor 与 Claude Code 共享 Relay 服务。
- `start_run` 可在提示前选择模型，并返回可打开的 Harness Web 会话链接。
- 增加 Cursor JSON 与 Codex TOML 的 MCP 配置助手。

## 0.1.2 - 2026-08-19

- 将 MCP 启动包同步至 DeepSeek Harness `0.1.0-rc.7`，并验证真实 Web profile 安装与运行。
- 修正 Harness peer 依赖兼容范围并关闭错误的 peer 自动安装。

## 0.1.0 - 2026-08-18

- 发布 Web-profile MCP 配置助手：诊断 launcher，并为 Codex、Cursor、Claude Code 写入 MCP 配置。
