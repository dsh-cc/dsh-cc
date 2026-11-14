# @dsh-cc/compaction-basic

[English](README.md) | 中文

CC 压缩引擎：上游 `BasicCompactionEngine` 的子类，共两处扩展。第一处是按 agent 记录的 `/compact [instructions]` 保留提示，由 `summarize()` 钩子将其作为一条额外的用户消息并入摘要器输入。第二处是 TUS 消费方：在应用提示之后，`summarize()` 会把符合条件的工具结果替换为 tool-use-summary 的摘要。其余部分（选择、保留、持久化）保持久经验证的上游重放不变。

## 用法

```ts
import CcBasicCompactionEngine from '@dsh-cc/compaction-basic'
import { setCompactHint, takeCompactHint, applyCompactHint } from '@dsh-cc/compaction-basic'

// 设置该 agent 下一次压缩会遵循的保留提示。
setCompactHint(agent, 'Keep the migration plan and open TODOs')

// 引擎在 summarize() 内消费该提示（take = 读取并清除），
// 因此同一 agent 的后续压缩从无提示状态开始。
```

- `CcBasicCompactionEngine` — `BasicCompactionEngine` 的即插即用子类；其 `summarize()` 覆写会先应用已停放的提示、再执行 TUS 替换，两者都不适用时输入原样透传。
- `setCompactHint(agent, hint)` — 为 `agent` 停放一条提示（后写覆盖先写）。
- `takeCompactHint(agent)` — 取出并清除已停放的提示；没有时返回 `undefined`。
- `applyCompactHint(input, hint)` — 将提示作为一条额外用户消息追加到摘要器输入的重放消息末尾；空/纯空白提示返回原输入（同一引用），因此裸 `/compact` 与上游逐字节一致。
- `applyTusSummaries(input, dshHome, sessionId)` 把符合条件的工具结果替换为 TUS 摘要（`@dsh-cc/tool-use-summary`）：当存在一条 `ok` 行且其摘要对应消息的 `source.callId`、且消息体尚不是 context-crusher 桩时，该结果符合条件。无摘要行、无 dsh home 或无会话 id 时返回原输入，该调用绝不抛错。
- `TUS_CONSUMER_PROBE` 是持久化的探针记录，说明使逐结果 `callId` 身份可用的上游接缝。

## 备注

- 提示存放在以活跃 agent 为键的 `WeakMap` 中，因此绝不会跨 agent 泄漏，并随 agent 对象一起消亡。
- TUS 扩展把 `@dsh-cc/tool-use-summary` 声明为 peer 依赖，并通过共享的 `@dsh-cc/sidecar-io` dsh-home 解析器（直接依赖）读取账本路径。
