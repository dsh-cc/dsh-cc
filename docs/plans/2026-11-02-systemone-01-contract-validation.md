# SystemOne 请求与响应契约校验

状态：提案，尚未实现。特性 ID：S1-01。优先级：P0。

源码基线：`31fb29eb77148e92ca8da365adcbf4994622a31d`。本设计可单独实现，不依赖其他新增特性。设计集入口见[总览](2026-11-02-systemone-00-overview.md)。

## 目标问题与现有行为

[`systemoneDecide`](../../packages/llm-tuning/systemone/src/client.ts) 是权限、提示注入探测和 MOA 共用的原生 HTTP 客户端。当前 `parseAnswer` 只检查字段的 JavaScript 类型；未知类型被丢弃，只要剩余答案非空即可成功。答案可能缺少请求的问题，或包含不属于候选集合的选项。usage 缺失时按零处理。

[`gateVerdict`](../../packages/interaction/permission-rules/src/gauge-adapter.ts) 在 `choice === 'allow'` 时，只有对应概率存在且低于阈值才返回 ask。`{type:'choice',choice:'allow',probabilities:{}}` 因而能在该函数返回 allow。此结论只描述该函数，不代表完整权限链一定执行动作。

目标是让客户端成功返回意味着：所有请求问题都有可用、类型匹配的答案，数值有效，候选集合一致，usage 可核对。决策是否正确仍属于模型评测和业务策略，本特性不提高或降低现有概率阈值。

## 范围与选择

采用客户端集中严格校验，加权限放行函数独立防御。仅在各调用方重复校验会产生差异；信任服务端类型保证则无法覆盖代理、协议漂移和测试替身。

保留 `SystemOneResult` 的成功/失败联合类型和四个 failure 标签。校验失败一律 `failure: 'malformed'`。不引入模型、SDK、运行时依赖或新的设置开关。所有客户端调用立即使用严格校验，这是缺陷修复，不是新增默认启用的模型判断。

## 文件与公开接口

| 路径 | 责任 |
|---|---|
| 新建 `packages/llm-tuning/systemone/src/validation.ts` | 请求感知的纯校验器与错误码 |
| 修改 `packages/llm-tuning/systemone/src/client.ts` | 请求预检、调用校验器、返回固定失败信息 |
| 修改 `packages/llm-tuning/systemone/src/index.ts` | 导出校验类型和函数 |
| 修改 `packages/interaction/permission-rules/src/gauge-adapter.ts` | 放行概率缺失或无效时转 ask |
| 新建 `packages/llm-tuning/systemone/tests/validation.spec.ts` | 契约边界矩阵 |
| 扩展现有 client、gauge adapter、MOA 测试 | 端到端回归与旧 fixture 修正 |

```ts
type ValidationCode =
  | 'invalid-request' | 'invalid-envelope' | 'invalid-model'
  | 'question-set-mismatch' | 'answer-type-mismatch'
  | 'invalid-choice' | 'invalid-probabilities'
  | 'invalid-score' | 'invalid-noul' | 'invalid-confidence'
  | 'invalid-usage';

type ValidatedResponse = {
  model: string;
  answers: Record<string, SystemOneAnswer>;
  usage: SystemOneUsage;
};

function validateSystemOneResponse(
  questions: Record<string, SystemOneQuestion>,
  raw: unknown,
): { ok: true; value: ValidatedResponse }
 | { ok: false; code: ValidationCode };
```

`ValidationCode` 只包含固定代码，不能带 state、提示词、候选文本或服务端原文。client 的 reason 固定为 `systemone validation: <code>`。

## 校验规则

### 请求预检

在任何网络请求之前执行，失败返回 malformed/invalid-request，fetch 调用数为零。

- questions 必须为普通 JSON 对象，含 1 至 256 个自有键。问题 ID 长度 1 至 128，匹配 `^[A-Za-z0-9_-]+$`，禁止 `__proto__`、`constructor`、`prototype`。
- instructions 必须为非空字符串。沿用当前公开类型，不在本次扩展为任意 JSON instructions。
- choice 的 criteria 是含 2 至 255 个选项的普通对象，选项 ID 使用上述同一限制，描述为字符串。
- score 的 criteria 是含 2 至 10 个非空字符串的数组，按最低到最高排列。
- noul 的 criteria 可缺省；存在时只能含 true、false 两个字符串键，且二者必须齐全。
- state 必须可 JSON 序列化；拒绝循环引用、BigInt、非有限数字，以及序列化后为 undefined 的值。客户端捕获序列化异常，不向上抛出。
- model 是长度 1 至 256 的非空字符串。timeoutMs 是有限正整数。缺失 apiKey 仍合法，支持不需要该字段的部署网关。

### 响应 envelope 与集合

响应必须为普通对象，model 是长度 1 至 256 的非空字符串。响应 model 可以与请求 alias 不同，但成功结果必须保留服务端 model，不能回填 alias。

answers 必须为普通对象；其自有问题键与请求键完全相等。少一个、多一个、未知类型或类型不匹配均拒绝整个响应，禁止部分消费。JSON 对象顺序不影响判断。

