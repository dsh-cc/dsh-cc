# @dsh-cc/command-init

[English](README.md) | 中文

面向用户的 `/init` 斜杠命令：为模型排队一次 CLAUDE.md 初始化。命令本身不做任何分析——它把一份忠实移植 Claude Code 的初始化提示词作为后续用户轮次交给 agent，随后立即确认。

## 用法

```ts
import { apply } from '@dsh-cc/command-init'

apply(ctx)
```

## 提供的能力

- `/init` —— 通过 `invocation.agent.followup` 提交初始化指令（分析仓库结构、确定构建/测试命令、记录约定、写入或刷新 CLAUDE.md），然后回复 `Initializing CLAUDE.md…`。
- 提示词以 `INIT_PROMPT` 导出（`initContent()` 返回其用户消息内容块），宿主可以检视或复用。

## 备注

- 仅注入 `commands` 服务；实际工作发生在排队的模型轮次中，而非命令处理器内。
- 命令经 `@dsh-cc/command-usage` 包装，因此 `help`/`-h`/`--help` 会渲染确定性的帮助文本。
