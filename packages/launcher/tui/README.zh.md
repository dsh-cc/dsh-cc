# @dsh-cc/cli

[English](README.md) | 中文

可选的 `dsh-cc` bin。规范命令仍是 `dsh --profile tui`。

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

`DSH_CC_RESUME_SESSION`、`DSH_CC_AUTO_RESUME` 和 `DSH_CC_CONTINUE` 由
**启动器负责**：bin 在入口处会把它们从继承环境中清除（父级 dsh-cc TUI 会
把泄漏给子启动器），并仅根据当前调用的 argv 重新派生。启动 `dsh-cc` 时
不要手动设置它们。

### Mixed-version degradation

由于启动器 npm 包与 `tui` profile 插件版本在安装时锁定，版本不匹配只会在
升级启动器但未重装 profile 之后出现：

- 新启动器 + 旧插件：插件永远看不到 `DSH_CC_AUTO_RESUME`，因此 auto-resume
  静默失效——`/resume` 仍可用于手动选择。重装 profile 即可修复（`dsh-cc`
  会对全新 profile 重新执行 bootstrap）。
- 旧启动器 + 新插件：旧启动器读取旧版标记，而新插件会双写该标记，因此
  常见的同目录重启路径仍能正常工作。

本包**不**附带 `dsh-tui` 二进制。
