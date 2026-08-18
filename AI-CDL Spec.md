# DeepSeek Harness AI-CDL（本项目执行细则）

> 通用规则见 [`AGENTS.md`](AGENTS.md)。本文只定义 DeepSeek Harness 的任务分级、PRE-FLIGHT、验证选择和高风险路径规则；架构事实以 [`docs/architecture.md`](docs/architecture.md)、各 subsystem 文档、Package README 与 Agent Note 为准。

## 0. 适用范围

本规范适用于方案、计划、代码、测试、配置、文档、生成器、原生组件和 vendoring 工作。

修改仓库前必须依次完成：

1. 阅读根 [`AGENTS.md`](AGENTS.md)。
2. 阅读本文件并判定 Tier。
3. 修改 `packages/` 前阅读 [`docs/architecture.md`](docs/architecture.md) 和 [`packages/AGENTS.md`](packages/AGENTS.md)。
4. 按触发路径阅读对应细则。
5. 提交 PRE-FLIGHT 后再修改。

不得把“仅做局部修复”“仅增加兼容层”或“仅调整入口”作为绕过能力所有权、生命周期、持久化、模型日志或安全规则的理由。

## 1. Tier 与完成定义

| Tier | 适用场景 | 最低验证 |
|---|---|---|
| **0** | 只读调研、诊断、评审或实施计划；不修改文件 | 读取权威源码和文档；报告证据、假设及未验证项 |
| **1** | 纯文档；机械修改；单 package 内部实现；不改变公共类型、配置、事件或跨 package 关系 | 文档运行 `pnpm run doc-sync`；代码运行聚焦测试和适用的静态检查 |
| **2** | 跨 package 修改；公共 API、配置、Service Definition/Provider/Consumer、工具或 UI 行为变化；新增 Worker/子进程；生成物所有者变化 | 聚焦测试、`pnpm run typecheck`、适用的 lint/build/doc-sync；按需 snapshot 或 E2E |
| **3** | 安全边界、sandbox、权限、凭据、持久化、session 事件、wire/durable 格式、agent-loop、取消/并发/teardown、native、vendor、发布路径 | Tier 2 + 对应原生、恢复、失败路径、跨进程、E2E 或 snapshot 验证；按发布面运行 build/hygiene |

按最高影响判定 Tier。文件数量少不降低 Tier；一个字段改变 durable、wire、安全或模型可见语义时仍为 Tier 3。

纯文档修改通常为 Tier 1，因为本项目存在双语配对、链接、预算、生成区和网站投影门禁。只读计划才是 Tier 0。

## 2. PRE-FLIGHT

### 2.1 所有修改

修改前提交以下简报：

```text
Tier：
目标结果：
现有所有者：
受影响入口与消费者：
公共类型、配置、事件、日志或持久格式：
失败与取消语义：
最小验证：
文档、Agent Note、CHANGELOG：
```

“现有所有者”必须指向实际 package、Service Definition、Provider、Consumer、registry、事件或持久化组件。无法定位所有者时先检索仓库，不得直接创建新 package 或旁路服务。

### 2.2 Tier 2

Tier 2 PRE-FLIGHT 还必须说明：

- 该能力的 Service Definition、Provider、Consumer 是否完整。
- 是否改变跨 package import、公开 exports、Cordis 配置或生成目录。
- 是否产生模型可见输入或输出；若是，说明对应 session event 和 keyless snapshot。
- 是否涉及后台资源；若是，说明资源所有者、取消、dispose 和 quiescence。
- 是否需要新增或更新 Agent Note。

### 2.3 Tier 3

Tier 3 PRE-FLIGHT 还必须说明：

```text
1. 权威状态：哪个事件、文件、记录或服务拥有完成事实
2. 最早错误边界：错误语义或阻塞首次出现的位置
3. 进程与资源所有权：谁创建、取消、回收并等待资源
4. 发布点：状态何时从准备态变为对外可见
5. 中断恢复：进程死亡、部分写入、重复调用和重启如何处理
6. 失败关闭：哪些失败必须阻止命令、会话或持久状态继续发布
7. 兼容与版本：配置、磁盘、session、wire 或 package API 是否改变
8. 验证证据：正常、负向、竞争、取消、恢复和构建产物路径
```

安全、并发、子进程和 teardown 修改必须先读 [`docs/defensive-patterns.md`](docs/defensive-patterns.md)。

## 3. Harness 架构检查

### 3.1 插件与能力

- 新行为优先放在已有扩展点，不在 `agent-loop` 中增加特例。
- 能力必须包含 Service Definition、Provider 和 Consumer；只有其中一层不构成完成的能力。
- 注册必须由 `ctx.effect()`、`ctx.on()` 或返回 disposer 的 registry 拥有。
- 配置错误在最早可判断的位置失败，不静默跳过缺失依赖。
- 部署可变参数进入经过校验的 `Config`，不得隐藏为实现常量。

### 3.2 状态与模型可见性

- 模型可见内容必须能从 session log 重建。
- 新模型输入、工具结果语义或持久状态需要对应事件、类型和 snapshot 证据。
- `SessionEventMap`、格式版本和 `ignorable` 规则以 session 文档与现有 Agent Note 为准。
- 先完整准备，再原子发布；未完成状态不得进入 registry、session、缓存或 UI 权威状态。

