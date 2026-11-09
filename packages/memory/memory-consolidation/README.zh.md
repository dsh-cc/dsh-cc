# dsh-memory-consolidation

中文 | [English](README.md)

面向 DeepSeek Harness 的后台记忆整合：轮末抽取与对 `dsh-memory` 所读取的记忆
目录做三重门 dream 重写。

## 本包提供的能力

- **extractMemories** —— `agent/turn-stopping` 监听器启动一个后台 fork 的
  subagent（仅通过 `ctx.subagents` 启动并在内部跟踪，不走 `ctx.jobs` seam；仅持有
  读/搜索工具），从当前轮抽取持久事实并以结构化输出上报；插件校验该批次后在 host
  侧写入匹配的主题文件。
- **Dream 整合** —— 三道可配置的门，全部通过后才会用只读的 fork subagent 回顾
  过往会话，并以同样方式上报重写后的 `MEMORY.md` 与主题文件集：
  1. **时间门** —— 自上次整合起至少 `minHours`（默认 24）小时。
  2. **会话门** —— 至少 `minSessions`（默认 5）条新 transcript。
  3. **文件锁** —— `.consolidation-lock` 文件以存储的时间戳保证互斥；过期的持有者
     （超过 `lockStaleMs`，默认 1 小时）可被回收，因此整合中崩溃可自动恢复。成功的
     整合会**释放**锁（清除持有者、保留时间戳），下一次 dream 只受自身冷却或时间门
     约束。失败或被 kill 的整合会回滚锁，使时间门重新打开。
- **记忆写入改变模型可见上下文** —— 在上游，`dsh-memory` 会在记忆目录变更后通过
  `system-prompt/change` 重组装 `memory` 系统提示词 section。本包不为记忆文件本身
  引入新的会话事件。

## 与 sandbox 的关系：为什么由插件而非 fork 落盘

记忆目录位于 harness home，在任何会话 workspace 之外。fork subagent 继承父会话
的 sandbox 策略，因此在 `workspace-write`（或 `read-only`）下，所有指向记忆目录
的模型侧 `write`/`edit` 都会被围栏拦截（`FS_SANDBOX_DENIED`）；后台 job 又无法
走 escalation 重试——escalation 需要弹审批，而 job 的审批策略是 `never`。所以在
任何 sandboxed 会话里，模型侧的记忆写入注定失败。

因此 fork 不再持有任何写工具：它们通过 `outputSchema`（driver 注入的
`structured_output` 工具）上报文件集，由插件——可信的 host 代码——亲自落盘。
写入目标是**触发 agent 自己所在工作区的目录**——`<memoryHome>/projects/<slug>/`，
由 `resolveWorkspaceMemoryDir` 按 agent 的规范 git 根解析——而不是共享的 home 根
（home 根是显式全局层，由 `dsh-memory` 的 `memory_save` 以 `scope: "global"` 写入）：

1. `validateMemoryWrites` 校验这份不可信负载：仅允许扁平 `.md` 文件名（不允许
   分隔符、`..`、绝对路径、点文件），不允许重名，并施加硬上限（32 个文件 /
   单文件 64 KiB / 单批 256 KiB）。任何违规整批拒绝。
2. `writeMemoryFiles` 经 `ctx.fs` 缝写入，并为每次调用盖上
   `{ mode: 'workspace-write', workspaceRoot: <记忆目录> }` 的 per-call 策略——
   围栏仍然生效，只是可写根恰好就是记忆目录。sandbox 在校验之外再兜一层；
   记忆目录之外的任何路径都不可写。

job 状态反映真实结局：非 completed 的 `stopReason`、缺失/非法的负载、落盘失败
都会映射为 `failed` 并带 detail，而不是静默地假 `completed`。

## 使用

以 `@dsh-cc/memory-consolidation` 加载插件。配置：

