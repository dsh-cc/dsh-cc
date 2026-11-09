# @dsh-cc/decision-usage

[English](README.md) | 中文

SystemOne 决策运行时宿主适配层——可选 `ctx.systemoneDecisions` 服务，实现 SystemOne S1-02 决策运行时计量设计（特性 S1-02）〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L1-L7〕。它把纯执行的 `createDecisionRunner`（`@dsh-cc/systemone`）接到真实宿主依赖上：可信设置、能力路由解析、持久的 JSONL 用量账本，以及锁保护的会话配额。挂载服务本身不触发任何请求、不启用任何业务；服务缺失等价于 unavailable/unconfigured。

## 设置

单一可信命名空间 `systemone-decisions`（经 `registerNamespaceSafe` 注册 schema；settings cascade 只从 user/managed/显式 --settings 源重组该键——project/local 永远无法抬高配额或改能力上限）。原始字段为 kebab-case：`max-attempts-per-session`（默认 100）、`max-input-tokens-per-session`（1,000,000）、`max-output-tokens-per-session`（100,000）、`max-retries`（0，取值 0..2）、`capabilities`（行数组）、`ledger-max-bytes`（10,485,760，最小 1,048,576）。

每条能力行为 `{provider, model, revision, actual-model-id, per-request-tokens, per-question-tokens, max-output-tokens, max-questions}`，全部必填，所有上界必须是正安全整数。一条路由可用的充要条件：别名解析出具体的 `protocol: 'systemone'` 路由，且恰有一行精确匹配 `(provider, model)`——零行或重复匹配都解析为 unconfigured，绝不猜测。`identifyRoute` 只返回无密钥身份——不含 apiKey、baseURL 或 actual-model-id 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L129-L129〕。

## 账本布局与配额

配额作用域为 `(projectKey, sessionId)`：目录 `<dshHome>/decision-usage/<projectKey>/<encodeSegment(sessionId)>/` 内含 `usage.jsonl` 与事务锁 `quota.lock`。每条 schemaVersion=1 行只携带标识符、版本号与令牌计数——绝不记录 API key、baseURL、state/question 正文、路径或答案 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L179-L179〕。阶段为 `reserve`/`dispatch`/`settle`/`outcome`；租约 id 为 `decisionId + attempt`。

每一次追加都处在同一段短事务内：取锁（`open('wx', 0600)`，每 20ms 重试、至多 100ms，不抢锁，v1 不做陈旧锁回收）→ 读账本 → 检查限额 → 追加并 fsync → 放锁 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L171-L171〕。冻结状态在同一锁内读取并计算，freeze 行携带固定 `reasonCode` 在同一事务内落账；若 freeze 行本身写不下去，锁文件保留在原位，由人工清理。恢复语义：未配对的 reserve 全额保留；只有持久的 `not-dispatched` 可退款；撕裂尾行（`torn-tail`）或冲突结算（`quota-frozen`）冻结会话配额；`accounting-overrun` 冻结后续请求，`model-version-mismatch` 照实计费但不采取结果。`max-attempts-per-session` 只统计已预留且未被持久退款的尝试；输入/输出上限为"结算后占用"语义；`ledger-max-bytes` 到顶后停止新决策而不删除记录。

注：配额层写入的 reserve 行是记账口径行（其 `provider`/`model`/`revision`/`mode` 字段依约为空——reserve 入参不含这些字段）；路由归属信息在同租约内由 runner 写入的 `dispatch`/`outcome` 行承载。

## 读取账本（供 /cost 与报表）

```ts
import { decisionUsageDir, usageFilePath, readDecisionLedger, projectDecisionLedger } from '@dsh-cc/decision-usage'

const dir = decisionUsageDir(dshHome, projectKey, sessionId)
const report = await readDecisionLedger(usageFilePath(dir)) // { rows, tornTail, corruptLines, bytes }
const usage = projectDecisionLedger(report.rows)            // attemptsUsed、retained*、逐租约实扣
```

读取器跳过空行，但会报告撕裂尾行与每一行不合规格式的内容，绝不静默跳过；只读消费方可以展示完整行并把账本标记为损坏。投影按恢复口径记账：actual → 实际用量，unknown/未结算 → 全额预留，持久 not-dispatched → 零，并给出逐租约 provider/requestedModel/actualModel 归属与冻结状态 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L173-L179〕。去重与归属是投影的职责；原始行流在 `report.rows`。

## 组合

可选 cordis 插件（`apply`）：注册设置命名空间并挂载 `ctx.systemoneDecisions`，其 `forAgent(agent): BoundDecisionRunner`。绑定器以 `WeakMap` 为每个 Agent 固定一个进程级 UUID 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L125-L125〕，项目键取自 `projectKeyOf(path.resolve(header.cwd))`，会话 id 取自实时的 `agent.session.id`，并在路由解析前、每次预留前、返回 answered 前对照实时 agent 校验 scope；agent 销毁后绑定器永久失效。该服务由预设组合挂载，业务特性不直接挂载。

设计证据：配额事务协议与 `specs/tla/decision-runtime-quota` 的已验证模型一致（同一把锁内检查并追加、锁内计算冻结、任意崩溃切点都不产生免费配额）。
