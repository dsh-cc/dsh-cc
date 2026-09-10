# @dsh-cc/command-compact

[English](README.md) | 中文

面向用户的 `/compact` 斜杠命令，支持可选的保留指示：`/compact` 运行与上游一致的空闲会话手动压缩；`/compact <instructions>` 还会把自由文本提示停放在发起调用的 agent 上，让 CC 压缩引擎的摘要器保留用户要求的内容。

## 用法

本包是一个 cordis 插件；注册后会为每个已组合的人工命令适配器挂载该命令：

```ts
import commandCompact from '@dsh-cc/command-compact'

ctx.plugin(commandCompact) // 注入 `commands` 与 `compaction`
```

## 提供内容

- `/compact` — 压缩较旧的会话历史，并报告被遮蔽的条目数与近似 token 数；无可压缩内容时返回 `No compactable history yet.`。
- `/compact [instructions]` — 自由文本保留指示，在压缩执行前交给 `@dsh-cc/compaction-basic` 的提示接缝。
- 尾部 `help` / `-h` / `--help` 由 `@dsh-cc/command-usage` 以纯文本帮助作答，不消耗模型轮次。
- `ManualCompactionError` 中可预期的能力失败（`busy`、`cancelled`、`changed`、`summary`、`commit`、`persistence`）会被转换为简洁的、仅面向人的错误结果，而不是原始错误。

## 备注

- 提示在 `finally` 块中清除，因此失败或空操作的压缩绝不会留下陈旧提示影响后续轮次。
- 已启动的 handler promise 在拆卸时静默收敛（注销前先等待排空），组合式拆卸期间不会有调用仍在飞行。
- 子命令 `@dsh-cc/command-compact/invariant` 注册本包的 invariant 伴随插件；它不安装任何运行时 invariant，因为该命令只是上游已验证的压缩接缝之上的薄适配器。
