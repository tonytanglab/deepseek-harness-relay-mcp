# 002：跨 Agent 分发与接入计划

## 文档信息

- 状态：执行中（0.2.0 并行准备已完成）
- 日期：2026-08-19
- 适用项目：DSH Relay
- 执行优先级：P1
- 前置依赖：001 的 Facade、生命周期、状态仓库和错误契约已冻结并通过发布门
- 实施原则：任何 MCP Agent 均可独立安装和调用，不依赖 Codex 专有路径或浏览器控制
- 验证原则：安装、升级、卸载、链接可达性与跨客户端兼容全部由自动化测试完成；仅 npm 发布主体、scope 所有权或需求边界变化需要用户选择
- 当前落点：已交付只读 `ClientSetupFacade`、Codex/Claude Code/Cursor/OpenCode 四适配器、绝对 Node/入口启动规划和机器可读 doctor；配置 apply/备份/回滚、正式发布供应链及 24 组跨平台 E2E 仍保持发布门关闭

## 一、目标

让 Codex、Claude Code、Cursor、OpenCode 用户能够用各自原生 MCP 配置完成安装、诊断、启动、监控和卸载，并建立可复现、可验证、身份清晰的公开发布流程。

本计划完成后应满足：

1. 四类 Agent 均有一键或单命令配置路径，默认连接同一个本地 Relay Broker。
2. 用户无需复制开发机绝对路径，也无需修改 DeepSeek Harness 源码。
3. 包名、插件 ID、MCP Server ID、Skill 和版本来源一致且不暗示未经授权的官方关系。
4. 从干净环境安装后可完成一次 `start -> wait/status -> result` 验证。
5. 安装器可重复运行、可诊断、可卸载，并保持用户已有配置。

## 二、当前差距

| 领域 | 当前情况 | 风险 |
| --- | --- | --- |
| H4：npm 发布 | `@deepseek-ai/dsh-relay` 尚未发布，且 scope 所有权/授权未确认 | 用户无法安装，命名可能误导官方归属 |
| 版本 | Codex cachebuster 与 npm 发布版本混合表达 | SemVer、升级和复现困难 |
| Codex | 已有本地插件和 Skill，但偏开发机缓存流程 | 公开用户缺少稳定安装来源 |
| Claude Code | MCP 协议可用，缺少经过验证的 `claude mcp add` 流程 | 用户需自行猜配置 |
| Cursor | 缺少 `.cursor/mcp.json` 模板和安装入口 | 项目级/用户级范围不清晰 |
| OpenCode | V2 使用 `opencode.json -> mcp.servers`、命令数组和 `environment` | 通用 `mcpServers` 示例不兼容 |
| 能力发现 | 非 Codex Agent 没有 Skill 提示和预置任务模板 | 首次调用门槛高 |
| 发布供应链 | 缺少 provenance、Release、SBOM/第三方声明门 | 包完整性与归属难验证 |

## 三、范围与非目标

### 本期范围

- 公共包身份和仓库元数据决策。
- 单一版本源及 npm/Codex 双轨版本生成。
- 四类 Agent 的配置适配器、模板、安装、诊断和卸载。
- MCP Prompts 或等价通用任务模板。
- 跨平台、跨 Agent 兼容矩阵和发布流水线。
- README、中文 README、快速开始、故障排查和安全说明。

### 非目标

- 不实现远程公网 Relay；由 003 负责。
- 不实现新的运行状态或持久化机制；直接消费 001 的稳定 Facade。
- 不修改 DeepSeek Harness 的模型目录、Provider 配置或 Web 前端。
- 不把 Cursor/Claude/OpenCode 伪装成 Codex 插件；各自使用官方配置模型。

## 四、发布前决策门

正式发布前必须确定 npm 包的实际所有者：

- 若发布者拥有或得到 `@deepseek-ai` scope 明确授权，可使用 `@deepseek-ai/dsh-relay`。
- 若没有授权，必须改用发布者自有 scope 或无 scope 包名；README 不得声称已发布到不存在的包。
- 产品名可保留 “DSH Relay”，描述使用 “The MCP control plane for DeepSeek Harness.”，但不得暗示 DeepSeek、Codex、Claude、Cursor 官方背书。

该决策是发布阻塞项，不允许用技术实现绕过。

## 五、目标架构与物理边界

所有客户端配置通过统一 Facade 生成，具体格式由适配器负责；发布逻辑独立于客户端安装逻辑。

