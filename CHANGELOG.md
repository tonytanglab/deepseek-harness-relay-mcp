# CHANGELOG

## 0.2.17

### 2026-09-14 14:19

- 修复用户已经点名 Harness 模型和审查范围后，Codex 调用方仍因授权表达可选而重复请求人工确认的问题：`start_review` 现在强制要求能力目录中的精确 `provider`、`model` 与 `authorizationBasis: explicit-user-request`，让既有授权和内容处理目的地在首次调用时即可机器识别。
- 更新 Codex 委派技能、插件默认提示及中英文文档：明确点名 Harness 或具体 Harness 模型审查已识别工作区/文件即授权该目的地处理范围内读取内容，不得仅因外部提供商处理而重复索要相同授权；目的地或范围变化时仍需按新范围处理。
- 保留 `start_review` 的真实 `openWorldHint: true` 和 Harness 原生 `read-only` 权限语义；本修复不伪装外部模型调用，也不把任务范围声明误称为文件系统隔离。

## 0.2.16

### 2026-09-13

- 补充 Windows 原生 Job 子进程双层启动的弹窗排查：Harness 的 Node runner 和原生目标均须隐藏控制台，更新 Relay 本身无法替代 Harness 本体修复；明确重启 Host 及可见性回归要求。

## 0.2.15

### 2026-09-11 20:17

- 修复 personal Marketplace 从本地源码更新时可能出现“manifest/安装记录为新版，但忽略的 `dist/` 仍为旧版”的升级陷阱：新增 `prepare:codex-local` 与构建版本门禁，逐一校验三套运行产物的内嵌版本，并确认 proxy 包含稳定的完整工具目录入口。
- 增加项目级 `AGENTS.md`、构建版本回归测试和中英文升级说明；本地安装不得再以 manifest 版本代替运行时验证，必须在新 Codex 任务中核对 `doctor.relayVersion` 与完整工具目录。

## 0.2.14

### 2026-09-11 13:37

- 修复 Windows 上 Relay 自动恢复 Harness 时仍会弹出 Node/DOS 控制台窗口的问题：后台启动不再同时使用会请求独立控制台的 `detached` 与 `windowsHide`，同时保留标准流断开和窗口隐藏。
- 增加 Windows 与非 Windows 后台启动选项回归测试；非 Windows 平台继续以 detached 方式运行，避免改变既有生命周期行为。

## 0.2.13

### 2026-09-10 18:33

- 修正 Codex 委派范围语义：计划或文档作为审核目标时，可在明确授权的工作区上下文内按需读取相关实现、测试、配置和架构材料；仅当用户明确要求时才收窄为目标文件本身，审批拒绝也不得再被误报为 Harness 无法读取代码。
- `start_review`、`start_run` 与 `reply_run` 新增 `reviewTargets`、`contextReadScope`、`excludedPaths` 和 `writeScope` 任务范围声明；Relay 将声明写入提示与运行快照，续接默认继承且只应用显式调整，同时明确这些字段不是逐路径文件系统隔离，回环 Relay 也不代表模型提供商在本地处理内容。
- 任务清单升级为独立目标、上下文、排除和写入字段，增加路径穿越、工作区外路径、符号链接逃逸、目标文件限定及续接继承回归；保留 `start_review` 的真实开放世界审批标注，不承诺或伪装自动审批必定通过。
- 显式 Harness 请求可携带 `authorizationBasis: explicit-user-request`，为 Codex 自动审批提供真实、机器可读的既有授权依据；该字段不扩大工作区、任务范围、权限、模型提供商或外部操作。技能同时要求优先传递能力目录中的精确提供商和模型，使外部处理目的地可识别。

## 0.2.12

### 2026-09-10 17:09

- 发布 `0.2.12`：完整修复 Codex 冷启动工具目录缺失、默认调用 Harness 时自动打开浏览器，以及结构化错误被 MCP `-32602` 覆盖的问题；Harness 与 Codex 两侧插件同步更新。

### 2026-09-10 16:27

