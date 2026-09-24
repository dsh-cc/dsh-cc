# @dsh-cc/command-commit-split

[English](README.md) | 中文

建议型、仅预演的 `/commit-split` 命令：通过 shell 服务读取工作区变更（status + 暂存 + 未暂存），向深度推理通道（模型别名 `blueprint`，经 [`@dsh-cc/side-query`](../../llm-tuning/side-query/README.md)）请求一份按依赖排序的原子提交拆分方案并渲染输出。它**从不提交**——由用户（或明确要求的模型）逐条执行建议。

## 命令契约

| 输入 | 结果 |
|---|---|
| `/commit-split` | 渲染拆分方案：按序分组的 `{ message, files, dependencyEdges }`，页脚声明所用依赖启发式。当 `blueprint` 别名未配置时，输出可见提示说明沿用主模型路由。 |
| `/commit-split help` | 规范帮助文本（经 `@dsh-cc/command-usage` 支持尾部 `help` 参数）。 |

错误段落（不输出方案）：模型输出不符合模式时为 `error: model output did not match the plan schema`；返回的依赖边成环时为 `error: dependency cycle among groups: a → b → a`。环检测在命令侧执行，从不交给模型。

## 数据与模型接缝

Git 数据只通过 `ctx.get('shell')` 的 `run`（或 `exec`）以 5 秒超时采集，且只使用三条只读命令：`git status --porcelain`、`git diff --cached --numstat`、`git diff --numstat`。所有读取在发起侧查询之前完成。命令绝不使用模型的 Bash 工具。

依赖启发式（在输出页脚声明）：共享顶层目录加变更文件间的文本 import 引用重叠，排序 source > test > docs。锁文件（`pnpm-lock.yaml`、`package-lock.json`、`yarn.lock`、`bun.lockb`）被移出模型分组，归入末尾的 `chore(deps)` 组；纯锁文件变更完全跳过模型调用。

## 组合

插件注入 `commands`。自定义应用挂载属主与本插件：

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: command-commit-split
  name: '@dsh-cc/command-commit-split'
```

## Model Experience

斜杠命令的输入与输出不出现在模型请求中。拆分查询是 `blueprint` 通道上的一次性侧查询（未配置时回退到继承的父路由并输出可见提示）；返回给用户的方案文本仅为展示层内容。

## 已知限制与暂缓事项

- **仅提供建议** —— 不执行暂存、提交或改写；当 import 为动态或文件为生成产物时，方案可能不够准确。
