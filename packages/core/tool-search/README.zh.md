# dsh-tool-search

[English](README.md) | 中文

延迟工具注册，外加一个模型可见的 **ToolSearch** 工具，按需加载重工具。一个加载成本高、或提示词里占用 token 很多的工具，可以**延迟**注册：它只贡献名字、描述和搜索提示到这个可搜索的注册表，真正的定义在模型主动索要之前始终**不进模型可见的 schema 与提示词**。

## 为什么要延迟工具

每一个可见的工具 schema 都要花提示词 token，重工具还要花加载时间。大多数会话只需要一个大目录里的一小部分工具。延迟机制以很低的成本携带*能力元数据*，只有当模型真正召唤时才加载实体定义——把 `shouldDefer`/ToolSearch 机制（以及 MCP 的 `_meta['anthropic/alwaysLoad']` 逃生舱）泛化进本仓基于 effect 的注册表模型。

## 它做什么

[`DeferredToolRegistry`](src/index.ts) 就是 `ctx.toolSearch` 服务。插件可以这样延迟注册一个能力：

```ts
ctx.toolSearch.registerDeferred({
  name: 'big_fs_tool',
  description: 'Heavy filesystem capability invoked once per session.',
  searchHint: 'read write edit files',
  alwaysLoad: false,
  activate: () => ctx.tools.register(bigFsToolDefinition), // returns the exact disposer
})
```

**ToolSearch** 模型工具随后针对 `query`（`max_results`，默认 5）对延迟集合做排序——在名字、`searchHint`、描述上做加权的子串/词元匹配。命中后就调用该注册的 `activate()` 回调——一次真实的 `ctx.tools.register()`——于是该工具在**下一轮**组装中变得可见，此后与任何提示词顶部的工具无异地被调用。`alwaysLoad: true` 在延迟之时立即注册，且永远不会成为延迟候选。

这套设计贴合本仓的 effect 约定：

- **延迟注册本身就是 effect。** 返回的 disposer 会连同回收延迟条目*以及*任何已激活的 `ctx.tools` 注册，因此插件在会话中途卸载时，两者一起被拆除。
- **激活是幂等的。** 再次激活一个已加载的工具是空操作；重复注册（否则会因重名而抛错）绝不会发生。
- **限制仍然优先。** `registerDeferred` 会在 `dsh-tools` 注册表里预留这个工具名（已知但不可见），因此局部的 `restrict()` 可以在它*加载前*将其拒绝。ToolSearch 会检查这道闸：被某个作用域拒绝的延迟工具，绝不会为该作用域激活，结果里会说明原因。
- **延迟名字永不泄漏进提示词。** 只有已激活（`alwaysLoad` 或已加载）的工具才进 schema；被预留而未加载的名字仅用于限制/`toolOrder` 判定，不对外可见。
- **ToolSearch 自身懒注册、带迟滞。** 可搜索池为空时只预留 `ToolSearch` 这个名字（可限制、不可见）；首个非 `alwaysLoad` 的延迟注册才把它带进模型可见集，此后即使池再次清空也保持注册——会话中途注销会移动组装后的工具顺序、击穿缓存前缀。空池时该工具"工具被隐藏、搜索后加载"的描述会主动误导模型，这正是它在空池时不展示的原因。

## 语义工具发现（S1-05）

词法排序看不见与工具元数据不共享任何字面词元的查询——中文问题对上英文元数据，或同一个请求换一种说法。可选的发现层在既有激活路径前加一次独立的相关性判断：每个已准入的延迟候选都通过 System One 决策运行时针对查询打分（该运行时即 `decision-usage` 插件提供的可选 `ctx.systemoneDecisions` 服务，或在决策组之外挂载时由 `@dsh-cc/decision-usage` 发布的 root realm 桥 `ccSystemoneDecisions`），只有相关性判断**与**直接匹配度都越过阈值的候选才会成为激活项。工具名、schema 与返回消息仍由确定性代码产生；模型只回答"这个候选是否相关"，每个候选一对问题，因此一个候选的元数据不会污染另一个的判断。

该层**默认关闭**，且绝不会自行改写词法路径：

| `mode` | 行为 |
| --- | --- |
| `off` | 默认。零次 runner 调用；`search()` 与 `execute` 与之前完全一致，包括结果顺序与默认五条。 |
| `shadow` | 执行判断并记录建议差异；仍然执行原来的词法命中。 |
| `active` | 按确定性顺序（相关性、直接匹配度、词法分数、名字升序）激活判断出的名字，上限为 `min(max_results, max-activations)`。 |

设置位于 `cc-tool-discovery` 命名空间；原始键为 kebab-case：

| 键 | 类型与范围 | 默认值 |
| --- | --- | --- |
| `mode` | `off \| shadow \| active` | `off` |
| `timeout-ms` | 整数，100–5000；整次发现事务的时间上限 | `1200` |
| `max-input-tokens` | 整数，512–16384；单次 runner 请求，含问题与余量 | `4096` |
| `max-candidates` | 整数，1–128；完整候选池上限 | `64` |
| `batch-size` | 整数，1–16 | `8` |
| `max-query-chars` | 整数，64–8192 | `2048` |
| `max-metadata-chars` | 整数，128–8192；描述与搜索提示各自的合并上限 | `2048` |
| `min-relevance-index` | 有限数，0–4；实验性阈值 | `3` |
| `min-direct-fit` | 数，0–1；实验性阈值 | `0.75` |
| `max-activations` | 整数，1–20 | `3` |
| `cache-entries` | 整数，0–1024；为零则关闭缓存 | `128` |
| `cache-ttl-ms` | 整数，0–300000 | `60000` |