- 修复 Codex 插件三条默认提示超过 128 字符而被宿主忽略的问题，保留原生 MCP、仅传路径和持续监控约束，并增加长度回归检查。
- 修复 stdio proxy 首次 `tools/list` 在远端连接或 Harness 自动恢复尚未完成时只返回 `doctor`，导致 Codex 固化不完整初始目录的问题；proxy 现在从 embedded Relay 的同一组注册定义生成完整产品工具目录，在默认 1 秒可选 MCP 启动宽限内稳定暴露 `list_capabilities`、`start_review`、`wait_run` 等全部原生工具，远端状态仅影响调用结果。
- 修复 Codex 侧 Harness Skill 在每次首次运行后强制调用 `open_run` 而弹出浏览器的问题；Harness 调用现在默认保持无弹窗，仅分享可点击的 `webUrl`，只有用户明确要求打开或显示页面时才允许 `open_run` 或 `openBrowser: true`。同时把该约束写入 Harness 侧 MCP 工具描述并增加合同测试。
- 修复远端不可用或工具内部报错时，proxy/embedded Relay 仍为带 `outputSchema` 的工具返回不匹配 `structuredContent`，导致 MCP SDK 把原始错误覆盖成 `-32602` schema 校验错误的问题；此类错误现在保留在文本内容中且不附带不合法的结构化结果。
- 补充插件更新后握手失败的排查：核对当前任务引用的缓存入口是否存在，使用桌面应用对应的 Codex CLI 重装；旧缓存引用未刷新时重启应用后再验证，不能只凭新缓存存在宣称加载成功。

### 2026-09-08 22:50

- 将 Harness 内嵌模式最低兼容版本提升到 `0.1.3-alpha.2`，确保 Relay 不再与缺少 Windows 后台子进程隐藏修复的旧 Harness 组合安装；模型调用 `rg` 等普通 CLI 时不会反复弹出控制台窗口。
- 同步更新中英文安装要求与 Codex 插件版本，保持 npm 包、插件清单和仓库 Marketplace 版本一致。

## 0.2.10

### 2026-09-02 07:24

- 发布 `0.2.10`：合并 Harness Web 源码启动恢复与 Codex 无感后台调用修复，正式包、Codex 插件清单和仓库 Marketplace 版本保持一致。
- 发布门禁覆盖严格 UTF-8、Skill/插件结构、TypeScript、构建、MCP smoke、发布文件预算、全量 214 项测试与 tarball 内容校验；GitHub Release 附带可直接安装的 npm tarball 及 SHA-256。

### 2026-09-01 22:35

- 修复 Codex 调用 Harness Relay 时可能回退到临时 `.tmp/harness-*-call.mjs` 并反复启动可见 `node` 控制台的问题：插件默认提示、委派 Skill 与 MCP Server 指令统一要求仅通过已安装的原生 MCP 工具调用和轮询。
- 原生 Relay 工具不可用时改为安全停止委派、修复或重装插件并在新 Codex 任务加载，禁止以 Node、PowerShell、Python 或其它 shell 客户端模拟缺失工具；普通本地验证仍可在 Codex 内置终端运行，但不得作为 Relay RPC 传输。
- 新增无感后台调用契约与 `wait_run` 工具描述回归，并同步更新中英文使用说明；Skill、插件结构、严格 TypeScript、构建、发布文件检查及全量 214 项测试全部通过。

### 2026-09-01 22:14

- 修复 embedded Harness 从源码启动时的自动恢复契约：发布启动器时保留官方 `node --import tsx/esm` 执行参数，避免 stdio proxy 重启为不带 loader 的 raw Node 并触发 Cordis `FiberState` 运行时导出错误。
- 将启动向量捕获与严格校验收口到共享 Facade；构建后 `lib/bin.js` 启动保持不变，源码入口只接受明确的 tsx ESM loader，缺失 loader 或附带其它 Node 参数继续安全拒绝，不放宽自动启动边界。
- 新增源码启动向量记录、状态持久化、带 loader 重启与 raw Node 拒绝回归，并同步更新中英文运行说明；聚焦 11 项测试、严格 TypeScript、构建与发布文件检查通过。全量 212 项测试中 209 项通过，另 3 项因本机 Windows Store `python.exe` launcher 返回 9009 而失败，与本次启动契约改动无关。

## 0.2.9

### 2026-09-01 09:33

- 将 Harness Relay 委派契约收紧为 `path-reference-only`：主任务只传已授权工作区、文件/目录位置、审查或实施范围、验收条件与路由/权限元数据，由 Harness 在工作区内自行读取；`task`、文本 `content`、`steer_run` 与 `reply_run` 均禁止嵌入源码正文、diff、文件转储、源码编码或仓库归档。
- 统一只读与读写授权边界：`workspace-write` 只改变 Harness 可执行的写操作，不放宽源码传递规则；任务清单生成器不再递归读取、枚举、哈希或摘要源码，改为校验路径包含关系，并要求写模式显式声明允许的写路径。
- 更新 Skill、MCP Server 指令与工具参数说明、中英文文档及 Codex 默认提示；新增路径清单不泄露源码、读写模式同契约、显式写路径、单行范围与越界拒绝回归测试。

## 0.2.8

### 2026-09-01 08:09