```text
CLI / installer
      |
      v
ClientSetupFacade
      +-- CodexConfigAdapter
      +-- ClaudeCodeConfigAdapter
      +-- CursorConfigAdapter
      +-- OpenCodeConfigAdapter
      +-- SetupDoctor

Release pipeline
      |
      v
PackageReleaseFacade
      +-- VersionResolver
      +-- PackageManifestBuilder
      +-- ProvenanceVerifier
```

建议物理结构：

```text
src/
  setup/
    index.ts
    client-setup-facade.ts
    adapters/
    setup-doctor.ts
    types.ts
  release/
    index.ts
    package-release-facade.ts
    version-resolver.ts
  prompts/
    index.ts
    prompt-registry.ts
```

跨模块只通过各目录 `index.ts`。客户端适配器不得直接操作 Broker 内部存储，只生成或验证启动配置。

## 六、标准接口草案

```ts
export interface ClientSetupFacade {
  plan(request: SetupRequest): Promise<SetupPlan>;
  apply(plan: SetupPlan): Promise<SetupResult>;
  doctor(request: DoctorRequest): Promise<DoctorReport>;
  uninstall(request: UninstallRequest): Promise<UninstallResult>;
}

export interface ClientConfigAdapter {
  readonly client: "codex" | "claude" | "cursor" | "opencode";
  detect(scope: "user" | "project"): Promise<DetectedConfig>;
  render(input: ClientConfigInput): Promise<ConfigPatch>;
  validate(config: unknown): Promise<ValidationResult>;
}

export interface VersionSource {
  releaseVersion: string;
  codexCachebuster?: string;
}

export type ClientScope = "user" | "project" | "local";
```

配置变更必须采用结构化解析和最小补丁，不得整文件覆盖；执行前生成可审阅计划和备份，执行后做语义校验。

### 客户端范围映射

`--scope` 是统一入口，不代表四个客户端拥有相同配置层级。适配器必须按下表映射并对不支持的组合提前报错，禁止猜测路径：

| 客户端 | `local` | `project` | `user` | 配置处理要求 |
| --- | --- | --- | --- | --- |
| Codex | 不支持 | 仅在用户明确选择 repo/team marketplace 或项目级配置能力已验证时启用 | personal marketplace 与用户级 MCP 配置 | 使用当前 Codex 插件/MCP schema 和官方 helper，不直接编辑 marketplace |
| Claude Code | `~/.claude.json` 中当前项目私有条目 | 项目根 `.mcp.json` | `~/.claude.json` 用户条目 | 优先调用 `claude mcp add/remove/get`，并验证 workspace trust/approval 状态 |
| Cursor | 不支持 | `.cursor/mcp.json` | `~/.cursor/mcp.json` | JSON 结构化最小补丁并验证 IDE/CLI 均能发现 |
| OpenCode | 不支持 | 项目 `opencode.json` | 当前版本官方全局配置位置 | 使用 V2 `mcp.servers`、命令数组和 `environment`，由 adapter 探测实际版本 |

每个适配器必须声明自己的解析器和注释保留能力。TOML、JSON、JSONC 或客户端 CLI 不得共用字符串替换实现。

## 七、统一命令体验

推荐公共入口：

```text
dsh-relay setup --client codex|claude|cursor|opencode --scope user|project|local --workspace <path>
dsh-relay doctor --client <name>
dsh-relay uninstall --client <name> --scope <scope>
```

统一行为：

- 自动发现本机 Harness Host 和已运行的 Relay Broker。
- 明确显示即将修改的配置文件、作用域和备份位置。
- 不覆盖其他 MCP Server，不打印令牌，不依赖系统默认编码。
- Windows、macOS、Linux 输出均为 UTF-8。
- Setup 优先把已解析的绝对 Node 可执行文件与包内 MCP 入口写入 stdio 配置；只有目标客户端、包管理器和 PATH 行为已经在对应平台自动验证时，才允许生成 `npx`/其他原生 launcher。
- 禁止把 `pnpm.exe`、`pnpm.cmd` 或任意包管理器 shim 当作 Node ESM 入口；Windows 自动测试覆盖 `.cmd`、含空格路径、PowerShell 执行策略和 GUI 进程最小 PATH。
- `doctor` 验证 Node 版本、包入口、Broker、Host 握手、工作区、Provider/模型和权限能力。
- Host/Broker 未发现时，setup 必须停止并给出机器可执行的启动/修复建议，不得写入一个已知不可用的配置。
- 首次成功启动 Harness 会话时返回已验证可打开的 Web 会话链接；无法访问时不把链接标为可用。

## 八、客户端接入要求

### Codex

- 保留 `.codex-plugin/plugin.json`、`.mcp.json` 和 `delegate-to-deepseek-harness` Skill。
- Skill 首次使用时返回 Harness 会话链接，并引导后续 `status/wait/reply/cancel`。
- 开发期 cachebuster 与正式 release SemVer 分离。
- 使用官方插件校验器验证 manifest；更新本地插件时使用规范 cachebuster/reinstall 流程。