这些阈值是第一轮评估参数，而非已测的质量保证。任何一个值非法都会彻底关闭判断：不调用 runner，运行词法路径，并通过 `ctx.logger.warn` 只报告一次。同样的整路回退也适用于路由、服务或完整答案缺失，以及越过任何硬性边界的情况——查询或元数据字段过长、候选池超过 `max-candidates`、批次无法拆成装得进请求窗口的整组、超时、调用方取消，或激活前目录/权限发生变化。部分判断绝不与词法命中混合；判断有效但没有找到相关工具时不激活任何东西（不会用词法命中回填）。准入在两端都检查：作用域拒绝的候选根本不进池，`activate()` 在加载前再查一次权限闸，因此推荐绝不会扩大作用域。

离线评估器（`scripts/eval-discovery.mjs`）只针对一份本地脱敏语料运行，全程不访问网络。它有四种模式：

| `--mode` | 用途 |
| --- | --- |
| `replay` | **oracle 完整性钉。** 判断由每个用例的 `expectedNames` 合成，因此这里的 F1 在构造上就是同义反复。它只作纯策略层钉——候选池、问题、分批、打分与选取，对照脱敏 fixture——永不因 F1 被门控。 |
| `selfcheck` | **语料健康度。** 校验 schema、既有的 subset 下限，以及按类的覆盖下限。 |
| `judge-stub` | **CI 运行的 F1 门禁臂。** 一个冻结的、故意不完美的关键词/规则打分器对候选元数据打分，驱动真实策略层；金标只用于算分，绝不参与判断，因此 F1 线既有意义又是确定性的。 |
| `live` | **证据臂，不做门禁。** 用真实的 `createDiscoveryRuntime` 通过脚本化的假 lane 适配器跑：共享同一截止时间的多批序列、超限候选池、`unavailable`、取消，以及 `exact` 短路。 |

`judge-stub` 的阈值在设计文档（§ Scoring，计分）里预先登记，且只对 tune 划分生效：受限 micro-F1 总体 ≥ 0.85；对至少有 12 条（且有正样本）的类，受限 micro-F1 ≥ 0.80；而 negative-only 类没有正样本、F1 无定义，故改为门控误激活率 ≤ 0.10 与精确集合准确率 1.0。

**语料 schema v2**（`scripts/lib/eval-corpus.mjs`）：`{ schemaVersion: 2, corpusVersion, description?, cases[] }`。`corpusVersion` 是整数，用例一变就递增，每份报告都会带上它。每个用例带一个 `class`——即门控维度，取值为 `direct-fit`、`lexical-trap`（词法重叠/错误服务陷阱）、`multi-intent`、`negative-only`（`expectedNames: []`）、`keyword-stuffing`（元数据关键词堆砌）——外加可选的 `alsoClasses` 声明多标签归属；正是靠它在不做排他划分的前提下也能达到每类 ≥ 12 条归属。既有的 `subset: chinese|synonym|none|restricted` 过滤及其下限保留。查询不得等于某个候选的 `name`：精确名字查询会在判断器被调用之前短路，这种用例根本量不出判断质量。

**划分。** `--split tune|held-out|full`（默认 `tune`）。按用例 id 的哈希排序把语料切成 2/3 tune、1/3 held-out；只有 `tune` 会被门控，`held-out` 留给一次性的翻转评估，`full` 用于检视。

**语料。** `--corpus <path>` 让评估器改用另一个本地语料文件；默认值为 `packages/core/tool-search/tests/fixtures/discovery-corpus.json`，文件不可读时以状态码 2 失败退出。

两种运行方式：

```bash
node packages/core/tool-search/scripts/eval-discovery.mjs --mode <mode>
pnpm --filter @dsh-cc/tool-search run eval:discovery -- --mode <mode>
```

每种模式只输出聚合数字、类标签与用例 id——绝不输出查询文本、候选描述或备注。`replay` 另按子集打印 Recall@3 并与词法对照并列，给出激活精确率、准入泄漏与可复现性检查；`judge-stub` 打印按类的 F1 表与门禁结论；`live` 断言故障电池，并无门控地报告 micro-F1 与标称/尾部延迟（这个规模的语料上 p95 只是第 3 大样本）。CI 只跑 `selfcheck` 与 `judge-stub`，没有任何模式需要联网。

## 模型体验

第一轮，模型只看到 `ToolSearch` 加已加载的（包括 `alwaysLoad` 的）工具——而在完全没有延迟工具的会话里，连 `ToolSearch` 也不出现。它按关键字搜索某个能力，结果里点名现在可用哪些工具。下一轮这些工具就成头等公民：声明它们，调用它们。已加载的工具会退出延迟集合，因此再次搜索它们会正确地得到空结果。

空搜索结果总会说明*原因*，模型绝不会把“没有延迟工具”误读为“我没有这个能力”：池为空时回复“你可用的工具都已在 function list 中，直接调用”；池已全部加载时回复“你可用的延迟工具都已加载，直接调用”；池非空但无匹配时返回“没有延迟工具匹配 "<query>"。本目录只列出延迟工具；提前注册的工具（包括提前注册的 MCP 工具）不会出现在这里——它们已在 function list 中，直接调用即可”。

## 已知限制与暂缓事项

- **匹配是词法的，除非启用了发现层。** 排序用加权的子串/词元打分；没有嵌入/向量检索。可选的 S1-05 层为同义词与中文查询补上一次模型相关性判断，但它默认关闭，且任何失败都会回退到词法路径。
- **全局激活。** 加载发生在宿主平面（全局注册）；某个 per-agent 作用域只有在它的限制放行时才能看到已加载的工具。没有按会话的记忆历史——加载是内存里的 effect，因此重新组装后又会从延迟池重新开始。
