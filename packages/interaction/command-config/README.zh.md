# @dsh-cc/command-config

[English](README.md) | 中文

面向用户的 `/config` 斜杠命令，对接设置服务：渲染生效的配置命名空间，或向某个命名空间写入白名单内的键值。无效的键或作用域只会返回友好的提示文本，绝不抛出错误。

## 用法

```ts
import { apply } from '@dsh-cc/command-config'

apply(ctx, {
  defaultScope: 'ui-theme',
  allowlist: ['ui-theme.theme', 'ui-theme.fontSize'],
})
```

## 提供的能力

- `/config` —— 不带参数时，将每个已注册的设置命名空间渲染为 `namespace = value (applies)` 一行。
- `/config [key] [value] [scope]` —— 解析更新参数，作用域缺省为 `defaultScope`（默认 `ui-theme`），值在形似结构化数据时按 JSON 解析（否则按字符串），并通过设置服务写入。
- 写入受 `namespace` 或 `namespace.key` 形式的受限白名单约束；默认白名单为 `ui-theme.theme` 和 `ui-theme.fontSize`。其余写入一律拒绝，并提示可写的键。

## 备注

- 注入 `commands` 与 `settings` 服务；命令经 `@dsh-cc/command-usage` 包装，因此 `help`/`-h`/`--help` 会渲染确定性的帮助文本。
- 设置更新产生的错误以文本形式报告，不会抛出。