### Claude Code

- 提供并实测用户级与项目级 `claude mcp add`/配置流程。
- 额外覆盖 Claude Code 默认 `local` scope，并验证 local/project/user 的优先级、项目审批和卸载范围。
- 说明 stdio 命令、环境变量、工作目录和权限边界。
- 提供一次只读审查示例及长任务恢复示例。

### Cursor

- 提供用户级和 `.cursor/mcp.json` 项目级模板。
- 若提供 “Add to Cursor” 入口，必须由自动化测试验证生成内容，不依赖本机绝对路径。
- 同时验证全局 `~/.cursor/mcp.json` 与项目 `.cursor/mcp.json`，确保同名 server 的优先级和卸载目标明确。
- 说明 Cursor 对 tool annotations 和审批 UI 的实际行为差异。

### OpenCode

- 使用当前 V2 `opencode.json` 的 `mcp.servers` 结构。
- 命令使用数组，环境变量使用 `environment`；不得直接复用其他客户端的 `mcpServers` JSON。
- 提供禁用、超时和项目范围示例。

## 九、通用提示与能力发现

为没有 Codex Skill 机制的 Agent 提供 MCP Prompts 或等价可发现模板：

- `delegate-review`：固定只读权限，适合代码/文档审查。
- `delegate-diagnosis`：只读诊断，要求结构化证据和建议。
- `continue-run`：根据 `needs_attention` 或 `incomplete` 回复继续。
- `summarize-run`：返回状态、模型、权限、耗时、结果和下一步。

Prompt 只负责编排参数，不绕过 001 的权限和危险操作确认。

## 十、实施阶段

### 里程碑 1：身份与版本单一真源

- 完成 npm scope/发布主体决策。
- `version.json` 或等价文件只保存 `releaseVersion`，Codex cachebuster 由构建流程派生。
- Codex cachebuster 继续由规范 helper 生成，作为开发期构建元数据；不得强制绑定 commit SHA，也不得回写 npm release SemVer。
- 校验 package、plugin manifest、CLI `--version` 和 Release 标签一致。
- 修正文档中尚未发布、官方归属和安装命令的不实表述。

验收：一次版本变更可生成所有合法版本字段，无手工多点修改；未授权 scope 会使发布流水线失败。

### 里程碑 2：Setup Facade 与四个适配器

- 实现 detect/plan/apply/validate/uninstall。
- 提供用户级和项目级范围，保留未知字段及其他 MCP 配置。
- 按客户端范围映射支持 Claude Code 的 local/project/user，并让其他客户端对不支持的 local scope 明确失败。
- 每个适配器使用与其格式对应的结构化解析器或官方 CLI，不以正则/字符串替换编辑配置。
- 每次写入前创建备份，失败时自动回滚。
- 增加 `doctor` 的机器可读 JSON 与人类可读报告。

验收：四类客户端各自配置中已有其他 MCP Server 时，安装和卸载 DSH Relay 后原配置字节语义保持不变。

### 里程碑 3：模板、Prompts 与首次运行体验

- 建立经过测试的配置模板和复制即用示例。
- 提供通用 MCP Prompts 和每客户端最短调用示例。
- 首次运行返回会话 ID、当前状态和经过可达性验证的 Web 链接。
- 可达性验证必须有明确超时、Host 实例匹配和失败降级：失败时只返回 sessionId 与诊断原因，不宣称链接可用，也不要求用户手工打开页面完成发布门。
- 文档明确 Harness 未启动、Host 端口变化、模型不可用和权限拒绝的处理方式。

验收：新用户只阅读对应客户端的一页快速开始即可完成只读任务并取得结果。

### 里程碑 4：发布供应链

- GitHub Actions 执行构建、测试、插件校验、跨客户端 smoke、`npm pack --dry-run`、依赖审计。
- 优先使用 npm trusted publishing/OIDC；兼容路径使用 `npm publish --provenance --access public`，GitHub Actions 必须具备 `id-token: write`，发布后执行签名/attestation 校验。
- 生成 CycloneDX JSON SBOM、第三方许可证声明、GitHub Release 和校验和；许可证白名单或新增依赖 diff 不通过时阻断发布。
- 包内容白名单包含运行时必需文件、README、README.zh-CN、LICENSE 和必要文档；不得包含本机路径、状态数据库或密钥。
- 发布前从 tarball 在临时目录安装并启动；发布后从 registry 按真实包名执行独立 smoke，避免把“尚未发布的包名可安装”作为发布前条件。

