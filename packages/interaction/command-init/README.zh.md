# @dsh-cc/command-init

[English](README.md) | 中文

面向用户的 `/init` 斜杠命令：为模型排队一次 CLAUDE.md 初始化。命令本身不做任何分析——它把一份忠实移植 Claude Code 的初始化提示词作为后续用户轮次交给 agent，随后在 MoA 路由步骤返回后确认。

## 用法

```ts
import { apply } from '@dsh-cc/command-init'

apply(ctx)
```

## 提供的能力

- `/init` —— 通过 `invocation.agent.followup` 提交初始化指令（分析仓库结构、确定构建/测试命令、记录约定、写入或刷新 CLAUDE.md），然后回复 `Initializing CLAUDE.md…`。
- 命令自行注入初始化提示词。`INIT_PROMPT` 与 `initContent()` 位于 `src/init.ts`，属于内部实现：它们不从包入口重新导出，且 `src` 不随包发布。

## 备注

- 仅注入 `commands` 服务。模型工作在排队的轮次中完成；处理器在 followup 之前先等待一次 MoA 路由步骤（`routeBeforeAdmission`），因此确认消息在该 await 之后才发出。
- 依赖 `@dsh-cc/moa` 完成入口路由。moa 未挂载时 `routeBeforeAdmission` 不产生副作用。
- 命令经 `@dsh-cc/command-usage` 包装，因此 `help`/`-h`/`--help` 会渲染确定性的帮助文本。
