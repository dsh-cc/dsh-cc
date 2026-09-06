# @dsh-cc/tool-git-worktree

[English](README.md) | 中文

模型侧 `EnterWorktree` / `ExitWorktree` 工具：在 `<仓库>/.claude/worktrees/` 下创建、保留、删除隔离的 git worktree。所有 git 命令都经 `ctx.shell` 执行器 seam 运行（先 resolve 再 run——绝不直接 spawn），并用 `ctx.fs` 校验每个要操作的路径都在仓库内。

需要加载 shell 执行器 Service Provider（例如 `@deepseek-ai/dsh-bash-local`）、文件系统 Provider（`@deepseek-ai/dsh-fs-local`）、`ctx.tools` 与 `ctx.systemPrompt`。在 `inject: ['tools', 'shell', 'systemPrompt', 'fs']` 满足之前，插件保持等待状态。

## 工具

### `EnterWorktree`

基于 HEAD 在新建的 `worktree-<name>` 分支上创建 worktree，并将会话切换到其中。

| 参数 | 类型 | 说明 |
|---|---|---|
| `name` | string | worktree slug。每个以 `/` 分隔的段只允许字母、数字、`.`、`_`、`-`；最长 64 字符。省略时自动生成 `形容词-名词-后缀` 随机 slug。 |

工具从调用方 agent 的会话 cwd 定位仓库根（`git rev-parse --show-toplevel`）；不在 git 工作树内时返回结构化错误而不做任何更改。由于本 harness 中会话工作目录在创建时即固定，cwd 切换通过两种对不可变会话 cwd 安全的方式进行声明：工具结果与 `tool:worktree:cwd` systemPrompt 运行时上下文都会声明新的工作目录，并告知模型后续 shell/fs 调用需传入与返回的 `worktreePath` 相同的 `workdir`。pre-release 状态下的取舍记录在 [git-worktree-tools Agent Note](../../../.agents/notes/implemented/feature/2026-08-14-git-worktree-tools.md)。

### `ExitWorktree`

退出当前 EnterWorktree 会话并返回原目录。

| 参数 | 类型 | 说明 |
|---|---|---|
| `action` | `"keep"` \| `"remove"` | `keep` 在磁盘上保留 worktree 与分支；`remove` 删除两者（破坏性）。 |
| `discard_changes` | boolean | 当 `action: "remove"` 且 worktree 有未提交文件或不在基准分支上的提交时必须为 `true`；否则工具拒绝并列出证据。 |

`ExitWorktree` 只操作当前会话中由 `EnterWorktree` 创建的 worktree：否则为 no-op，绝不触碰手动创建或先前会话的 worktree。执行 `remove` 前会用 `git status --porcelain` 与 `git rev-list --count <base>..HEAD` 探测状态并**失败即关闭（fail closed）**——若状态无法核实，则没有 `discard_changes: true` 就拒绝，从而绝不让静默的 0/0 摧毁真实工作。

## 安全

- 两个工具都为 `isConcurrencySafe = () => false`；不得与其他工具重叠。
- `ExitWorktree` 且 `action: "remove"` 具有破坏性（删除 worktree 目录及其分支）；存在未提交或未合并工作时需要显式 `discard_changes: true` 许可。dsh-tools 没有专门的 `isDestructive` 字段，因此破坏性体现在人读的工具描述以及 `remove` 与 `keep` 的调用呈现区别中。
- 每个磁盘路径在运行任何 git 命令前都会校验仍位于仓库的 `.claude/worktrees/` 目录内。

## Git 命令构造

所有 git 命令都在一个模块（`src/worktree.ts`）中构建为 `{ command, workdir, label }` 不透明值，交给 `ctx.shell`。这是未来替换为纯 JS git 实现的 seam；工具代码绝不自拼 git 参数列表。

## UI 呈现

`EnterWorktree` 与 `ExitWorktree` 拥有各自的 `presentCall`/`presentResult` 呈现意图，均为 generic 卡片。`presentCall` 是参数的纯函数（`EnterWorktree` 调用指明 worktree 名；`ExitWorktree` 调用在标题与内容中区分 `remove`（破坏性）与 `keep`）。`presentResult` 成功时显示普通消息、出错时显示围栏文本；不使用 `diff` 卡片，因为退出 worktree 没有可渲染的文本差异。

## 已知限制

- 会话 cwd 不可变，因此 worktree 切换通过声明的 cwd 与 systemPrompt 运行时上下文表达，而非真正的按会话 cwd 修改；后续 shell/fs 调用必须传入 `workdir`。
- 活跃 worktree 会话是进程级单例（对应 claude-code 参考实现），因此一个进程任一时刻最多只有一个活跃 worktree。
