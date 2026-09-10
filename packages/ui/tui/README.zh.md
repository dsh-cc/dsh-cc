# @dsh-cc/tui

[English](README.md) | 中文

面向 DeepSeek Harness 的 Claude Code 风格终端界面。由 `@dsh-cc/bundle-tui` 挂载于
**`tui`** profile；新会话组合 **`cc`** agent 预设。

本包是一个协议驱动器：观察 `session/event` 并驱动 `Agent.followup()` / `cancel()`。
它不带 CC 工具或斜杠命令——那些留在 `packages/preset/cc`。

## 启动

```sh
dsh plugin --profile tui add @dsh-cc/bundle-permissions \
  @dsh-cc/bundle-shell @dsh-cc/bundle-tui
dsh --profile tui
```

不要把本 bundle 加进 `web` profile。Web 共存是两个 profile、一个后端。

## 按键

- Shift+Tab — 循环切换 CC 权限模式（`default` → `acceptEdits` → `plan` → `auto` → `bypassPermissions`）
- `1` / `y` — 批准一次（审批弹窗）；`2` / `n` 或 Esc — 拒绝；`3` / `a` — 始终允许：放行该调用并持久化一条权限规则（见[审批预览](#审批预览与始终允许)）
- Esc — 中断当前轮次；在 overlay 之上则关闭用量面板、取消未决提问、拒绝未决审批，或退出 `!` shell 模式，且不中断运行中的轮次
- Ctrl+C — 轮次运行中为中断；空闲时第一次按下开启一个带提示的 2 秒退出窗口，窗口内再按一次即退出，因此误按的 Ctrl+C 永远不会杀掉会话
- Ctrl+S — 把所有排队消息立即注入运行中的轮次
- Ctrl+T — 切换 todo 面板 overlay（方向键移动高亮；Esc 或再按一次 Ctrl+T 关闭）
- Ctrl+O — 切换全局折叠：thinking 块与工具输出折叠为一行摘要，再按一次恢复
- ↑（输入框为空时）— 撤回最近一条排队消息到输入框以供编辑；输入框非空时，↑ 遍历输入框历史；`!` shell 模式下，↑/↓ 遍历独立的 bash 历史
- Tab — 在命令名之后补全斜杠命令参数（支持 `/model`、`/effort`、`/permissions`、`/resume`）
- `!` — 运行本地 shell 命令（见 [Shell 模式](#shell-模式-）)
- `/quit` — 退出
- `/model` — 列出或切换实时 LLM 路由
- `/resume [id]` — 列出持久化会话，或钉存下次启动的 id
- `/export-md [path]` — 把会话记录写入 Markdown 文件；显式路径相对会话 cwd 解析，无参数时落到 `$DSH_HOME/tui/exports/<sessionId>-<timestamp>.md`（目录按需创建）
- `/copy` — 通过 OSC 52 序列把最近一条助手回复复制到系统剪贴板（终端需支持 OSC 52；尚无回复时降级为一条通知）
- `/usage` — 打开用量面板：上下文占用条、token 总量（input/output/cache 分桶）、system/tools/messages 明细，打开期间全部实时；Esc 关闭。本技术栈中配额数据没有来源，从不显示
- `/permissions` — 打开五种 CC 权限模式的选择器（`default` / `acceptEdits` / `plan` / `auto` / `bypassPermissions`）；`/permissions <mode>` 仍可直接切换。`bypassPermissions` 会先要求 overlay 内确认。规则列表已不可从 TUI 裸调用进入（与浏览器端 popupSelect 对齐）
- 其余 `/commands` — harness 目录（CC 预设）
- skills 注册表中的用户可调用 skills 也出现在 `/` 菜单
  （排在命令之后；被命令占用的名字解析为该命令）。未注册命令的
  `/name` 会作为普通用户提示发送——
  若它指向一个用户可调用 skill，宿主的 pre-step 边界会注入
  skill 指令（与 web 客户端同一通路）；否则就是普通文本。已知限制：因为 pi-tui 在其
  provider 被替换时会丢弃自动补全，打开的 `/` 菜单可能在 skill
  目录到达的那一刻被关闭。

## 渲染

- 文件编辑卡片把 diff 渲染为带侧栏行号的 hunk；hunk 之间较长的未变更段折叠为
  暗色的 `… N unchanged lines …` 标记，超大的 diff 在 hunk 边界而非 hunk 中间截断。
- 连续完成的文件读取折叠为一行 `⏺ Read N files` 摘要；运行中、出错或单独的读取
  保留自己的行。
- 模型上下文窗口已知时，页脚报告精确的上下文占用——`ctx 43% (86k/200k)`——
  行宽不足以容纳括号部分时省略括号。
- 输入框下方的通知是瞬态的：几秒后自行清除，不再滞留。

## 排队

轮次运行中提交的消息被停放在 outbox（显示为 `⏵ queued:` 徽标），而不是注入运行中的
轮次。当前轮次结束时 outbox 自动冲入新轮次——失败轮次之后也一样——或经 Ctrl+S
立即冲入。空闲时提交直接发送，永不进入 outbox，因此只有未发送的消息可用 ↑ 撤回。
中断（忙碌时 Esc 或 Ctrl+C）会清空 outbox 而不是冲入。

## 审批预览与始终允许

审批提示会展示即将运行内容的结构化预览，从配对的工具事件恢复：shell 风格调用预览
命令，文件编辑预览逐文件 diff（用会话记录的 diff 渲染器渲染），其他工具预览其
美化打印的参数。预览无法恢复时，提示降级为工具名与理由。

三种回答：`1`/`y` 批准一次，`2`/`n`（或 Esc）拒绝，`3`/`a` 回答**始终允许**——
调用像一次性审批一样放行，并把一条权限规则持久化到 settings 允许列表。对 shell
命令，规则是带尾随空格的首词前缀（`Bash(npm )` 匹配 `npm install …` 但永不匹配
`npmx …`）；其他每个工具得到整工具规则。应用的规则以通知回显。若 settings 写入
不可用或失败，调用仍放行一次，并有通知说明。

## 弹窗队列

审批与 ask-user 提问共享一个 FIFO，因此屏幕上同时只有一个弹窗。标题显示队列位置
（`Approval (1 of 3)`）；仅剩队首时保留朴素的 `Approve <tool>?` 标题。回答或中止
队首会提升下一项，中止仍在排队中的项会将其移除而不扰动屏幕上的内容。子代理引发的
审批以同样方式排队和展示，切换会话会结算所有停放的弹窗。

## Shell 模式（`!`）

以 `!` 开头的输入框行作为**本地 shell 命令**运行而不是发给模型——在空输入框上键入
`!`，或整行粘贴 `!` 前缀的行。键入 `!` 会把编辑器边框翻成警告色；
退格删除或按 Esc 恢复强调色边框。

- 命令经挂载的 shell 执行器运行（120 秒超时，64KB 输出预算），且即使 agent 忙碌
  也会运行，绕过 outbox。
- 输出渲染为状态行——一条 `$ <command>` 回显加上封顶 20 行的合并输出——在非零
  退出、信号死亡或超时时按错误样式显示。**任何内容都不会到达模型或会话日志。**
- 命令运行期间，`⠋ running…` 通知停在输入框上方，输入框吞掉输入
  （Ctrl+C 仍然负责中断/退出）。
- `!` 模式保留自己的历史：↑/↓ 浏览，并持久化到
  `$DSH_HOME/tui/bash-history.txt`，与输入框的消息历史分开。Esc 退出该模式且
  永不中断运行中的轮次。

## 主题

界面颜色经插件的 `theme` 配置块设置。六个角色可用——`accent`、`success`、`error`、
`warning`、`muted`、`highlight`——每个接受基础 ANSI 颜色名
（`red`、`brightCyan`）或原始 SGR 参数串（`31`、`1;31`、`38;5;208`）。每个角色都
可选；未知名称、畸形代码和非字符串值按角色静默回退到内置调色板，块缺席时产生
完全默认的外观。

从你的 profile 补丁（`~/.dsh/profiles/tui/cordis.patch.yml`，在每个 bundle 之后
应用）覆盖：

```yaml
- id: tui
  config:
    theme:
      accent: brightCyan
      success: '32'
      error: '1;31'
      warning: '38;5;208'
      muted: '2'
      highlight: magenta
```

这些角色驱动编辑器边框与自动补全、会话记录行、diff 卡片、overlay 盒子、围栏代码
高亮，以及 `!` shell 模式边框。
