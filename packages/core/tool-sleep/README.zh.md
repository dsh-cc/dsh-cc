# @dsh-cc/tool-sleep

[English](README.md) | 中文

模型侧 `Sleep` 工具：等待指定时长，并支持协作式取消，语义对齐 Claude Code 的 `SleepTool`。通过 `@dsh-cc/tools` 的 `ToolRuntime` 注册进 `ctx.tools`。

## 工具

### `Sleep`

等待 `{ duration }` 秒。

| 参数 | 类型 | 说明 |
|---|---|---|
| `duration` | number | 等待的秒数。必须为有限、非负数。`0` 为 no-op。 |

等待是协作式可取消的：同时挂起一个定时器与针对 `exec.signal` 的 `abort` 监听器，谁先触发就先 settle。若新一轮会话在睡眠中途取消该调用，工具会立即停止等待并返回规范的 `ABORTED` 结果——与 CC 的 `interruptBehavior: 'cancel'` 一致。

该工具为 `isConcurrencySafe = () => true`，因此可以与其他工具调用重叠（CC："You can call this concurrently with other tools — it won't interfere with them"）。优先于 spawn 一个睡眠子进程，因为它不占用子进程或 shell。

## 配置

`Config` 采用 schemastery 类型（沿用 git-worktree 工具的惯例）：

```ts
export const Config = z.object({
  minDurationSeconds: z.number(),  // 可选下限（向上钳制）
  maxDurationSeconds: z.number(),  // 可选上限（向下钳制）
})
```

每次 `apply(ctx, config)` 都会把 `Sleep` 工具注册进 `ctx.tools`。需要已加载的 `ctx.tools`；在 `inject: ['tools']` 满足之前，插件保持等待状态。

## 安装 / 注册

```ts
import * as ToolSleep from '@dsh-cc/tool-sleep'

await ctx.plugin(ToolRuntime)   // @dsh-cc/tools
await ctx.plugin(ToolSleep)     // 注册 Sleep 工具
```

## 语义取舍

- **以秒为单位**的时长契合模型侧参数契约。
- **中断即取消**：通过 `exec.signal` 复现 CC 在睡眠途中收到新用户提示时中断并取消当前回合的行为。
- **并发安全**：`Sleep` 不会对并行的兄弟调用形成顺序屏障。

## 构建顺序

`tool-sleep` 仅依赖工作区 `@dsh-cc/tools` 包与 harness 基础包（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-invariants`、`@deepseek-ai/schemastery`）。它不依赖 git-worktree 或任何其它工作区包，因此只要 `core/tools` 构建完成即可构建；`tsc -b` 会自动解析引用顺序。

## 已知限制

- `minDurationSeconds` / `maxDurationSeconds` 钳制是 CC 的 `minSleepDurationMs` / `maxSleepDurationMs` 进程设置的松散对应物；此处为每次 `apply` 的配置，而非全局运行时设置。
- 不发出 `tick`/进度流（CC 在 REPL 中会发出 `sleep_progress` tick）；等待在协议层是静默的。
