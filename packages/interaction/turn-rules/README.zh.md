# @dsh-cc/turn-rules

English | [中文](README.zh.md)

（中文说明，与英文版实质等价。）

Turn rules：一个非中断式规则引擎，只在模型越轨时触发。携带 `trigger` 的 Cursor 插件规则在正则匹配到已完成的工具调用/结果或用户提示之前不占用任何上下文；首次匹配时，规则正文在恰好该接缝处作为**建议性提醒**注入。**默认开启但零影响**（`cc-turn-rules.enabled: true`）——默认不存在任何携带触发器的规则，开启即行为中立。

## 工作方式

插件在挂载时（`apply()` 快照）经 `@dsh-cc/plugin-loader` 重新发现已安装且启用的 cursor 插件规则语料，并注册三个监听器（普通插件，无 Service、无 isolate key）：

- **`tools/post-execute`** —— 在下游决策之后（组合在 context-crusher 之后，因此匹配文本就是模型实际收到的压缩后文本），序列化有界单元——`JSON.stringify(exec.arguments)` + accept 的文本内容——按 UTF-8 截断到 200 KB，并在其上求值触发规则。每条新触发的规则向同一条 accept 决策追加一条 `additionalContexts` 用户消息；结果的 `content` 永不重写。
- **`agent/pre-step` + `agent.inject`** —— 提示通道：由非注入消息构建候选文本（注入的 `turn-rules` 消息在拒绝列表中——规则永远匹配不到自己的提醒），按待处理文本去重；每条触发的规则注入一条带来源的消息（`source.kind: 'turn-rules'`，像 memory-recall 正文一样渲染——绝非"隐藏"）。
- **`agent/turn-stopping`** —— 递增每会话轮次计数器并持久化已触发状态账本。

已触发状态存于 `$DSH_HOME/turn-rules/<sessionId>.json`（`{ version, turnCounter, fired: { ruleKey: firedAtTurn } }`，临时文件+重命名的原子写）；进程内每会话映射是防重复触发的权威闸门。重复策略：`repeat: once`（默认）或 `repeat: after-gap` 加 `repeatGap` 个轮次间隔（默认 10）。两个通道均为仅顶层——子代理的执行永不触发、也永不消耗会话规则。

所有故障均向开启侧失效：任何内部故障都退化为透传加调试计数；监听器绝不能把工具结果变成错误。

## 规则 frontmatter

```yaml
---
description: Prefer Arc<str> over Box::leak in production paths
trigger: \bBox::leak\b          # JS 正则源；含 YAML 特殊字符时需加引号
triggerOn: [tool-results, user-prompts]   # 默认：两者
repeat: once                    # once | after-gap（默认 once）
repeatGap: 10                   # 重新武装前的轮次间隔；默认 10
---
```

不带 `trigger` 的规则字节级不受影响（索引/系统提示行为不变）。

## 配置（仅用户层）

用户层 `settings.json`（harness-home 文件）中的 `cc-turn-rules` 键。**永不读取**项目作用域——结构上不可见，并非"被拒绝"。

| 键 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关。 |
| `max-result-bytes` | `200000` | 匹配单元的 UTF-8 截断上限。 |
| `regex-cache-size` | `64` | 编译正则 LRU 容量。 |
| `judged.enabled` | `false` | 第二阶段 LLM 评判规则；默认关闭。 |

## 形态

普通 cordis 插件（无 Service、无 isolate key）。由 `packages/preset/cc` 挂载在 cc-services 组，紧跟 edit-recovery-hint 之后（因此在 context-crusher 之后：CCR 最外层，turn-rules 在其内组合）。注入仅为建议性——本引擎绝不阻断工具调用。
