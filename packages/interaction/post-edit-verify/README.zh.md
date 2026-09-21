# @dsh-cc/post-edit-verify

English | [中文](README.zh.md)

（中文说明，与英文版实质等价。）

编辑后自动验证：在 `edit`/`write` 工具结果被接受之后，插件通过 harness ShellExecutor 运行用户声明的快速校验命令，并把其结果（`[auto-verify]` 文本块）**追加**到**同一条**工具结果上——一次观察同时覆盖编辑与校验两个事件，校验失败无需额外的模型往返。**默认关闭**（`cc-post-edit-verify.enabled: false`，需主动开启）。

## 工作方式

插件注册一个 `tools/post-execute` 监听器（普通插件，无 Service、无 isolate key），监听器注册时**不带 prepend**，因此组合在 context-crusher 的最外层 post-execute 监听器之内，追加的文本在下游仍是 crusher 可压缩的。每次接受 `edit`/`write` 结果时，监听器重新读取用户层原始配置文件（热加载，仅几 KB），选出第一条路径 glob 匹配被编辑文件的规则（路径在会话 cwd 之下时按相对路径求值），以会话 cwd 为工作目录运行命令。非零退出会追加失败尾部输出；成功几乎静默——仅一行 `[auto-verify] <command> — ok (<n>ms)`——除非设置 `verbose-on-success`。被跳过或重叠的运行总是带标签（burst 标记），绝不静默。

## 配置（仅用户层）

用户层 `settings.json`（harness-home 文件）中的 `cc-post-edit-verify` 键。**永不读取**项目作用域规则——校验规则是个人效率设置，不是项目产物；仅写在项目 settings 中的规则在结构上不可见（并非"被拒绝"）。

| 键 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `false` | 总开关，**需主动开启**。 |
| `rules` | `[]` | `{ glob, command, timeout-ms? }` 数组；首个匹配生效。 |
| `debounce-ms` | `5000` | 仅用于 burst **标注**窗口——每个匹配的编辑仍然运行；窗口内的运行会带 `burst — result may overlap edits` 标签。 |
| `max-output-bytes` | `4096` | 校验输出的保留尾部的捕获预算。 |
| `verbose-on-success` | `false` | 默认成功近乎静默（仅一行）。 |
| `timeout-ms`（每条规则） | `60000` | 每条规则的超时，上限 `120000`。 |

## 命令环境

规则在 **POSIX shell**（`sh` 语义）中运行——不支持 Windows 原生语法。命令经 harness ShellExecutor 执行，超时即被杀死；超时或被信号杀死的运行不追加任何内容（编辑结果保持原样）。Node 单行命令（`node -e "…"`）是较好的跨平台写法。

## 形态

普通 cordis 插件，`inject = ['shell']`（tool-use-summary / prompt-suggest 惯例）。由 `packages/preset/cc` 挂载在 cc-services 组。全程 fail-soft：任何故障都退化为透传——用户的工具结果绝不会变成错误结果。
