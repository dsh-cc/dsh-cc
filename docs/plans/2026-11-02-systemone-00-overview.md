# SystemOne 增强特性详细设计索引

状态：提案，尚未实现。日期：2026-11-02。源码基线：`31fb29eb77148e92ca8da365adcbf4994622a31d`。

本组文档把 SystemOne 增强拆成十二项可分别评审、开发、验证和回退的特性。本次提交只包含设计，不改变产品默认值、权限策略、模型配置或 VWA 交付等级。文档中的文件、接口和命令若标明“新建”，指后续实现交付物，不表示本次已存在。

## 现有基础与目标

仓库已经有 [`@dsh-cc/systemone`](../../packages/llm-tuning/systemone/src/client.ts)，权限 gauge、工具结果提示注入探测和 MOA 路由/裁判已使用原生 SystemOne 协议。此次不是重新搭建模型提供商，也不把 Jev 配成主 Agent 的 chat 模型。

目标是把选择、分类、排序和调用前筛选接到已有原生协议上，减少不必要的生成调用或改善候选发现。摘要、代码、解释、正式审查 rationale 继续由生成模型承担。类型正确不等于判断正确，下面的概率阈值均为待验证的策略配置。

[TypeSafe 官方编码 Agent 边界](https://docs.typesafe.ai/introduction/coding-agents)、[Choice](https://docs.typesafe.ai/primitives/choice)、[Score](https://docs.typesafe.ai/primitives/score)、[Noul](https://docs.typesafe.ai/primitives/noul) 和[上下文限制](https://docs.typesafe.ai/models) 是协议依据。部署网关的能力以显式配置为准，不把官方窗口直接套到内部模型别名。

## 独立交付清单

| ID | 设计 | 优先级 | 独立交付物 | 硬依赖 |
|---|---|---|---|---|
| S1-01 | [请求与响应校验](2026-11-02-systemone-01-contract-validation.md) | P0 | 请求感知的严格校验及 gauge 缺失概率防御 | 无 |
| S1-02 | [运行时、预算与计量](2026-11-02-systemone-02-decision-runtime-metering.md) | P0 | 可注入 runner、持久配额与 `/cost` 决策分账 | S1-01 |
| S1-03 | [记忆召回](2026-11-02-systemone-03-memory-recall.md) | P1 | 固定候选记忆的独立相关性选择器 | S1-01/02 |
| S1-04 | [记忆提取前筛选](2026-11-02-systemone-04-memory-extraction-gate.md) | P1 | 有界增量的持久信息 gate 与可靠水位 | S1-01/02 |
| S1-05 | [语义工具发现](2026-11-02-systemone-05-tool-discovery.md) | P2 | 弥补词面零命中的检索与选择性激活 | S1-01/02 |
| S1-06 | [技能推荐](2026-11-02-systemone-06-skill-recommendation.md) | P3 | 独立只读推荐消费者，不代替技能提供者 | S1-01/02 |
| S1-07 | [VWA 支持关系预筛](2026-11-02-systemone-07-vwa-support-triage.md) | P2 | 辅助优先级，不替代正式审查记录 | S1-01/02 |
| S1-08 | [VWA 审计拆分](2026-11-02-systemone-08-vwa-audit-split.md) | P2 | 局部对齐与全文检查分离，辅助候选排序 | S1-01/02、VWA permit 公共模块 |
| S1-09 | [MOA 上下文路由](2026-11-02-systemone-09-moa-context-routing.md) | P2 | 短跟进背景与明确的低配风险策略 | S1-01/02 |
| S1-10 | [MOA 分维度验收](2026-11-02-systemone-10-moa-acceptance.md) | P2 | 独立概率问题，复用原升级状态机 | S1-01/02 |
| S1-11 | [工具摘要 gate](2026-11-02-systemone-11-summary-gate.md) | P3 | 在 TUS 生成前跳过明确低价值摘要 | S1-01/02 |
| S1-12 | [压缩 reducer gate](2026-11-02-systemone-12-reducer-gate.md) | P3 | 在生成式 reducer 前筛选，不替代 verifier | S1-01/02 |

S1-03 与 S1-04 不互相依赖，S1-05 与 S1-06 不共享可变目录，S1-07 与 S1-08 共用在 S1-07 定义的 VWA permit 适配模块，该模块须先以独立基础提交交付，两项业务不共享辅助判定缓存且不要求启用对方，S1-09 与 S1-10 不要求同时启用，S1-11 与 S1-12 不共享生成任务。各实现 PR 只交付对应行的行为；未完成的其他特性通过依赖注入替身测试，不允许复制临时 runner 到业务代码。

## 研发顺序与集成边界

先合并 S1-01，再合并 S1-02。其余特性可依照固定接口并行开发，接入生产前必须具备这两个前置项。首个端到端试点选择 S1-03，因为它有现成 selector seam 与召回评测；随后 S1-04 和 S1-05。文档负载高的部署可先做 S1-07/08，但不得把辅助结果写成正式通过。

S1-02 的 runner 类型和预算 permit 是跨文档唯一规范。其他设计中的局部接口不能重定义相同名字的不同语义；如实现时确需修改，必须先在 S1-02 与所有消费方测试中共同修改。没有任何消费方可以直接通过 `llm/stream` 调用 SystemOne。

旧功能默认保持不变：新增 mode 均为 off。shadow 可以产生额外模型费用，只记录建议，不改变原决策；active 的失败行为由各文档明确规定。S1-01 例外，它是无模型开关的协议缺陷修复，strict validation 直接生效。

## 共享约定

### 身份、隔离与过期结果

所有候选先经过现有作用域、权限、路径和调用资格检查，再提供给决策服务。候选 ID 由宿主生成，模型不能返回任意路径、工具名或技能名来扩大资格。跨项目、session、agent 的缓存与 shown 状态不能复用。

`DecisionScope.originSeq` 表示本次触发的持久日志水位；若用户消息尚未写入日志，使用同步 capture 的日志水位，并额外使用该功能的内存 generation 识别当前轮次。它不保证总是用户消息本身的 seq。await 后必须重新验证作用域、generation、模式、目录或绑定版本；旧结果不能留到下一轮使用。

目录与 state 的 hash 使用规范 JSON 后完整 SHA-256。候选排序的最终并列键为稳定 ID，禁止依赖模型答案对象的键顺序。不截断 JSON，不把只评估部分候选误报为完整筛选。每份文档给出的批次上限、超限行为与失败回退属于验收契约。

### 路由、概率与版本

宿主通过 `ctx.systemoneDecisions.forAgent(agent)` 返回绑定 runner；scope 由 `bound.scope(originSeq?)` 取得，不允许业务伪造身份。省略 originSeq 时读取宿主 `agent.session.seq`。runner 的 `identifyRoute(alias,scope)` 返回无密钥的 provider/model/capability revision。语义缓存必须包含这些字段、问题和策略版本、完整输入/目录版本与作用域；await 后 identity 变化则丢弃。部署 checkpoint 更换时必须更新 capability revision，并重新校准阈值。不能以 `gauge` alias 名本身当成模型版本。

独立对象使用各自 Noul/Score，不把一次 Choice 的竞争概率当成多对象独立相关性。Score 是 rubric 数字索引的期望值，可以是小数。Noul 只返回概率，没有独立 confidence。各策略读取与其风险相符的字段，不能把 confidence=0.9 解释为已有 90% 真实正确率。

### 预算与失败

所有新请求由 S1-02 统一预留、派发和结算，每个 attempt 单独收费，缺失 usage 按未知保留上界。VWA 通过同一个 runner 的可选 budgetPermit 接入既有 run/cycle/project 预算，不能另记一份“免费缓存调用”。

无服务、无路由、无能力声明、输入超限、预算不足、取消或格式错误均不能伪装成有利的模型判断。业务层按各自失败表回到原行为或不行动。回退生成调用也有自己的原始预算，不因 SystemOne 已失败而免计。

### 隐私与权威边界

只发送该判断所需的最小状态。metadata-only 的发现类功能不读取正文；需要原文的证据和摘要功能必须明确列出输入范围。新 namespace 不授权上传整仓库、环境变量或全量会话。

公共计量只保存哈希、版本、用量和固定原因代码，不保存请求正文、密钥或模型原始错误。业务持有的正式证据/审查记录按既有存储规则处理；辅助结论不得成为权限授权、测试通过凭证或正式 VWA ReviewRecord。

## 设计完成与实现完成的区分

这组文档定义了目标、接口、设置、状态机、失败表、文件职责、任务、测试和发布门槛。其阈值、测试数量和性能门槛是后续实验的预注册要求，不是已取得的结果。

后续实现者应使用 writing-plans 的逐任务执行方式，在各文件列出的测试矩阵上完成 red/green 验证。规范中的 TypeScript 片段定义公开契约或纯策略，不是声称已实现的生产模块。需要集成外部 harness 的地方以当前源码接口为准；依赖升级造成接口变化时须先更新本设计，而非猜测替代。

每项实现交付需满足以下共同清单，以及本项专属门槛：

- [ ] 关闭模式的旧行为与调用次数回归通过；shared runtime 缺失有明确结果。
- [ ] 完整覆盖取消、并发、旧结果、目录/模式变化、输入超限与预算不足。
- [ ] 新增 package 声明所有直接依赖并更新 lock、tsconfig 与 exports。
- [ ] 所属模块测试、typecheck 与相关静态门禁通过。
- [ ] 模型评测区分 replay/mock 与真实在线数据；阈值调参集和发布测试集分开。
- [ ] 所有成本包含 SystemOne、重试、失败与生成回退；未知费用显式标记。
- [ ] 若改变可见能力，修改 `docs/claude-code-capabilities.yaml` 并运行 `pnpm docs:parity`；README 变化保持中英配对。
- [ ] 提交可审查的关闭开关、回退步骤和已知限制；本组文档本身不批准任何默认值翻转。

## 本次文档 PR 的验收

所有十二项设计及索引均位于 docs/plans。检查文件间相对链接、既有源码链接、共享类型名字、feature 标识、默认 mode、阈值与失败表，确认无相互矛盾。新文件引用以代码路径标注“新建”，不得伪装成当前已存在链接。

本 PR 不执行在线 Jev 评测，不实现功能、不运行假装已存在的未来测试命令。验证范围为文档完整性、引用一致性、`git diff --check` 与仓库无需安装的静态门禁。CI 的结果应独立报告，不能把设计评审通过当作运行时验证通过。