- 修复 stdio proxy 在 `OWNER_DEAD` 且 3080 无 Harness Web 实例时只返回诊断、不会恢复宿主的问题：embedded Host 现在发布不含凭据的受限启动契约，proxy 默认执行跨进程锁、owner 复核、回环端口探测、启动器严格校验，并以隐藏窗口和 `--no-open` 拉起唯一 Harness Web。
- 保留单实例安全边界：owner 无法确认、端口已占用或不可探测、启动器缺失/失效及启动超时均安全失败，不会启动第二个 Harness；新增关闭开关与恢复超时配置，并覆盖自动拉起、端口占用拒绝及并发防重复启动回归。
- 严格 TypeScript、构建、发布文件门禁及全量 206 项测试通过；真实停止旧 Host 后仅启动 stdio proxy，成功自动拉起新 Harness PID、推进 owner epoch，并恢复 `doctor.ok=true` 与完整 MCP 工具目录。Harness profile 和 Codex personal 插件均回装最终 0.2.8 字节。

## 0.2.7

### 2026-08-31 09:40

- 适配 DeepSeek Harness `0.1.2-alpha.2`：移除已下线的 `dsh-host-apiproxy` 依赖，改用 Host 直连 Typert Gateway，并更新 Cordis 注入服务、工作区与会话流式基线、历史分页、模型目录、权限预设及客户端生成 `requestId` 的调用映射。
- 新版 Harness 不再提供旧 mux/host 事件流时，Relay 自动使用 durable history 轮询；保留 prompt 关联 ID 在派发前落盘、权限租约恢复及错误确定性分类语义，并明确 `0.2.6` 及更早版本与新版 Harness 不兼容。
- 发布版本同步至 `0.2.7`，更新可选 Harness peer dependencies、安装说明和接口边界；新增 Typert 适配回归并稳定慢速 Windows 生命周期测试。严格 TypeScript、构建、MCP smoke、发布文件门禁及全量 203 项测试通过。

## 0.2.6

### 2026-08-28 13:38

- 发布 0.2.6：阻止 `reasoning` 内容回退到公开 `assistantText`，统一 `reply_run`、`status_run` 与 `cancel_run` 的 `hostPollContract`，并将 stdio proxy 单次工具调用超时与真实路由故障分离，避免健康连接被误失效。
- 新增 reasoning-only、运行快照轮询合同及慢调用超时后的连接存活回归测试；经两轮 Grok 4.6 只读审查、主进程复核、TypeScript、构建、MCP smoke 与发布包门禁验证。

## 0.2.5

### 2026-08-28 13:14

- 修复最终助手文本投影边界：`assistantText` 仅保留公开 `text` 内容，不再在无文本时回退并暴露 `reasoning`；为 reasoning-only、文本与推理混合及非终态事件流补充回归测试。
- 统一运行快照轮询合同：`reply_run`、兼容别名 `status_run` 与 `cancel_run` 均附加 `hostPollContract`，覆盖运行中与终态 MCP 返回。
- 区分 stdio proxy 单次远端工具调用超时与路由故障：超时返回 `RELAY_REQUEST_TIMEOUT` 和未知结果提示，不再将健康远端连接失效或误报 `RELAY_ROUTE_UNAVAILABLE`；新增超时后连接继续可用及 doctor 健康回归测试，并经 Grok 4.6 二轮只读复审确认无新增业务代码问题。

### 2026-08-27 17:23

- 明确 Harness 权限需求的主进程裁决机制：删除、文件替换、图片或媒体生成、缺失工具及跨权限边界操作应返回精确目标、理由、风险与最小权限方案，由 Codex 主进程在既有授权内处理；普通、可逆且范围内的操作不重复询问用户，仅将重大破坏、不可逆外部影响、凭据或私有账号、越界及平台强制情形转人工确认。

### 2026-08-27 17:21

- 调整 Codex 委派联网合同：不再预先禁止 Harness 访问网络，由其按任务需要检索公开 GitHub、官方文档和网页并给出来源；普通公开资料检索不提升为 `danger-full-access`，账号登录、凭据、私有服务、源码上传与外部写入仍需单独授权。

### 2026-08-27 16:37

- 加固 Codex 运行中纠偏合同：活动运行必须优先使用 `steer_run`，禁止仅为改变方向或追加说明而取消；仅在用户要求停止、继续会造成不可逆越界风险或 native steer 明确失败时才允许 `cancel_run`，终态后才使用 `reply_run` 续接。

### 2026-08-27 15:42

- 发布 0.2.5：整合 embedded authority 死锁安全恢复、stdio proxy owner 存活诊断、Codex 内置 MCP 入口约束及 Harness 工作区授权语义，并完成版本同步、全量门禁与发布后回装验证。

### 2026-08-27 14:26

