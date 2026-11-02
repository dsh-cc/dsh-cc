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

## 模型体验

第一轮，模型只看到 `ToolSearch` 加已加载的（包括 `alwaysLoad` 的）工具——而在完全没有延迟工具的会话里，连 `ToolSearch` 也不出现。它按关键字搜索某个能力，结果里点名现在可用哪些工具。下一轮这些工具就成头等公民：声明它们，调用它们。已加载的工具会退出延迟集合，因此再次搜索它们会正确地得到空结果。

空搜索结果总会说明*原因*，模型绝不会把“没有延迟工具”误读为“我没有这个能力”：池为空时回复“你可用的工具都已在 function list 中，直接调用”；池已全部加载时回复“你可用的延迟工具都已加载，直接调用”；池非空但无匹配时返回“没有延迟工具匹配 "<query>"。本目录只列出延迟工具；提前注册的工具（包括提前注册的 MCP 工具）不会出现在这里——它们已在 function list 中，直接调用即可”。

## 已知限制与暂缓事项

- **匹配是词法而非语义的。** 排序用加权的子串/词元打分；没有嵌入/向量检索。这让接缝保持零依赖且确定，代价是无法命中不共享词元的同义词。
- **全局激活。** 加载发生在宿主平面（全局注册）；某个 per-agent 作用域只有在它的限制放行时才能看到已加载的工具。没有按会话的记忆历史——加载是内存里的 effect，因此重新组装后又会从延迟池重新开始。