验收：全新虚拟机只依据 Release 或 npm 包即可安装，不访问开发者个人目录。

### 里程碑 5：跨平台兼容矩阵

- Windows PowerShell 显式使用正确的 `.cmd`/Node 入口，避免把 `pnpm.exe` 当 Node ESM 加载。
- macOS/Linux 验证路径、权限、信号和后台进程行为。
- 固定测试 Codex、Claude Code、Cursor、OpenCode 的最低支持版本与最新版本。
- 将客户端差异转为适配器测试，不在 README 中靠人工记忆维护。

验收：支持矩阵固定为 4 客户端 × 3 平台 × 2 版本档，共 24 组；全部自动完成安装、doctor、start、wait、result、uninstall，不以人工抽查代替失败组合。

## 十一、测试与发布门

- 配置 golden tests：每个客户端、每种作用域、Windows/macOS/Linux。
- 启动器测试：绝对 Node/入口、允许的 client-native launcher、空格路径、最小 PATH、Windows `.cmd` 和错误 `pnpm.exe` 注入。
- 幂等测试：setup 连续执行三次只产生一份有效配置。
- 保留测试：未知字段、注释能力允许时、其他 MCP Server 和用户环境变量不丢失。
- E2E：干净环境执行只读任务，进程重启后继续 wait。
- 包测试：安装 tarball 后运行，不从源码或 `node_modules` 外部取文件。
- 发布后测试：从 registry 安装刚发布的精确版本，验证 provenance/签名、SBOM、CLI 版本与最小只读任务。
- 文档链接检查、命令 smoke、UTF-8 无 BOM 检查。
- 安全门：日志和诊断输出不得包含配对令牌、完整敏感提示词或私有路径（除非用户显式要求）。

## 十二、迁移与回滚

- 旧手工配置可由 `doctor` 识别并生成迁移计划，不自动覆盖。
- Setup 保存带时间戳备份，并记录只包含 DSH Relay 配置键的变更清单。
- 备份采用自动保留和清理策略；`doctor`/uninstall 输出备份位置和变更清单校验结果，不要求用户手工比较配置。
- 卸载只移除本插件创建的条目和可验证的辅助文件；仍有其他客户端引用时不得停止或删除共享 Broker、状态仓库和公共运行时。
- 新包发布失败时回滚 npm dist-tag 和 GitHub Release，不修改用户 Harness。
- 版本不兼容时客户端适配器拒绝连接并给出升级/降级路径。

## 十三、风险登记

| 风险 | 级别 | 缓解措施 |
| --- | --- | --- |
| npm scope 未授权 | 高 | 发布前所有权决策门；使用自有 scope |
| 客户端配置格式变动 | 高 | 官方格式适配器、版本化 fixtures、兼容 CI |
| 安装器覆盖用户配置 | 高 | 结构化最小补丁、备份、语义 diff、回滚 |
| Codex 专有体验泄漏到其他 Agent | 中 | 通用 MCP Prompts 和独立适配器 |
| 包内容遗漏运行时文件 | 中 | tarball 全新目录 E2E、文件白名单 |
| stdio launcher 命中错误 shim 或最小 PATH 无法解析 | 高 | 解析绝对 Node/入口、平台 fixtures、真实进程 smoke |
| 卸载破坏其他客户端共享 Broker | 高 | 引用检测、只移除本客户端配置、共享组件保留 |

## 十四、完成定义

- H4 已由真实可获取的发布产物、明确的发布主体和自动化供应链门闭环。
- 四类 Agent 均有已自动验证的 setup/doctor/uninstall 路径。
- 所有公开安装命令均来自真实可获取的包或 Release。
- 版本号有单一真源，cachebuster 不污染 npm 发布版本。
- 24 组跨客户端/平台/版本自动化矩阵全部通过，且无需用户手工打开页面或编辑配置。
- README 中英文内容一致，明确权限、数据、Host 和故障恢复边界。
- 发布流水线具备 provenance、依赖审计、SBOM/第三方声明和跨客户端 E2E。
- 没有修改 DeepSeek Harness 产品源码。
- 代码实施时已按真实时间更新插件根 `CHANGELOG.md`。
- 003 只能在跨 Agent setup 和 Broker 连接稳定后开始面向用户发布新能力。

## 十五、交付物

- `ClientSetupFacade`、四个客户端适配器和 `SetupDoctor`。
- `PackageReleaseFacade`、单一版本源和发布流水线。
- 四客户端配置模板、通用 MCP Prompts、快速开始和故障排查。
- npm/GitHub Release 产物、provenance、SBOM 与兼容矩阵报告。
