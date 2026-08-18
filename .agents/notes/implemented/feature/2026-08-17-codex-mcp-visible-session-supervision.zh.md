# Agent Note: Codex MCP 可见会话监管

Status: implemented

[English](2026-08-17-codex-mcp-visible-session-supervision.md) | 中文

## 问题

Codex 需要一条可见、可控制的 Harness 委托路径，同时不能在外部集成中重复实现 Harness 的会话和进程所有权。此前的外部服务器轮询固定历史尾部，并在内部 spawn `npx.cmd`；Windows 上的 Node 24 会在 `shell: false` 下拒绝该 shell shim，而 `shell: true` 会削弱参数和进程树控制。任务回执也缺少持久消息标识，无法区分本次工作、既有历史和之后的 Web steering（中途引导）。

## 决策

`@deepseek-ai/dsh-mcp-codex` 和 `codex` profile 归 Harness 所有。每个规范化工作区拥有一个受监管的 Web profile 进程和一个工作区专属 Harness home。监管器通过 `ctx.subprocess` 启动当前 Node 可执行文件、继承的执行参数和当前 `dsh` 绝对入口；内部不使用 `npx`、`.cmd` 或 shell。Web 子进程在 Loader 结算后输出一条严格 UTF-8 `dsh/web-ready` JSON 记录，其中包含 loopback 根 URL。浏览器打开是针对已校验 URL 的独立显式工具操作。

Host `session.prompt` 返回持久用户 `messageId`。MCP 监管器在接纳前打开 Host 事件流，在 run 发布前缓冲竞态，并把一次运行定义为：从该已接纳消息开始，到其工作被消费、轮次进入终态且整个 agent 处于 idle 为止。该区间内的 Web steering 归本次运行。MCP 的 `steer_run` 工具使用同一接纳路径并指定 `mode: 'steer'`，返回纠偏消息的持久 `messageId`，同时保留原 run 和 session 标识。终态运行或已请求取消的运行会被拒绝；agent 活动状态并发变化时以 Host 为准。继续会话时会验证工作区归属、idle 状态和不存在其他 MCP 运行。`completed` 轮次成功；用户取消导致的中止映射为取消；其他终态或工作被丢弃都映射为失败。

内联 assistant 投影会收集本次运行的回答 `text` 块。如果不存在回答文本，则改为收集可见的 `reasoning` 块；部分提供方路由可能以 reasoning 作为唯一可读的 assistant 内容并完成运行。字节上限在完成该选择后应用，Web 会话仍保留从完整事件派生的 transcript（文本记录）。

Host 提示词接纳不解释斜杠命令：浏览器在提交提示词前已经通过独立的 `command.execute` remote 执行命令。因此 MCP 任务始终按字面提交，包括以 `/` 开头的文本，不需要为 `session.prompt` 增加第二套命令分发开关或命令结果联合。

关闭时先请求取消，在有界期限内等待持久终态和 idle 证据，再中止事件流、终止受管进程树并确认完整退出。`stop_service` 和插件 dispose（资源释放）使用同一序列。Windows 正常终止会启动 `taskkill /T /F`，但不在 Node 事件循环中同步等待；只有进程 `exit` 兜底保留同步形式，因为 Node 无法在那里完成异步工作。

`cancel_run` 也拥有相同的有界收敛要求。已接纳的取消如果没有在 `stopGraceMs` 内达到持久化轮次终态和 Agent idle，或者取消 RPC 失败，就证明该共享 Web 进程不健康。监管器会终止该工作区进程树，把服务标记为失败，并让其中其余活动 run 失败。之后的启动会在相同持久化工作区数据上创建新进程。Service ID 和 run ID 只在 MCP 进程内有效；持久 session ID 和工作区数据在 MCP 重启后仍然存在。Web 客户端把 `?sessionId=` 视为权威初始选择，并保留未知 ID 以显示其 history 错误，而不是静默跳转。

## 考虑过的替代方案

**把运行时保留在外部 Codex 插件。** 否决，因为这会在真源仓库之外重复 Host 事件解释、会话所有权和子进程拆卸。外部插件只保留固定版本的薄启动器和工作流 skill（技能）。

**在 Windows 上 spawn `npx.cmd` 或启用 `shell: true`。** 否决，因为前者在受影响运行时中不是可直接执行的 Node 子进程，后者会把引用和后代进程所有权交给 shell。已经运行的 CLI 能提供完整的直接自启动描述符。

**轮询最近固定数量的历史记录。** 否决，因为较长或快速完成的运行可能让接纳或终态证据落在窗口之外。事件流承载实时证据；有界的向后分页会补齐接纳到发布之间的竞态，并在已建立事件流重连后对账遗漏的持久事件。

## 后果

Codex 可以立即展示稳定的实时会话链接，在不轮询历史的情况下等待，插入带持久回执的实时纠偏，幂等取消，并在终态结算后按 ID 继续持久会话。取消不能收敛时，会牺牲该工作区进程中的所有活动 run，确保控制平面和 OS 子进程不会继续卡住；每个受影响 run 都报告失败，而不是虚假的取消成功。MCP 进程必须保持运行，才能保留 run ID 和服务监管。内联返回的 assistant 文本是有界 UTF-8 尾部；仅当本次运行没有回答文本时，其中才可能包含 reasoning。Web 会话是完整 transcript（文本记录）。Web 子进程输出非法 UTF-8 或 readiness 数据、提前退出，或无法使事件流就绪时，启动会失败，不会发布部分可用的服务。
