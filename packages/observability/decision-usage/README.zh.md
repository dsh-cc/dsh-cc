# @dsh-cc/decision-usage

[English](README.md) | 中文

SystemOne 决策运行时宿主适配层——可选 `ctx.systemoneDecisions` 服务，实现 SystemOne S1-02 决策运行时计量设计（特性 S1-02）。它把纯执行的 `createDecisionRunner`（`@dsh-cc/systemone`）接到真实宿主依赖上：可信设置、按别名解析的路由（别名本身就是路由，可选的每别名 pin 行只能收窄它）、持久的 JSONL 用量账本，以及锁保护的会话配额。挂载服务本身不触发任何请求、不启用任何业务；服务缺失等价于 unavailable/unconfigured。

## 设置

单一可信命名空间 `systemone-decisions`（经 `registerNamespaceSafe` 注册 schema；settings cascade 只从 user/managed/显式 --settings 源重组该键——project/local 永远无法抬高配额、放宽上界或提供连接信息）。原始字段为 kebab-case：`max-attempts-per-session`（默认 100）、`max-input-tokens-per-session`（1,000,000）、`max-output-tokens-per-session`（100,000）、`max-retries`（0，取值 0..2）、`routes`（每别名 pin 行，默认 `{}`）、`ledger-max-bytes`（10,485,760，最小 1,048,576）。

`routes.<alias>` 是可选 pin 行：每个字段都可选，字段缺失即"取默认值"。`revision`（默认 = 解析出的线上模型 id——后端轮换时显式设置它以改变记录的 revision）；`actual-model-id`（可选版本 pin，非空且至多 256 字符；缺失 = 不做版本校验）；`per-request-tokens` / `per-question-tokens`（默认取自 `@dsh-cc/systemone/model-windows` 的实测每模型窗口，按归一化模型 id 取值——`llmbox_systemone/bjev` → 16384——未测量的模型取 1024）；`max-output-tokens`（32768）；`max-questions`（32）。某个字段若"存在但非法"（`null`、空串、0、负数或非安全整数），只让该别名不可用，绝不影响兄弟别名。别名字典键按小写折叠匹配（`routes.Gauge` 作用于 `gauge`）；折叠冲突为后者胜出并只告警一次。

一条路由可用的充要条件：别名解析出具体的 `protocol: 'systemone'` 路由，且 provider 与 model 非空——没有能力表、没有 `(provider, model)` 精确匹配、不继承父级 header、不回退到同级别名；解析失败、协议不符或现有字段非法都解析为 unconfigured，绝不猜测。`identifyRoute` 只返回无密钥身份——不含 apiKey、baseURL 或 actual-model-id。

默认值只决定每次尝试的**预留**大小，不构成任何保证：每次尝试按 `per-request-tokens` 与 `max-output-tokens` 向会话配额预留，返回 answered 的尝试按实际用量结算，而状态未知的未结算尝试会**保留**其预留——因此当后端计量口径变化（例如未 pin 的后端切换）时会以 `accounting-overrun` 加持久冻结的形式暴露，这正是文档化的 fail-safe 方向。

迁移：已废弃的 `capabilities` 表只要带有行就使整个 section 失败关闭（空的 `capabilities: []` 视为惰性残留而容忍）。把额外字段搬进 `routes.<alias>`，并删除 `provider`/`model`——两者由别名提供。

信任模型共三层：`systemone-decisions` 为可信命名空间（仅 user/managed/显式 flag）；别名映射来自完整 cascade（已记录的残余风险——project 层只能在用户已配置的 provider 键中选择，无法凭空造出 endpoint）；决策通道的 provider 连接信息来自 cascade 对 `llm-pi-ai` 的**仅可信层视图**（`trustedSection('llm-pi-ai')`，鸭子类型探测）。若设置服务没有该 API，provider 记录即不可解析，任何路由都不成立——合并文档丢失来源信息，会采信仓库内携带的 endpoint 或凭据引用。gauge 权限通道仍读合并视图（既有弱点，另行跟踪）。

## 账本布局与配额

配额作用域为 `(projectKey, sessionId)`：目录 `<dshHome>/decision-usage/<projectKey>/<encodeSegment(sessionId)>/` 内含 `usage.jsonl` 与事务锁 `quota.lock`。每条 schemaVersion=1 行只携带标识符、版本号与令牌计数——绝不记录 API key、baseURL、state/question 正文、路径或答案。阶段为 `reserve`/`dispatch`/`settle`/`outcome`；租约 id 为 `decisionId + attempt`。

每一次追加都处在同一段短事务内：取锁（`open('wx', 0600)`，每 20ms 重试、至多 100ms，不抢锁，v1 不做陈旧锁回收）→ 读账本 → 检查限额 → 追加并 fsync → 放锁。冻结状态在同一锁内读取并计算，freeze 行携带固定 `reasonCode` 在同一事务内落账；若 freeze 行本身写不下去，锁文件保留在原位，由人工清理。恢复语义：未配对的 reserve 全额保留；只有持久的 `not-dispatched` 可退款；撕裂尾行（`torn-tail`）或冲突结算（`quota-frozen`）冻结会话配额；`accounting-overrun` 冻结后续请求，`model-version-mismatch` 照实计费但不采取结果。`max-attempts-per-session` 只统计已预留且未被持久退款的尝试；输入/输出上限为"结算后占用"语义；`ledger-max-bytes` 到顶后停止新决策而不删除记录。

注：配额层写入的 reserve 行是记账口径行（其 `provider`/`model`/`revision`/`mode` 字段依约为空——reserve 入参不含这些字段）；路由归属信息在同租约内由 runner 写入的 `dispatch`/`outcome` 行承载。

## 读取账本（供 /cost 与报表）

```ts
import { decisionUsageDir, usageFilePath, readDecisionLedger, projectDecisionLedger } from '@dsh-cc/decision-usage'

const dir = decisionUsageDir(dshHome, projectKey, sessionId)
const report = await readDecisionLedger(usageFilePath(dir)) // { rows, tornTail, corruptLines, bytes }
const usage = projectDecisionLedger(report.rows)            // attemptsUsed、retained*、逐租约实扣
```

读取器跳过空行，但会报告撕裂尾行与每一行不合规格式的内容，绝不静默跳过；只读消费方可以展示完整行并把账本标记为损坏。投影按恢复口径记账：actual → 实际用量，unknown/未结算 → 全额预留，持久 not-dispatched → 零，并给出逐租约 provider/requestedModel/actualModel 归属与冻结状态。去重与归属是投影的职责；原始行流在 `report.rows`。

## 组合

可选 cordis 插件（`apply`）：注册设置命名空间并挂载 `ctx.systemoneDecisions`，其 `forAgent(agent): BoundDecisionRunner`。绑定器以 `WeakMap` 为每个 Agent 固定一个进程级 UUID，项目键取自 `projectKeyOf(path.resolve(header.cwd))`，会话 id 取自实时的 `agent.session.id`，并在路由解析前、每次预留前、返回 answered 前对照实时 agent 校验 scope；agent 销毁后绑定器永久失效。该服务由预设组合挂载，业务特性不直接挂载。

设计证据：配额事务协议与 `specs/tla/decision-runtime-quota` 的已验证模型一致（同一把锁内检查并追加、锁内计算冻结、任意崩溃切点都不产生免费配额）。
