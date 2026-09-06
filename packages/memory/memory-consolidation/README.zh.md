# dsh-memory-consolidation

中文 | [English](README.md)

面向 DeepSeek Harness 的后台记忆整合：轮末抽取与对 `dsh-memory` 所读取的记忆
目录进行三重门 dream 重写。

## 本包提供的能力

- **extractMemories** —— `agent/turn-stopping` 监听器启动一个后台 fork 的
  subagent（通过 `ctx.jobs` + `ctx.subagents`，仅持有读/搜索工具），从当前轮
  抽取持久事实并以结构化输出上报；插件校验该批次后在 host 侧写入匹配的主题
  文件。
- **Dream 整合** —— 三道可配置的门，全部通过后才会用只读的 fork subagent 回顾
  过往会话，并以同样方式上报重写后的 `MEMORY.md` 与主题文件集：
  1. **时间门** —— 自上次整合起至少 `minHours`（默认 24）小时。
  2. **会话门** —— 至少 `minSessions`（默认 5）条新 transcript。
  3. **文件锁** —— `.consolidation-lock` 文件以存储的时间戳保证互斥；过期的持有者
     （超过 `lockStaleMs`，默认 1 小时）可被回收，因此整合中崩溃可自动恢复。失败
     或被 kill 的整合会回滚锁，使时间门重新打开。
- **记忆写入改变模型可见上下文** —— 在上游，`dsh-memory` 会在记忆目录变更后通过
  `system-prompt/change` 重组装 `memory` 系统提示词 section。本包不为记忆文件本身
  引入新的会话事件。

## 与 sandbox 的关系:为什么由插件而非 fork 落盘

记忆目录位于 harness home，在任何会话 workspace 之外。fork subagent 继承父会话
的 sandbox 策略，因此在 `workspace-write`(或 `read-only`)下,所有指向记忆目录
的模型侧 `write`/`edit` 都会被围栏拦截(`FS_SANDBOX_DENIED`);后台 job 又无法
走 escalation 重试——escalation 需要弹审批,而 job 的审批策略是 `never`。所以在
任何 sandboxed 会话里,模型侧的记忆写入注定失败。

因此 fork 不再持有任何写工具:它们通过 `outputSchema`(driver 注入的
`structured_output` 工具)上报文件集,由插件——可信的 host 代码——亲自落盘。
写入目标是**触发 agent 自己所在工作区的目录**——`<memoryHome>/projects/<slug>/`,
由 `resolveWorkspaceMemoryDir` 按 agent 的规范 git 根解析——而不是共享的 home 根
（home 根是显式全局层,由 `dsh-memory` 的 `memory_save` 以 `scope: "global"` 写入）:

1. `validateMemoryWrites` 校验这份不可信负载:仅允许扁平 `.md` 文件名(不允许
   分隔符、`..`、绝对路径、点文件),不允许重名,并施加硬上限(32 个文件 /
   单文件 64 KiB / 单批 256 KiB)。任何违规整批拒绝。
2. `writeMemoryFiles` 经 `ctx.fs` 缝写入,并为每次调用盖上
   `{ mode: 'workspace-write', workspaceRoot: <记忆目录> }` 的 per-call 策略——
   围栏仍然生效,只是可写根恰好就是记忆目录。sandbox 在校验之外再兜一层;
   记忆目录之外的任何路径都不可写。

job 状态反映真实结局:非 completed 的 `stopReason`、缺失/非法的负载、落盘失败
都会映射为 `failed` 并带 detail,而不是静默地假 `completed`。

## 使用

以 `@dsh-cc/memory-consolidation` 加载插件。配置：

| Key | 默认值 | 含义 |
|---|---|---|
| `memoryHome` | harness home `memory/` | 记忆 home 根;抽取/dream 写入触发 agent 所在仓库的 `projects/<slug>/` |
| `extractEnabled` | `true` | 运行轮末抽取 |
| `dreamEnabled` | `true` | 运行三重门 dream |
| `minHours` | `24` | 两次整合间的最小间隔小时数 |
| `minSessions` | `5` | 需要整合的最小新 transcript 数 |
| `lockStaleMs` | `3_600_000` | 锁持有者过期窗口 |
| `subagentProviderName` | `fork` | fork 使用的一次性 provider |

```ts
import consolidation from '@dsh-cc/memory-consolidation'
await ctx.plugin(consolidation, { minHours: 24, minSessions: 5 })
```

## Model Experience

门关闭时，turn-stopping 监听器几乎无成本（一次锁读取）。当时间门与会话门打开时，
每次整合运行一个 fork subagent，限制为读/搜索工具加 `structured_output` 上报工具;
其输出不会追加到主 transcript。每轮抽取可能启动一个短暂后台 fork。

## API

- `tryAcquireLock(fs, dir, pid, now, policy?)` / `rollbackLock(fs, dir, priorAt, policy?)` /
  `readLastConsolidatedAt(fs, dir)` —— 整合锁。
- `gatesPass(input)` / `timeGatePasses(...)` / `sessionGatePasses(...)` —— 门谓词。
- `MEMORY_TOOL_FILTER` / `MEMORY_AGENT_TOOLS` —— 记忆作用域工具集(读/搜索 +
  `structured_output`)。
- `MEMORY_WRITES_SCHEMA` —— 每个 fork 上报的 `outputSchema` 契约。
- `validateMemoryWrites(input)` / `writeMemoryFiles(fs, dir, writes)` /
  `memoryWritePolicy(dir)` —— host 侧落盘(由记忆目录的拥有者
  `@dsh-cc/memory` 持有,此处 re-export)。
- `buildExtractionPrompt` / `buildConsolidationPrompt` —— fork 的提示词。

## 已知限制与延期工作

- `ctx.fs` 缝不暴露 mtime，因此锁将持有者 PID 与上次整合时间戳存入锁文件正文而非
  文件 mtime；崩溃恢复依赖过期窗口而非进程存活。
- 会话门当前通过 `ctx.sessions` 统计存活会话并将其视为新会话；带时钟的 transcript
  查询已延期。
- 没有删除通道:dream 会把过期记忆从 `MEMORY.md` 移除,但失去引用的主题文件仍留在
  盘上,直到被覆写。主题文件删除已延期(fork 的 allow-list 本来也没有 remove 工具)。
- 并行会话的抽取并写时为 last-writer-wins;dream 锁只串行化整合。
