# @dsh-cc/compaction-micro

[English](README.md) | 中文

可安全回放、不依赖模型的微压缩（microcompact）服务（`ctx.microcompactor`）。它会原样保留最近的 `retainResults` 个 `tool/result` 表层节点，并将更早的节点替换为确定性的占位摘要；若原始结果引用了 spill 文件的 locator，占位摘要会重新嵌入该 locator——全程不发起模型调用，也不做摘要。

这是 [`dsh-compaction-basic`](../compaction-basic/README.md) 的具体配套服务，不是压缩（compaction）后端。它在摘要之前合成运行，使摘要器读到已经过窗口收缩的表层。两个包仍可各自独立组合。

## 服务 API

`microcompactSession(session)` 会扫描当前表层的一个稳定快照。最近的 `retainResults` 个工具结果被原样保留；每个更早的、尚未成为占位符的结果，都会被一个新追加的 `tool/result` 替换，其携带 `{ surfaceOp: { op: 'replace', start: originalSeq, end: originalSeq }, sourceEventSeqs: [originalSeq] }`。替换会展开完整原始数据，只更改 `content`，保留 `turn`、`step`、`callId`、错误字段、`meta` 以及以后新增的数据字段。原始事件仍可用于持久化、回放和精确日志检查。

每次替换都紧接着一条 `compaction/prune` 影子价格事件（通过注入的 token meter 为被遮蔽节点定价），后面还跟一条 `compaction/microcompact` 决策记录，记录被遮蔽的 `originalSeq`、`replacementSeq`、共享的 `callId` 以及重新嵌入的 `spillLocator`。这些共同保证决策可从日志重建。

当会话拒绝替换时，该方法会同步抛出异常。本次扫描中先前已提交的替换仍会保留。

`isMicrocompactPlaceholder(blocks)` 报告内容列表是否已携带占位符标记；`reuseSpillLocator(text)` 提取渲染出的 spill locator 句子以供重新嵌入。

## 冻结语义

将某个工具结果折叠的决策只做一次，并在会话内保持稳定。占位符始终以固定的 `[... tool result compacted ...]` 标记开头，后续扫描会依据该标记识别已折叠的结果，绝不再做二次决策。因此对未变化历史的重复执行会生成逐字节一致的提示：重复通过的表面上没有任何改变（`stable` 为 `true`，且不会落地任何替换），从而保持提示缓存的复用。

## 配置

无法识别的配置键会使插件在构造时失败。已解析配置与输入脱离，并且深度不可变。

| 配置键 | 必填 | 含义 |
|---|---|---|
| `retainResults` | 否（默认 `10`） | 原样保留最近的 N 个工具结果，更早的结果可被折叠。 |
| `auto` | 否（默认 `false`） | 注册一个 `agent/pre-step` 钩子，在回合请求之前折叠过期结果。 |
| `placeholderChars` | 否（默认 `256`） | 生成占位符的最大文本码点数（不包含重新嵌入的 spill locator）。 |

所有值都必须是整数；`retainResults` 与 `placeholderChars` 必须为正数。

## 用法

```ts
import type { Context } from '@deepseek-ai/cordis'
import Microcompactor from '@dsh-cc/compaction-micro'

export function apply(ctx: Context): void {
  ctx.plugin(Microcompactor, { retainResults: 4 })
}
```

## 模型体验

### 被折叠的工具结果

#### 模型看到的内容

窗口外的工具结果显示为确定性占位符。若原始结果引用了 spill 产物（例如 `Full grep result stored at: …`），占位符会重新嵌入该 locator 句子，使模型仍能读取完整结果。

#### Token 影响

每个被折叠结果都被替换为至多 `placeholderChars` 个文本码点的占位符。微压缩本身不发起模型调用。

#### KV Cache 影响

替换较早的结果会使从第一个改变的 token 起的复用失效。剩余前缀（包括原样保留的窗口尾部）在路由、envelope 与之前历史保持不变的情况下可复用。冻结决策避免重复执行再次失效缓存。

## 已知限制与暂缓事项

- **只按窗口、不看语义**：结果仅依据表层新旧程度折叠，而不考虑模型当前是否仍需要它。
- **spill locator 复用是尽力而为**：它匹配 `dsh-tool-fs` 类 spill 页脚使用的渲染 `stored at:` 措辞；若某个工具以不同措辞呈现 locator，则不会重新嵌入。
- **字素簇可能被拆分**：占位符截断按码点切片，可保护代理项对，但不执行感知区域设置的字素簇分割。