| Key | 默认值 | 含义 |
|---|---|---|
| `memoryHome` | harness home `memory/` | 记忆 home 根；抽取/dream 写入触发 agent 所在仓库的 `projects/<slug>/` |
| `extractEnabled` | `true` | 运行轮末抽取 |
| `dreamEnabled` | `true` | 运行三重门 dream |
| `minHours` | `24` | 两次整合间的最小间隔小时数 |
| `minSessions` | `5` | 需要整合的最小新 transcript 数 |
| `lockStaleMs` | `3_600_000` | 锁持有者过期窗口 |
| `pressureCooldownMinutes` | `60` | 两次强制（压力）dream 之间的最小间隔分钟数 |
| `subagentProviderName` | `fork` | fork 使用的一次性 provider |
| `sessionsRoot` | `<DSH_HOME>/sessions` | 门扫描的会话存储根目录 |

```ts
import consolidation from '@dsh-cc/memory-consolidation'
await ctx.plugin(consolidation, { minHours: 24, minSessions: 5 })
```

## 抽取决策门（`cc-systemone-memory-extraction`）

轮末抽取 fork 之前可选的一道默认关闭的门。fork 启动前，一次 System One 决策模型调用针对
完整复查窗口——上次已复查 seq 之后的会话事件，加上现有主题索引——回答单个问题：
*该窗口是否至少包含一条持久的新事实？* 只有明确的低概率结论才可以省略 fork；其余任何
情况——窗口不完整、超出预算、缺少路由或 runner、答案非法、超时——都与原来一样执行抽取。

三种模式从 `cc-systemone-memory-extraction` 设置命名空间动态读取（外部键为
kebab-case；任何非法值都会整段拒绝并保留上一份快照）：

| Key | 默认值 | 含义 |
|---|---|---|
| `mode` | `off` | `off` 保留原有的监听器且不发任何决策请求；`shadow` 用新协调器串行化 job，但仍照常抽取，只记录「本可跳过」；`active` 允许合格的低概率结论真正省略 fork |
| `route-alias` | `gauge` | 已配置的决策路由别名——它只选择 System One 决策模型，绝不选择生成式的抽取模型 |
| `timeout-ms` | `1500` | 单次决策的线上超时（整数，100–5000） |
| `max-input-tokens` | `6000` | 单份决策状态的估算 token 预算（整数，512–16000） |
| `max-surface-events` | `64` | 被复查事件超过此数时窗口直接抽取（整数，1–256） |
| `max-state-bytes` | `32768` | 完整状态的 UTF-8 字节预算（整数，4096–131072） |
| `skip-probability` | `0.05` | `p` 小于等于此值才可跳过（范围 `0`–`0.20`，两端含）；`0.5` 是固定的正例边界 |
| `audit-every-n-skips` | `20` | 每第 N 次合格跳过改为一次审计抽取（整数，1–1000） |
| `failure-cooldown-ms` | `30000` | 失败窗口可重试前的等待时间（整数，1000–300000） |
| `session-state-cap` | `200` | 无在飞工作的空闲会话状态的 LRU 上限（整数，1–2000） |

这些概率是实验性设置：不承诺任何准确率或收益。只有在挂载了 `@dsh-cc/decision-usage`
（或其它提供根领域 `ccSystemoneDecisions` 服务的插件）、且其 `systemone-decisions`
能力行配置了所请求的路由时，这道门才真正生效；缺少该服务时每个合格窗口都只是照常抽取
（原因 `unavailable`）。在任何模式下，抽取模型、`memoryHome` 与
`subagentProviderName` 都仍按原有配置工作。

**`shadow` 与原有调度并非逐事件完全一致。** `shadow` 与 `off` 的预期记忆内容相同，
读写权限相同，生成式模型配置也相同，但 `shadow` 有意收紧了并发时序：job 经协调器串行化，
复查 watermark 只有在 host 校验并写盘成功后才会推进，因此未完成的 job 绝不会被当成已完成。
只有 `active` 才可能省略 fork。

**私有输入。** 完整窗口会把当前会话文本加上现有主题索引发送给已配置的决策路由——这比
召回选择器发送的候选元数据有更高的披露风险。默认的 `off` 下什么都不发送。状态里不含
凭据、请求头、工具参数或绝对路径；若某段材料必须先裁剪，该窗口会被标记为不完整并改走原有
fork，绝不基于裁剪后的文本作出跳过。watermark、跳过序号与租约只存在于进程内存中——不新增
任何记忆文件或会话事件类型。

