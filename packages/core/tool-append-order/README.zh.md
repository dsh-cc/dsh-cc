# @dsh-cc/tool-append-order

[English](README.md) | 中文

`system-prompt/assemble` 瀑布上的缓存稳定工具排序：每个 scope 输出的工具序列保持原有位置，新出现的工具按字典序追加到尾部。DeepSeek 的上下文缓存以请求前缀为键，因此本包可避免 ToolSearch 激活或 MCP 注册把后续所有工具整体后移、使已缓存前缀失效。

## 用法

本包是一个 cordis 插件，除注册外没有可导入的 API：

```ts
import { apply } from '@dsh-cc/tool-append-order'

apply(ctx) // 监听 `system-prompt/assemble`，通过 `prepend` 置于最外层
```

## 提供内容

- 某个 scope 的首次组装，直接透传 harness 基线（并记录下来）。
- 后续组装中，仍然存在的工具保持其被记住的位置；新出现的工具按字典序追加到尾部。稳态是只追加：激活只扩展工具列表，不会移动它。
- 不再出现的名字被丢弃；重名保留第一个 schema。
- 无 scope 的全局组装直接透传——没有 scope 就没有键来记录序列。

## 备注

- cordis 瀑布组合中，最外层监听器拥有最终决定权，因此本监听器以 `prepend` 注册为最外层，与名册位置无关；预设行本身仍保持在最底部。
- 每个 scope 的序列记忆存放在以 scope 为键的 `WeakMap` 中，随 scope 对象一起消亡。
- Item 6 的 L0 前缀稳定性 e2e 是这一契约的长期哨兵。