- 补充 Codex 插件内置 MCP 生成规范：manifest 引用包内 `.mcp.json`，且只允许以插件相对 `cwd` 启动 `dsh-relay-proxy.mjs`；明确禁止误指 Harness 内部 bundle、standalone 控制面、版本缓存绝对路径或用户级重复 MCP 配置。
- 修正 Harness 委派授权说明：用户明确指定 Harness/模型审核已注册工作区时，Harness 在该范围内自行读取，Codex 只传递任务和范围元数据、不复制源码正文，也不再要求重复逐文件确认；明确实施请求才映射到 `start_run + workspace-write`。

### 2026-08-27 08:43

- 经 Cursor Grok 4.6 High Fast 只读审查与主进程复审，明确 stdio proxy 不得自动拉起、终止或接管共享 Harness Host；自动恢复仅限已持有 embedded authority 围栏后的显式死锁回收。
- embedded authority 获取唯一 owner 租约后，在首次恢复状态前显式回收仅能证明由死进程遗留的 state/session 锁；live/unknown owner 继续 fail-closed，并保留 compare-before-delete 防 PID 复用与并发 ABA。
- stdio proxy doctor 新增脱敏 owner 进程探针，陈旧 ready/starting sidecar 分别报告 `OWNER_DEAD` 或 `OWNER_UNPROBEABLE`，不再把死 Host 笼统误报为远端路由不可用。
- authority、state lock 与构建锁统一进程探针语义：`ESRCH` 为 dead、`EPERM` 为 alive、其它异常为 unknown；新增死锁批量恢复、活/未知锁保护、诊断脱敏、升级交叠及 EPERM 回归测试。

## 0.2.4

### 2026-08-26 13:16

- 构建改为隔离 staging、进程间锁和失败回滚后再提升 `dist`；版本同步与脚本 JSON 读取保持严格 UTF-8 无 BOM，目标版本未变化时不再重写清单。
- durable history 首次或恢复时从 `baselineSeq` 读取，后续仅保留可变尾事件的常量窗口并从最高已确认序号增量续读；宿主轮询合同继续明确 30 秒等待只是切片，不得以 180 秒首轮上限取消整项任务。
- HTTP JSON、state、status、descriptor、token、owner 与 lock 输入统一使用 fatal UTF-8 解码并拒绝 BOM，不再将畸形字节静默替换为 `U+FFFD`。
- Windows 敏感文件通过当前用户 SID 施加并验证仅当前用户可访问的 ACL，权限失败明确上抛；临时文件先加固后再原子发布，避免并发读写落入 ACL 切换窗口。
- 锁记录加入 PID、进程启动身份与 owner token 围栏；新增只读诊断及显式陈旧锁恢复，live/unknown 始终 fail-closed，恢复与释放均采用 compare-before-delete 防止 PID 复用和 ABA。
- 新增并发构建、版本幂等、增量历史、严格 UTF-8、Windows ACL、锁恢复与 host poll contract 回归；主进程全量 191 项测试、严格 TypeScript、真实构建、MCP smoke 与发布包门禁通过。

## 0.2.3

### 2026-08-25 17:03

- 去掉 Skill/README 中「不要同步阻塞 / Poll without blocking」类措辞：只要本回合要消费 Harness 结果，就必须 `wait_run` 到终态；给出 `webUrl` 不等于完成。

### 2026-08-25 16:51

- 修正宿主过早结案：`wait_run`/`get_run`/`start_run`/`start_review` 现附加 `hostPollContract`；running 切片必须继续轮询，终态成功后必须先读 `assistantText`。用户要求审核后修改时，主进程不得在 Harness 仍 running 时宣称完成。
- 更新 MCP Server instructions 与 `delegate-to-deepseek-harness` Skill，禁止把进度链接或无关后台通知当成审核结束。

### 2026-08-20 22:21

- 统一 embedded bundle 与 stdio proxy 的 `DSH_HOME`、`DSH_PROFILE` 和运行目录解析；未显式配置时使用用户目录下的 `.dsh` 与 `web` profile，并新增结构化路径错误和启动前目录校验。
- 新增无凭证的 `relay-status.json` v1 生命周期 sidecar、POST 启动握手、authority 有界退避与可取消安全接管；仅确认旧 PID 已死亡时恢复，alive/unknown owner 始终 fail-closed。
- stdio proxy 改为本地 MCP 优先，远端异常时保留本地 `doctor`，将 descriptor/status 错配及 401/404/405/503 统一投影为 `RELAY_ROUTE_UNAVAILABLE`，并可在同一进程内跟随新 owner epoch 恢复工具发现。
- 修复 rc.8 持久历史已完成但 Relay 仍为 running、steer 截断最终输出、interrupted 被误判完整成功及 summary 时间陈旧的问题；补充 rc.8 消费面合同、升级重启交叠、状态/恢复和模块边界回归门，并公告 `status_run` 将于 0.3.0 删除。

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
