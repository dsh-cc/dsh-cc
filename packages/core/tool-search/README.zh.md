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

词法排序看不见与工具元数据不共享任何字面词元的查询——中文问题对上英文元数据，或同一个请求换一种说法。可选的发现层在既有激活路径前加一次独立的相关性判断：每个已准入的延迟候选都通过 System One 决策运行时针对查询打分（该运行时即 `decision-usage` 插件提供的可选 `ctx.systemoneDecisions` 服务），只有相关性判断**与**直接匹配度都越过阈值的候选才会成为激活项。工具名、schema 与返回消息仍由确定性代码产生；模型只回答"这个候选是否相关"，每个候选一对问题，因此一个候选的元数据不会污染另一个的判断。

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

离线评估器针对一份脱敏 fixture 回放纯策略层——人工目标集加上词法对照，分为中文、同义词、无相关工具、受限工具四个子集——全程不访问网络：

```bash
node packages/core/tool-search/scripts/eval-discovery.mjs \
  --corpus packages/core/tool-search/tests/fixtures/discovery-corpus.json --mode replay
node packages/core/tool-search/scripts/eval-discovery.mjs --mode selfcheck
```

`--mode replay` 按子集打印 Recall@3 并与词法对照并列，同时给出激活精确率、准入泄漏与可复现性检查，只输出聚合数字与用例 id——绝不输出查询文本。`--mode selfcheck` 只校验语料 schema。

## 模型体验

第一轮，模型只看到 `ToolSearch` 加已加载的（包括 `alwaysLoad` 的）工具——而在完全没有延迟工具的会话里，连 `ToolSearch` 也不出现。它按关键字搜索某个能力，结果里点名现在可用哪些工具。下一轮这些工具就成头等公民：声明它们，调用它们。已加载的工具会退出延迟集合，因此再次搜索它们会正确地得到空结果。

空搜索结果总会说明*原因*，模型绝不会把“没有延迟工具”误读为“我没有这个能力”：池为空时回复“你可用的工具都已在 function list 中，直接调用”；池已全部加载时回复“你可用的延迟工具都已加载，直接调用”；池非空但无匹配时返回“没有延迟工具匹配 "<query>"。本目录只列出延迟工具；提前注册的工具（包括提前注册的 MCP 工具）不会出现在这里——它们已在 function list 中，直接调用即可”。

## 已知限制与暂缓事项

- **匹配是词法的，除非启用了发现层。** 排序用加权的子串/词元打分；没有嵌入/向量检索。可选的 S1-05 层为同义词与中文查询补上一次模型相关性判断，但它默认关闭，且任何失败都会回退到词法路径。
- **全局激活。** 加载发生在宿主平面（全局注册）；某个 per-agent 作用域只有在它的限制放行时才能看到已加载的工具。没有按会话的记忆历史——加载是内存里的 effect，因此重新组装后又会从延迟池重新开始。