envelope 的未知顶层字段允许存在但不传播。每个答案仅保留当前公开返回类型中的字段；不记录未知字段。所有映射通过 `Object.create(null)` 建立，不把服务端键写进普通对象原型。

### Choice

- choice 是请求 criteria 中的键。
- probabilities 的键集合必须与 criteria 完全相同。
- 每项概率是有限数字，满足 `0 <= p <= 1`；不接受字符串或 null。
- `abs(sum(probabilities) - 1) <= 1e-4`。不对越界值裁剪，不对错误分布重新归一化。
- choice 对应概率不得比最大概率低超过 `1e-4`。并列最大时允许服务端返回任意并列选项；业务排序不能依赖这个并列选择。
- confidence 必须为有限数字且位于 `[0,1]`。confidence 与最大选项概率不是同一概念，不互相替代。

### Score

现有公开类型只接受数字索引的概率映射。若 rubric 有 n 级，probabilities 必须包含字符串键 `"0"` 至 `String(n-1)`，且不能有其他键。每个值和总和规则与 Choice 相同。

score 必须有限且在 `[0,n-1]`，并满足与 `sum(i * p[i])` 的差不超过 `1e-4`。允许非整数 score。confidence 必须在 `[0,1]`。服务端可返回 legend，客户端不依赖也不传播它。

### Noul 与 usage

noul 必须为有限数字且在 `[0,1]`。Noul 不要求 confidence。若返回 confidence，则也要校验范围；成功结果只保留 noul 和 type，避免把非标准字段当成策略输入。

usage 必须同时包含 input_tokens 和 output_tokens，二者均为非负安全整数。允许合法的零值，但绝不把缺失值转成零。字段类型不正确或仅存在一个字段均拒绝响应。

### 权限函数独立防御

`gateVerdict` 的 allow 分支必须先检查 `Number.isFinite(pAllow) && pAllow >= 0 && pAllow <= 1`；不满足则返回 `{verdict:'ask',reason:'gauge allow probability missing or invalid'}`。再判断现有 allowThreshold。不改变规则优先级、deny 转 ask、用户授权证据检查、breaker 或模式变更后的 stale 检查。

## 网络、失败与兼容性

沿用 client 当前 429 最多两次重试、总重试等待预算 3000ms、Retry-After 上限 2000ms。HTTP 成功但内容 malformed 不重试。调用方取消仍优先于自身 timeout，二者均不伪装成 malformed。

| 输入或事件 | 结果 |
|---|---|
| 任意一个请求答案缺失 | 整体 malformed，不能使用其他答案 |
| HTTP 200，但 JSON 无法解析 | malformed/invalid-envelope |
| 无 usage | malformed/invalid-usage |
| 概率 0、1 或合法并列 | 成功 |
| 数值 NaN、Infinity、负值、总和超容差 | malformed |
| 未知 envelope 字段 | 忽略，不记录 |
| caller abort 与 timeout 同时可见 | cancelled |
| 服务端正确返回的低置信度结果 | 成功，由业务层决定回退 |

当前测试中依赖缺少 model/usage/概率的简化成功 fixture 必须补成合法 envelope，不能为 fixture 放宽生产校验。S1-02 的 attempt observer 在校验前只允许单独提取符合 usage 规则的计量值；响应判定无效不代表请求免费。

## 实现与验收

- [ ] 创建纯校验器，先加入具体失败用例。`{allow:0.7,ask:0.3}` 在选项为 allow/ask 时通过；缺 ask、总和 0.8、allow 为字符串均失败。
- [ ] 加入完整性用例。请求 a、b 仅返回 a，或额外返回 c，整体失败；相同集合不同顺序成功。
- [ ] 加入 Score 用例。三级分布 `{0:0.25,1:0.5,2:0.25}` 对 score=1 成功，对 score=2 失败。
- [ ] client 对接校验器，确认预检失败不发请求，malformed 不触发重试，429 时仍遵守现有限额。
- [ ] gauge 回归：allow 加空概率、NaN、负数均 ask；合法 allow 低于阈值仍 ask；规则直接拒绝不进入此函数。
- [ ] 更新现有消费方 fixture，跑以下命令，结果均须 exit 0。

```sh
pnpm exec vitest run packages/llm-tuning/systemone/tests
pnpm exec vitest run packages/interaction/permission-rules/tests/gauge-adapter.spec.ts
pnpm exec vitest run packages/interaction/moa/tests
pnpm typecheck
```

实现前按仓库要求执行 `pnpm install --frozen-lockfile`。新测试文件必须在所属 package 声明其直接依赖。更新 systemone README 双语契约说明；权限可见行为修复要更新能力 manifest 的对应证据并运行 `pnpm docs:parity`。

## 发布与回退

发布前用每个部署路由的一份脱敏真实 envelope 做契约测试，重点核对 Score 概率索引形状。无法满足契约的路由不得用于新特性；先修网关适配，不放松调用方策略。此测试只验证协议，不宣称语义可靠。

回退按客户端与消费方作为一个提交单元回退。即使因兼容问题回退集中校验，也保留 gauge 缺失概率转 ask 的独立修复；不得重新引入缺失概率即 allow 的行为。
