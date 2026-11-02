# SystemOne 决策运行时、预算与计量

状态：提案，尚未实现。特性 ID：S1-02。优先级：P0。

源码基线：`31fb29eb77148e92ca8da365adcbf4994622a31d`。依赖 [S1-01](2026-11-02-systemone-01-contract-validation.md)，其他功能可在本接口的测试替身上并行研发。入口见[总览](2026-11-02-systemone-00-overview.md)。

## 目标问题

当前 [`systemoneDecide`](../../packages/llm-tuning/systemone/src/client.ts) 返回 usage，但没有统一的功能归因、预算准入和生命周期记录。MOA 与权限分别记录业务结果；[`foldCost`](../../packages/session/command-cost/src/cost.ts) 则从 request/header 与 assistant/message 汇总生成模型的成本。新增决策调用若沿用这种分散方式，无法计算包含回退、失败和重试的真实成本。

本特性提供可注入的原生决策执行器，统一服务新功能。禁止用生成模型的 assistant/message 伪装 SystemOne 计量。第一版不迁移已有权限/MOA legacy 调用；新增的 MOA v2 模式使用此运行时。legacy 调用仍明确标为“未纳入决策账本”，不能宣称总账完整。

## 架构与文件

采用纯执行器加宿主适配插件。让客户端直接读取 settings/fs 会把纯传输模块与运行时耦合；各功能自己记账则无法统一重试和并发。

| 文件 | 职责 |
|---|---|
| 新建 `packages/llm-tuning/systemone/src/decision.ts` | 下述类型与 `createDecisionRunner(deps)`，无 Cordis/fs 依赖 |
| 新建同目录 `decision-hash.ts` | canonical JSON、完整 SHA-256、输入估算 |
| 修改同目录 `client.ts` | 可选 attempt observer、可选 maxRetries；缺省保留 legacy 行为 |
| 新建 `packages/observability/decision-usage` 包 | optional `ctx.systemoneDecisions` 服务、设置、路由、账本与准入适配 |
| 新建该包 `src/{index,settings,ledger,quota,route}.ts` | 各自负责挂载、设置、JSONL、持久配额、能力解析 |
| 修改 `packages/session/command-cost/src/{index,cost}.ts` | 异步加载决策账本，单独显示其费用及未计价/未知用量 |
| 修改 `packages/preset/cc` 与相关 bundle 的组合文件 | 挂载服务；服务本身不触发请求 |

新包 runtime dependencies 声明 `@dsh-cc/systemone`、`@dsh-cc/model-aliases`、`@dsh-cc/settings-ns`、`@dsh-cc/settings-provider`、`@dsh-cc/sidecar-io` 与实际使用的 harness/cordis 包，workspace 包用 `workspace:*`。同步 workspace lock、tsconfig paths/project references、发布 exports；禁止依赖未声明的 sibling src 深导入。

## 公共接口

以下为本设计集唯一共享契约。新功能通过可选服务获取 `DecisionRunner`；服务缺失等价于 unavailable/unconfigured。feature 使用总览中的固定标识，不能包含路径或用户文本。

```ts
interface DecisionScope {
  projectKey: string;
  sessionId: string;
  agentId: string;
  originSeq: number;
}
interface DecisionRequest {
  feature: string;
  mode: 'shadow' | 'active';
  routeAlias: string;
  questionVersion: string;
  policyVersion: string;
  scope: DecisionScope;
  state: unknown;
  questions: Record<string, SystemOneQuestion>;
  timeoutMs: number;
  maxInputTokens: number;
  signal: AbortSignal;
}
type DecisionRun =
  | { status: 'answered'; answers: Record<string, SystemOneAnswer>;
      model: string; usage: SystemOneUsage; decisionId: string; inputHash: string }
  | { status: 'unavailable'; reason: 'unconfigured' | 'budget' | 'timeout'
      | 'cancelled' | 'malformed' | 'error'; decisionId: string };
interface DecisionRouteIdentity {
  provider: string; model: string; revision: string;
  perRequestTokens: number; perQuestionTokens: number; maxOutputTokens: number;
}
interface DecisionRunner {
  identifyRoute(alias: string, scope: DecisionScope): DecisionRouteIdentity | undefined;
  run(request: DecisionRequest, options?: {
    budgetPermit?: DecisionBudgetPermitProvider;
  }): Promise<DecisionRun>;
}
interface BoundDecisionRunner extends DecisionRunner {
  scope(originSeq?: number): DecisionScope;
}
interface DecisionBudgetPermitProvider {
  reserve(input: {
    decisionId: string; scope: DecisionScope; feature: string; attempt: number;
    inputTokens: number; outputTokens: number; signal: AbortSignal;
  }): Promise<DecisionBudgetPermit | undefined>;
}
interface DecisionBudgetPermit {
  settle(outcome:
    | { kind: 'actual'; usage: SystemOneUsage }
    | { kind: 'unknown' }
    | { kind: 'not-dispatched' }
  ): Promise<void>;
}
```

