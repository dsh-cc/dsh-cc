# @dsh-cc/tool-notebook-edit

[English](README.md) | 中文

模型侧 `NotebookEdit` 工具：编辑 Jupyter notebook (.ipynb) 单元格，语义对齐 Claude Code 的 `NotebookEditTool` 的 replace/insert/delete 与单元格寻址。通过 `@dsh-cc/tools` 的 `ToolRuntime` 注册进 `ctx.tools`，并通过 harness 的 `ctx.fs` seam 读写。

## 工具

### `NotebookEdit`

编辑某个 `.ipynb` notebook 的一个单元格。

| 参数 | 类型 | 说明 |
|---|---|---|
| `notebook_path` | string | `.ipynb` 文件的绝对路径（必须为绝对路径；非 `.ipynb` 会被拒绝）。 |
| `new_source` | string | 该单元格的新源码。 |
| `cell_id` | string | 可选。要编辑的单元格；当 `edit_mode=insert` 时，新单元格插入到该单元格之后（省略时插到开头）。 |
| `cell_type` | `code` / `markdown` | 可选。默认沿用当前单元格类型；`insert` 时必须提供。 |
| `edit_mode` | `replace` / `insert` / `delete` | 可选。默认 `replace`。 |

单元格引用先按真实 `id` 寻址，再按 CC 为无 id 单元格展示的零基 `cell-<index>` 形式寻址——因此较老版本的 notebook（nbformat 4 且 minor < 4.5）也能像 CC 一样被编辑。replace 会清空 code 单元格的 `execution_count` 与 `outputs`；在 nbformat >= 4.5 上 insert 会生成新 id；delete 移除单元格。

## 写前先读（read-before-write）门

与 CC 的 `validateInput` 一致，工具拒绝写入模型从未读过的 notebook，也拒绝在文件自读取后被改动时（stale write）进行写入。该门由 harness 观测 seam 驱动：插件在 `apply()` 中维护一张 `readStates` 表，并记录每条 `present` 的 `fs/observed` 观测（即 Read/Write/Edit 工具在提交时发出的事件），按键为解析后的路径。execute 时：无已观测读记录 → 拒绝；当前 `ctx.fs.stat()` 版本与该观测版本不一致 → 拒绝。写完后用写入结果的版本重新建立基线——因此工具自身的写视为“已读”的最新基线。seam 暴露的是不透明 `FsVersion` 新鲜度令牌而非 mtime；比较该令牌是 seam 原生的陈旧性校验，严格强于 CC 的 mtime 比较。

该工具为 `isConcurrencySafe = () => false`：它会改动共享的单元格状态与读基线，因此绝不可与并行的兄弟 `NotebookEdit` 调用重叠。

## 配置

`Config` 采用 schemastery 类型，当前为空（预留未来上限）：

```ts
export const Config = z.object({})
```

每次 `apply(ctx, config)` 都会把 `NotebookEdit` 工具注册进 `ctx.tools`，并注册其 `fs/observed` 监听器。需要已加载的 `ctx.tools` 与活跃的 `ctx.fs` 后端（例如 `@deepseek-ai/dsh-fs-local`）；在 `inject: ['tools', 'fs']` 满足之前，插件保持等待状态。

## 安装 / 注册

```ts
import * as ToolNotebookEdit from '@dsh-cc/tool-notebook-edit'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'

await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)             // @dsh-cc/tools
await ctx.plugin(LocalFileSystem, { cwd }) // ctx.fs 后端
await ctx.plugin(ToolNotebookEdit)        // 注册 NotebookEdit 工具 + 监听器
```

## 语义取舍

- **replace / insert / delete** 与**单元格寻址**完全对齐 CC 的 `NotebookEditTool`，包括无 id notebook 的 `cell-<n>` 回退，以及 replace 时清空 outputs。
- **写前先读门**将 CC 的“请先读”/“读取后被修改”拒绝复现为带稳定 code 的 `NotebookEditError`。
- **写后重设基线**：工具的写被视为最新读基线，第二次编辑无需重新 Read——与 CC 的 `readFileState` 被自身写入更新的行为一致。

## 构建顺序

`tool-notebook-edit` 仅依赖工作区 `@dsh-cc/tools` 包与 harness 基础包（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-fs`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-invariants`、`@deepseek-ai/schemastery`）。它不依赖任何其它工作区包，因此只要 `core/tools` 构建完成即可构建；`tsc -b` 会自动解析引用顺序。

## 已知限制

- notebook 以单空格缩进的 JSON 重写（与 CC 的 `IPYNB_INDENT = 1` 一致）；不保留原有排版。
- 现有单元格中的 `source` 数组会被替换为给定的 `new_source` 字符串，而非保留为数组（与 CC 一致）。
- 读基线存活期为插件实例：插件热重载（HMR）时会重置，因此 reload 前读过 notebook 的模型需要先重新 Read。
