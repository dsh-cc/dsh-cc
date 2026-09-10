# @dsh-cc/command-diff

[English](README.md) | 中文

面向用户的 `/diff` 斜杠命令，面向 git 工作目录：通过会话的 shell 服务展示整个工作树的 `git diff --stat`，或单个文件经截断的 diff。每次 git 调用限时 10 秒；非 git 工作目录会返回友好提示，绝不抛出错误。

## 用法

```ts
import { apply } from '@dsh-cc/command-diff'

apply(ctx)
```

## 提供的能力

- `/diff` —— 在会话的工作目录运行 `git diff --stat` 并渲染摘要（为空时显示 `No changes.`）。
- `/diff [path]` —— 运行 `git diff -- <path>`，输出截断至 `MAX_DIFF_LINES`（400）行，被截断时附加 `… (N more lines)` 提示。
- 先执行 git 探测（`rev-parse --is-inside-work-tree`）；不在仓库中时命令以友好文本应答而非失败。

## 备注

- 注入 `commands` 与 `shell` 服务；路径在被拼入 shell 命令字符串前会做单引号转义。
- 命令经 `@dsh-cc/command-usage` 包装，因此 `help`/`-h`/`--help` 会渲染确定性的帮助文本。