### 3.3 生命周期与并发

- 一个异步操作只能有一个生命周期控制者。
- 调用取消、共享初始化取消和服务 dispose 必须区分。
- dispose 停止新请求、取消自有资源并等待 quiescence；宽限期结束后才能强制终止。
- 共享结果只缓存已完成状态；失败或中断的初始化必须允许安全重试。
- 同一权威状态的跨进程修改必须使用共同的锁和完成协议。

### 3.4 Package 与编译面

- 跨 package 使用 package exports；本地相对导入保留 `.ts`。
- Source plane 与 artifact plane 不混用。
- 改变 exports、bin、worker、runner 或普通 Node 消费路径时，必须验证构建产物。
- 新公共导出和非显然内部模块必须满足 JSDoc 规则。
- 修改类型时同步更新 owning subsystem 文档；生成目录由拥有者生成，不手改。

## 4. 路径触发规则

| 触发范围 | 必读与最低专项验证 |
|---|---|
| `packages/core/agent-loop/**` | `docs/architecture.md`；更新架构说明；相关 loop、snapshot 和 E2E |
| `packages/session/**` | session subsystem 与格式 Agent Note；事件、恢复、持久化和版本负例 |
| `packages/sandbox/**`、`packages/subprocess/**`、`packages/terminal/**` | `docs/defensive-patterns.md`；取消、进程树、dispose、平台与失败关闭测试 |
| `packages/interaction/**`、`packages/credentials/**`、安全配置 | 权限、秘密和拒绝路径测试；不得记录凭据 |
| `packages/client/**`、`packages/host/**`、`packages/bundle/web-app/**` | 真实 Web 组合测试；用户可见 GUI PR 按项目技能录制 GIF |
| `native/**` | 原生构建、平台专项和失败路径；不得用 Wine 结果替代真实 Windows 内核证据 |
| `vendor/**` | 只按 [`vendor/README.md`](vendor/README.md) 同步并记录上游 SHA、本地补丁和验证 |
| `docs/**`、`website/**` | [`docs/AGENTS.md`](docs/AGENTS.md)；双语、链接、预算、投影与网站检查 |
| `.agents/notes/**` | [`.agents/notes/README.md`](.agents/notes/README.md)；生命周期、分类、双语及 sidecar 规则 |

未触及的专项不默认执行。发现已存在且与本次无关的失败时，保留原始证据并明确区分，不扩大修改范围。

## 5. 验证选择

### 5.1 基本原则

- 运行能够覆盖本次差异的最小测试和检查。
- 不以全量 `pnpm run test`、`pnpm run test:coverage` 或完整平台矩阵作为默认完成条件。
- 不重复运行已经覆盖相同差异且结果未失效的检查。
- 只报告实际执行的命令和真实结果；不得把未运行、跳过或既有失败描述为通过。

### 5.2 常用验证

| 变化 | 验证 |
|---|---|
| 单 package 行为 | `pnpm exec vitest run <相关 spec>` |
| TypeScript 公共或跨 package 变化 | `pnpm run typecheck` |
| lint 或边界规则 | `pnpm run lint` 或对应最小 verify 脚本 |
| 发布 exports、worker、runner、bin | `pnpm run build` + 构建产物 smoke；按需 `pnpm run hygiene` |
| 模型可见行为 | `pnpm run test:snapshot`；需重录时按项目规则使用 `test:snapshot:record` |
| Provider 真实行为 | 相关 package 测试 + `pnpm run test:e2e` 中对应场景 |
| 文档、JSDoc、Agent Note | `pnpm run doc-sync` |
| 网站投影 | `pnpm run website:build` |
| 已知 Windows 故障诊断 | 真实 Windows 专项；`check:windows-wine` 只作其能证明的工具链信号 |
| 推送或标记 ready | 使用 [`.agents/skills/dsh-pre-push-checks/SKILL.md`](.agents/skills/dsh-pre-push-checks/SKILL.md) 选择最终检查 |

CI 的覆盖率和平台矩阵不免除本地聚焦验证，本地聚焦验证也不得冒充 CI 全矩阵。

## 6. 文档、Agent Note 与 CHANGELOG

- 每个非平凡修改新增或更新一份拥有该决策的 Agent Note。
- 代码、README、JSDoc 和 owning subsystem 文档在同一修改中保持一致。
- 每次代码修改都在 [`CHANGELOG.md`](CHANGELOG.md) 的 `Unreleased` 顶部增加一条简体中文记录。
- 写 CHANGELOG 前运行：

```powershell
Get-Date -Format 'yyyy-MM-dd HH:mm'
```

- 纯文档、规则或格式调整仅在具有用户、贡献者或发布影响时记录 CHANGELOG。
- CHANGELOG 记录事实和验证；设计理由、替代方案及长期取舍链接到 Agent Note，不在两处重复。

## 7. 完成声明

完成时必须报告：

```text
Tier：
修改结果：
Agent Note / 文档：
执行的命令：
通过：
失败或跳过：
未覆盖风险：
```

存在失败、缺少平台证据或未完成恢复验证时必须明确说明，不得使用“全部通过”“永久解决”或“生产就绪”等超出证据的结论。