**评测与回滚。** [`eval/`](eval/README.md) 提供合成的 240 个窗口的黄金集、标签定义与离线
门槛（正例零误跳过——含显式纠错与用户偏好两个子类——不完整窗口零跳过、事实召回不低于
总是抽取的基线、总成本低于该基线）。受环境变量控制的 harness
（`DSH_EXTRACTION_EVAL=1 pnpm vitest run packages/memory/memory-consolidation/tests/eval-extraction-systemone.spec.ts`）
用真实的窗口构建器与门、配合假决策 runner 跑完这些窗口，并写出一份盖有
`invalid-for-release` 标记的报告：mock 运行永远不足以支撑放量决策。先显式开启 `shadow`
（至少 100 个完整且已授权的窗口，并对每个「本可跳过」的正例人工核对），再在指定工作区开启
`active`。若任一次审计 fork 发现了持久事实、跨仓库写入、越过未完成 job 的 watermark，或同一
目录上的并发覆盖，立即把模式设回 `off`。回滚就是同一次切换：协调器取消新门并等待写租约
释放，内存中的 watermark 与跳过计数被丢弃，磁盘上的记忆既不迁移也不删除，下一次
turn-stopping 由原有监听器负责。默认值保持 `off`；改动默认值需要单独的评测证据与变更评审。

## Model Experience

门关闭时，turn-stopping 监听器几乎无成本（一次锁读取）。当时间门与会话门打开时，
每次整合运行一个 fork subagent，限制为读/搜索工具加 `structured_output` 上报工具；
其输出不会追加到主 transcript。每轮抽取可能启动一个短暂后台 fork。抽取决策门处于
`active` 模式时，一次合格的跳过会用一次简短的决策调用来取代该 fork；处于 `shadow` 模式时，
决策调用是在保持不变的 fork 之上额外发生的。

## API

- `tryAcquireLock(fs, dir, pid, now, policy?)` / `releaseLock(fs, dir, pid, at, policy?)` /
  `rollbackLock(fs, dir, pid, at, priorAt, policy?)` /
  `readLastConsolidatedAt(fs, dir)` —— 整合锁。
- `gatesPass(input)` / `timeGatePasses(...)` / `sessionGatePasses(...)` —— 门谓词。
- `MEMORY_TOOL_FILTER` / `MEMORY_AGENT_TOOLS` —— 记忆作用域工具集（读/搜索 +
  `structured_output`）。
- `MEMORY_WRITES_SCHEMA` —— 每个 fork 上报的 `outputSchema` 契约。
- `validateMemoryWrites(input)` / `writeMemoryFiles(fs, dir, writes)` /
  `memoryWritePolicy(dir)` —— host 侧落盘（由记忆目录的拥有者
  `@dsh-cc/memory` 持有，此处 re-export）。
- `buildExtractionPrompt` / `buildConsolidationPrompt` —— fork 的提示词。

## 已知限制与延期工作

- `ctx.fs` 缝不暴露 mtime，因此锁将持有者 PID 与上次整合时间戳存入锁文件正文而非
  文件 mtime；崩溃恢复依赖过期窗口而非进程存活。
- 会话门改为扫描持久化会话存储（只读取 header 前缀）；无法读取的目录会单独计入，
  而不是被静默当作空目录。
- 没有删除通道：dream 会把过期记忆从 `MEMORY.md` 移除，但失去引用的主题文件仍留在
  盘上，直到被覆写。主题文件删除已延期（fork 的 allow-list 本来也没有 remove 工具）。
- 并行会话的抽取同时写 `MEMORY.md` 索引时不再互相丢更新：每次索引写入都会对照任务
  开始时读到的基线做校验，期间已有内容落地就在其上重新合并。主题文件正文仍是
  last-writer-wins，dream 锁只串行化整合。
- 抽取决策门的写租约只是本插件在 `shadow`/`active` 模式下的进程内、按目录租约：
  它不是跨进程事务，不扩大 dream 锁的含义，也不对两个独立 harness 同时更新同一个
  memoryHome 作任何承诺。