`createDecisionRunner(deps)` 的 deps 包含 `validateScope(scope)`、`resolveRoute(alias,scope)`、`reserveGlobal`（同上 provider 形状）、`append(row)`、`now()`、`uuid()`、`fetchImpl`。均由构造方提供；测试不需要真实 settings、文件或模型。任何依赖异常被收敛为 unavailable，不能逃逸到 agent waterfall。

宿主服务公开 `forAgent(agent: Agent): BoundDecisionRunner`，BoundDecisionRunner 在上述纯接口上增加 `scope(originSeq?: number): DecisionScope`。所有业务 wrapper 先用真实 exec/invocation/capture 的 Agent 取得绑定器，再调用 scope；省略参数时同步捕获 `Number(agent.session.seq)`，绝不能用事件数组长度。测试可以直接注入纯 DecisionRunner 与固定 scope。

服务以 Agent 对象 WeakMap 分配全进程 UUID agentId，projectKey 固定为 `projectKeyOf(path.resolve(agent.session.header.cwd))`，sessionId 取当前宿主 session.id。cwd 缺失或 seq 非安全非负整数时返回 unavailable/unconfigured，不能猜测 process.cwd。memory 的目录隔离根仍独立使用其现有解析器，不能用 memoryDir hash 充当配额项目键。

每个绑定 runner 的 deps 新增 `validateScope(scope): boolean`，在路由解析、reserve 前以及返回 answered 前从绑定 Agent 重新核对 project/session/agent；originSeq 必须位于 `[0,Number(agent.session.seq)]`。Agent dispose 使绑定器永久失效。调用者伪造其他 projectKey/sessionId/agentId，或旧 Agent 已切换 session/cwd，均在 reserve 前拒绝；派发后变化则照常结算但不返回 answered。纯库不查全局 agent 注册表，由宿主绑定器提供此依赖。

路由解析结果为 `{provider,model,actualModelId,baseURL,apiKey?,revision,perRequestTokens,perQuestionTokens,maxOutputTokens}`。三个 token 上界均必须为正安全整数，由 trusted user/managed settings 的 provider/model 精确匹配行提供，不从未知模型名猜测。只有 protocol=systemone 的具体路由可用；不做 chat fallback。模型 alias 可解析，但必须记录返回的实际版本；上线评测必须固定部署 checkpoint，并在更换 checkpoint、actual-model-id 或能力上界时更新 capability revision。identifyRoute 只返回无密钥的同一解析结果；run 在派发前重解析，调用方须对 await 前后的 identity 做一致性比较，变化时丢弃业务结果。

## 设置与能力声明

新 namespace `systemone-decisions`，只读取 trusted user/managed/显式 --settings 来源，忽略 project/local；应用 settings-cascade 对 auto-mode 的 trusted-source 模式。raw 字段全部 kebab-case，内部接口 camelCase。

| 字段 | 默认 | 约束与作用 |
|---|---|---|
| `max-attempts-per-session` | 100 | 非负安全整数，0 拒绝全部新请求 |
| `max-input-tokens-per-session` | 1000000 | 非负安全整数，按预留后结算 |
| `max-output-tokens-per-session` | 100000 | 同上，即使供应商输出免费也计 token |
| `max-retries` | 0 | 整数 0..2，只重试 429 |
| `capabilities` | `[]` | 精确 provider/model 行，含 revision、actual-model-id 与上述三个上界；actual-model-id 是允许的唯一响应 model，非空且不超过256字符；重复匹配视为无效配置 |
| `ledger-max-bytes` | 10485760 | 整数，最低 1048576；达到上限停止新决策，不删除尚在配额窗口内的记录 |

服务挂载不代表启用业务。各功能 mode 默认 off，off 时不构造请求。修改设置不清零已花配额；降低上限至已消费以下，随后请求全部拒绝。配额范围是 `(projectKey,sessionId)`，包含该 session 所有 agent 和 feature；不同项目不共享，父子会话 ID 不同则分别计量。

