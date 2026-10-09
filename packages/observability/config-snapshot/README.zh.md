# @dsh-cc/config-snapshot

[English](README.md) | 中文

会话配置快照侧账本——每次 Session 构造一行的归因底账。每次 Session 构造都会向 `<dshHome>/config-snapshot/<encodedId>.jsonl` 追加一行 JSONL，记录产生该会话的配置：dsh-cc 版本、harness 版本（宿主提供时，否则为 null）、进程默认预设 id，以及可见的市场/用户插件安装清单（带加载器的逐 id 选中标记）。消费方直接用原始 `session.id` 关联——文件名使用 id 的 `encodeSegment` 编码形式，敌意 id（`../`、`/`、`..`）仍保持为单个安全路径分量。

## 行结构

每次构造一行：`{schemaVersion, sessionId, seq, bootId, appendedAt, dshCc, harness, preset: {id}, plugins, note?, delegationDepth, parentSession, origin}`。`seq` 是写队列分配的每文件单调计数器；`bootId` 每次插件激活一个。插件行按 id 再按 scope 排序；每个启用 id 恰有一行带 `loaderSelected: true`（`lastUpdated` 最大者，平局取后出现的条目），对齐运行时加载器的发现规则。消费方将时间 `t` 的转写事件归因到 `appendedAt` ≤ `t` 的最大者（平局按 `seq`）；无符合行即 UNKNOWN——刻意不回退到最早一行。

## 失败纪律

只做观测，永不在行为路径上：同步 `session/created` 监听器只采集 header 字段并触发异步写器，绝不可能否决会话创建；异步写器捕获一切失败（不可读/损坏的插件状态、被阻塞的侧账目录、序列化）并只记 debug 日志。插件状态损坏 ⇒ `plugins: []` 加固定原因码 `plugins-state-corrupt`（绝不携带原始错误文本——行中不含绝对用户路径）。崩溃留下的未终止残尾在下次追加前被修复（补一个换行），崩溃碎片永远无法吞掉后续行。

## 配置

```yaml
- id: config-snapshot
  name: '@dsh-cc/config-snapshot'
  config:
    config-snapshot.enabled: true   # 默认；面向最小足迹消费方的总开关
```

读取发生在异步写器内部，fail-open 为 `true`——坏掉的 settings 层既不会停用采集，也不会阻塞会话创建。

## 组合

被动侧账本；无 Service、无事件发射、无转写写入。残留设计考量、`session.append` 不可行性证据链与消费方契约见 [docs/plans/2026-10-09-session-config-snapshot-event.md](../../../docs/plans/2026-10-09-session-config-snapshot-event.md)。
