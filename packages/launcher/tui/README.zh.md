# @dsh-cc/cli

[English](README.md) | 中文

可选的 `dsh-cc` bin。规范命令仍是 `dsh --profile tui`。
`dsh-cc --version`（或 `-V`）打印版本标签后退出：release 安装为启动器的
semver，dev 同步的 profile 为 `<base>-dev+<commit>[.dirty]`。

首次运行会以三个 CC bundle 引导（bootstrap）`$DSH_HOME/profiles/tui`。
启动器是一个薄薄的 flag 转换器：先派生出 TUI 插件消费的 session-mode 环境变量，
再 spawn `dsh --profile tui`。它自己从不读取 resume 标记——标记的读写由
TUI 插件负责。

`--worktree [name]` 会在位于 `<repoRoot>/.claude/worktrees/<slug>`、分支为
`worktree-<slug>` 的 git worktree 内启动会话（未给名字时使用随机 slug）。
新创建的 worktree 会开启全新会话（等价于 `--new`）。当该目录已存在时再次
调用 `--worktree <name>` 会复用它，并且由于会话按*项目*（主 git 根目录；
worktree 共享它）划分作用域，会退回默认的 auto-resume——TUI 恢复该项目的
上一个会话。`--resume` / `--new` 仍然可以覆盖。启动器通过
`DSH_CC_WORKTREE` 标记会话，TUI 会在 `/quit` 时询问保留还是删除该
worktree。要求 git 仓库至少有一个提交。

该值也可以是 PR／MR 引用（`#<n>`、GitHub PR URL 或 GitLab MR URL）：启动器
在 github.com 上 fetch `pull/<n>/head`，在 gitlab.com 上 fetch
`merge-requests/<n>/head`，在未知 host 上两者都试，然后以取到的 head 在
`.claude/worktrees/pr-<n>`、分支 `worktree-pr-<n>` 上创建 worktree。创建时
会中和仓库本地的 filter driver，因此 LFS 内容以指针文件形式落盘，在新
worktree 中执行 `git lfs pull` 即可还原（`bootstrap.mjs:305-330,365-370`）。

每次启动还会运行一次引导清扫（不做网络 I/O，10 秒上限，失败静默）：
`.claude/worktrees/` 下位于 `worktree-*` 分支、超过
`worktree.cleanupPeriodDays`（默认 30，从 user → project → local 设置文件
中 fail-open 读取的 `worktree` 设置节取得）的 worktree，只有在干净且没有
未推送提交时才会被移除；过期的 dsh-cc 会话锁绝不自动释放——它们只以
`git worktree unlock <path>` 建议行出现。新 worktree 的创建基准由
`worktree.baseRef` 决定（`fresh` = 缓存的 origin/HEAD，reflog 超过 24 小时
时限 5 秒 fetch 刷新；`head` = 字面 HEAD）；复用的命名 worktree 在干净且
自身提交全部已合入该基准时会被硬重置到该基准。创建与复用的 worktree 都会
以 `git worktree lock --reason="dsh-cc session <slug>"` 加锁，会话期间
保持锁定。

会话开始前，启动器还会收敛 profile：与当前启动器版本不一致的 dev 同步
profile 会被还原为 store bundle，已存在的 store profile 会被治愈到当前版本，
而 bootstrap 路径在 `dsh --version` 低于要求的最低版本时打印信息并停止
（`bootstrap.mjs:708-930`、`bin/dsh-cc.js:110-152`）。

## Resume environment contract

启动器通过三个变量（经由 `cordis.patch.yml` 的 `!!js` 表达式）把用户的会话
意图传达给 TUI 插件：

- `DSH_CC_RESUME_SESSION=<id>` — 显式恢复该会话 id
  （`--resume <id>` / `--resume=<id>`）。
- `DSH_CC_RESUME_SESSION=''` — 显式全新开始（`--new`/`-n`，或新建的
  worktree）；TUI 不得读取任何标记。
- `DSH_CC_AUTO_RESUME='1'` — 用户没有做出显式选择，因此 TUI 读取自己的
  项目 resume 标记，若存在则恢复。仅当 `DSH_CC_RESUME_SESSION` 未定义时
  才会设置。
- `DSH_CC_CONTINUE='1'` — 用户传入了 `-c`/`--continue`；当没有标记存在时，
  TUI 显示"没有可继续的上一个会话"提示（此前这是启动器一行 stderr 提示；
  标记读取移入 TUI 后，启动器不再掌握这一信息）。
- `DSH_CC_DISABLE_EXIT_TIP='1'` — 禁用 TUI 退出时打印到回滚缓冲区的
  resume 提示（见 `packages/ui/tui/src/exit-tip.ts`）。

`DSH_CC_RESUME_SESSION`、`DSH_CC_AUTO_RESUME` 和 `DSH_CC_CONTINUE` 由
**启动器负责**：bin 在入口处会把它们从继承环境中清除（父级 dsh-cc TUI 会
把泄漏给子启动器），并仅根据当前调用的 argv 重新派生。启动 `dsh-cc` 时
不要手动设置它们。

`DSH_CC_PROFILE` 指明启动器 spawn 的 profile（`tui`，ACP 通道上为
`cc-acp`），供插件以 `ctx.get('dshProfile')` 呈现（`bin/dsh-cc.js:82,385`）。

### Mixed-version degradation

由于启动器 npm 包与 `tui` profile 插件版本在安装时锁定，版本不匹配只会在
升级启动器但未重装 profile 之后出现：

- 新启动器 + 旧插件：插件永远看不到 `DSH_CC_AUTO_RESUME`，因此 auto-resume
  静默失效——`/resume` 仍可用于手动选择。重装 profile 即可修复（`dsh-cc`
  会对全新 profile 重新执行 bootstrap）。
- 旧启动器 + 新插件：旧启动器读取旧版标记，而新插件会双写该标记，因此
  常见的同目录重启路径仍能正常工作。

本包**不**附带 `dsh-tui` 二进制。

## `dsh-cc acp`

`dsh-cc acp [...]` 启动 Agent Client Protocol 通道。bin 在任何 TUI 处理之前
就拦截它（`bin/dsh-cc.js:37-99`），先用 ACP 基础 bundle 引导独立的
`cc-acp` profile（`bootstrap.mjs:18-32`；安装的 `@deepseek-ai/dsh-acp-app`
固定为 `0.2.1-rc.5`），再以剩余参数 spawn `dsh --profile cc-acp`。stdout
属于 ACP 的 NDJSON 协议，因此 bootstrap 与安装输出只写 stderr，绝不消费
stdin，子进程继承 stdio。该路径不执行任何 TUI flag 处理，因此 `--worktree`
与各 resume flag 都原样透传。