能力上界是部署契约，不能拿调用方的估算预算代替。官方 Jev 当前的每请求与每问题限制不同；部署网关也可能不同。应根据实际路由声明，不能直接把所有模型配置成相同窗口。[官方上下文说明](https://docs.typesafe.ai/models)

## 执行状态机与预算顺序

每次 run 生成 UUID decisionId，不复用失败请求的 ID。超时为从 run 入口起的总时限，含锁等待、permit、网络和重试等待，不在每次 attempt 重新计时。

1. 检查 signal、请求结构、路由与能力。取消返回 cancelled；缺服务/能力返回 unconfigured；非法 payload 返回 malformed。
2. canonical JSON 序列化完整 state/questions。用现有 estimator 估算 state+所有 questions+envelope+margin，并分别检查每个 state+question；限额为调用方 maxInputTokens 与路由相应窗口的较小值。估算超限不截断、不发请求，返回 unavailable/budget。估算是调度筛选，不是计费上界；业务需要按完整对象分批。
3. 计算完整 inputHash：SHA-256(canonical `{provider,model,routeRevision,state,questions,questionVersion,policyVersion}`)。不把 API key 写进 hash 或记录。
4. 每个 attempt 先向全局 provider 预留一个 attempt、perRequestTokens 输入和 maxOutputTokens 输出；随后向可选业务 provider 申请同样的 token 上界。任一拒绝：其他尚未派发的 permit 以 not-dispatched 结算，返回 budget。
5. 在 fetch 调用前，持久写入 dispatch 记录。写入失败即不能派发，归还本次未派发 permit。之后执行一次原生请求。
6. HTTP 返回后独立校验 usage。usage 合法则按 actual 结算，即使答案语义字段 malformed；usage 不合法、超时或网络状态未知按 unknown 结算，保留完整 token 预留。请求进入 fetch 即算 attempt，429 也算，不假设失败免费。
7. 只有完整 S1-01 校验成功、响应 model 精确等于 trusted actual-model-id、actual usage 未超过能力上界、结算成功时才返回 answered。配置的 wire model 可为网关部署名，不能用它代替 actual-model-id；响应版本不符按实际 usage 结算后返回 error/model-version-mismatch。否则 unavailable。对已派发请求不因 caller 取消而退款。
8. 429 可按现有延迟规则进入下一 attempt，但先重新预留；不得把同一个 permit 用于多个 attempt。成功、malformed、401/403、其他 HTTP 错误均不重试。最多 `1+max-retries` 次，重试等待仍受现有 3000ms 总等待预算与 run 总时限约束。

client 增加可选 `attemptObserver`，两个方法：`beforeDispatch({attempt,signal}) => Promise<boolean>` 和 `afterDispatch({attempt,usage?:SystemOneUsage}) => Promise<void>`。false/异常使请求不进入 fetch；观察器异常转换 error。runner 将 before/after 映射为上述 permit 生命周期。未派发取消由 runner finally 结算。legacy 不传 observer 时行为不变。after 需要在读完 response body 后、答案校验前执行，并在异常退出时由 finally 用未知 usage 补一次。每个 permit 分别维护 `settlementInvoked` 与 `settlementSucceeded`，在进入 settle 回调之前先置 invoked=true。某个 settle 抛错时不得在 finally 再对它调用 unknown，也不得覆盖已结算的其他 permit。未调用过的 permit 才用已知 actual 或 unknown 结算；回调失败的 provider 保留最后持久 reserve、冻结其预算并使本次返回 error。释放未派发 permit 也遵循同样的单次调用规则。测试必须分别注入 business settle 失败和 business 已成功/global settle 失败两个切点。

## 持久配额与并发

目录为 `<dshHome>/decision-usage/<projectKey>/<encodedSessionId>/`；projectKey 来自宿主 cwd，session ID 使用 harness encodeSegment，不能拼接用户输入路径。该目录含 `usage.jsonl` 和短期事务锁 `quota.lock`。

reserve、settle、恢复均在同一短事务锁内：`open('wx',0600)` 获取锁，最多等待 100ms，每 20ms 重试；失败视为 budget，不抢锁。锁仅保护读账本、校验上限和追加记录，不跨网络等待。v1 不自动删除任何已有锁，进程崩溃遗留锁只使新调用停止；诊断显示固定 `quota-lock-unavailable`，人工确认无使用者后清理。这样不会复用现有 VWA torn-lock 回收逻辑或引入活锁误删。

追加 reserve/dispatch/settle JSONL 后必须 `fsync` 成功才完成事务。reserve 的 leaseId 为 decisionId+attempt，settle 幂等：重复相同终态不再收费，冲突终态冻结配额。全局和业务 permit 获取顺序固定为 global→business，结算相反顺序，不同时持有两个文件锁。

恢复时未配对 reserve 按完整额度继续占用；只有持久存在 not-dispatched 才可退款。尾部半行导致账本不完整时冻结该 session 配额并返回 budget，不能静默跳过后继续发请求。只读报表可以展示完整行并标记账本损坏。若 actual-model-id 与响应版本不匹配，不应用结果并记录固定版本错误，但不退款。若 usage 超过预留上界，记录实际值和 `accounting-overrun`，冻结该 session 后续请求，当前结果不可用于业务动作。

## 账本、隐私与报告

每条 schemaVersion=1 记录含 eventId、decisionId、attempt、phase（reserve/dispatch/settle/outcome）、时间、scope、feature、mode、provider、requestedModel、actualModel、routeRevision、questionVersion、policyVersion、inputHash、预留/实际 token、latencyMs、固定 outcome/reasonCode。attempt 尚无响应时 actualModel 为 null。禁止记录 API key、baseURL 查询串、state、questions 正文、路径、原始错误体或模型答案。

业务可以另存其已有权威对象 ID 和决策的固定标签，但不得重复计算 usage。账本不充当语义缓存，也不重放决策；缓存命中应由业务标为本地事件，零 attempt。跨进程不能自动共享内存缓存。

`/cost` 增加独立 `SystemOne decisions` 段，按 actualModel/provider 与现有 modelTable 匹配价格；输入输出分别折算，不把免费输出硬编码到全体服务。未知用量显示“预留上界，未确认”；未配置价格显示 unpriced，不当成 0 美元。生成模型原段保持原算法，合计区分 confirmed subtotal 和 incomplete，不伪造精确总费用。usage ledger 的 eventId 去重；一条决策多次 attempt 全部计入，业务 outcome 不再次计费。

## 故障表与示例

| 情况 | 预算结果 | 业务结果 |
|---|---|---|
| 关闭特性 | 无 run、无账本、无成本 | 原行为 |
| provider 能力缺失 | 无 reserve | unconfigured |
| 全局准入通过，VWA 准入失败 | global not-dispatched 退款 | budget |
| fetch 后超时 | 两个 permit unknown，全额保留 | timeout |
| 答案无效，但 usage 为 900/20 | actual 结算 900/20 | malformed |
| 429 后重试预算不足 | 已派发计费，未派发不计费 | budget |
| 账本写入失败 | 不启动新 fetch；已派发保留预留 | error |
| caller abort | 派发前退款，派发后不退款 | cancelled |

例：路由输入上界 16000，输出上界 2000，全局剩余输入 20000。A/B 并发各请求一次，只能有一个成功 reserve。A 最终 actual=1000/20 后归还差额，B 的已拒绝请求不自动重启；由下一次业务触发决定是否再调用。不能在任务级无限重试。

## 独立实现任务与测试

- [ ] 创建纯 runner 和 fake providers，先验证伪造 scope 零 reserve/零 fetch、返回模型版本不符已计费但不行动、两个并发请求不能超额预留、可选 provider 拒绝时无 fetch。
- [ ] 创建支持 fsync 的持久账本/配额模块。测试 crash 在 reserve 后、dispatch 后、settle 半行三个切点；重启均不得白送额度。
- [ ] client observer 和 maxRetries 加法兼容改造。测试 429→429→success 分别三次 reserve/settle；新 runner 默认一次，legacy 默认最多三次。
- [ ] 挂载可选服务及 trusted settings，缺能力无请求；明确 project/local 无法提高配额或更换能力上界。
- [ ] `/cost` 合并读账本。测试相同 eventId 重复、未计价模型、unknown 用量、0-token 合法响应和多个 actualModel。
- [ ] VWA fake provider 测试 reserve 拒绝、settle 幂等与本地生成审查预算共享，不需要启用 S1-07/08。

创建 `systemone/tests/decision.spec.ts`、新包 `tests/{quota,ledger,service}.spec.ts`、command-cost `tests/decision-cost.spec.ts`，执行：

```sh
pnpm exec vitest run packages/llm-tuning/systemone/tests
pnpm exec vitest run packages/observability/decision-usage/tests
pnpm exec vitest run packages/session/command-cost/tests
pnpm check:spec-deps
pnpm check:inject
pnpm typecheck
```

通过标准是所有状态机测试 exit 0、无超配额派发、零重复结算、关闭模式无网络。真实部署用一次成功和一次可控超时对照账本与供应商用量；不能用模拟测试宣称真实费用准确。实现时补双语 README、能力 manifest、生成 parity 与配置快照中的插件归因。

## 回退

先关闭所有新特性 mode，再移除服务挂载。保留只读账本和 `/cost` 解析，以便审计历史费用；回退不得删除已经消耗的配额。v1 不自动恢复损坏账本，不扩展权限 legacy 的容错策略。
