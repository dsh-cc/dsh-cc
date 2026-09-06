# @dsh-cc/session-title-provider

[English](README.md) | 中文

CC 宿主面 first-prompt 会话标题提供方：镜像原生 `session-title-first-prompt-llm` 插件，但在调用共享的 `generateSessionTitleWithLlm` 之前，从 CC 模型别名廉价通道（`resolve('haiku')`）解析并盖印辅助模型路由。

## 路由解析

辅助标题请求的路由按以下优先级确定：

1. **显式 `provider`+`model` 配置对**（两个字段成对出现）直接胜出。
2. **已配置的 `haiku` 别名**——优先经已挂载的 `ccModelRoutes` 服务解析，否则直接实时读取 `model-aliases` 设置覆盖（读取绝不重新注册该命名空间；`settings.register` 遇重复命名空间会抛错）。字符串形式别名（`haiku: deepseek-v4-flash`，仅 model）会从请求记录的主请求路由继承缺失的 provider。
3. **继承**——两者皆无时使用请求中记录的主请求路由。

未配置的内建别名同样继承，因此不配置 `haiku` 时本插件与原生插件行为一致。

## 组合

cc-shell 通过在其 bundle patch（`cordis.patch.yml`）中禁用原生 `session-title-llm` 行并插入本行（`session-title-llm-cc`）来挂载该宿主面行，默认框架策略为 `targetWords: 5`、`targetCjkCharacters: 10`、`maxInputBytes: 4096`、`maxOutputTokens: 64`、`timeoutMs: 60000`。

插件注入 `sessionTitle`、`llm` 与 `sessions`；它以 `automatic: 'first-prompt'` 注册一个提供方，标题自会话的第一条人类消息生成。标题的接受、记录与折叠由宿主 session-title 服务持有——本包只负责路由盖印与消息选取（第一条人类消息）。

## 已知限制与暂缓事项

- **只针对首条提示**——与 CC 不同，后续提示不会重新生成标题（未启用 `all-prompts` 节奏）。
- **不含 `/rename`**——用户重命名由 `command-rename` 命令提供；标题固定由标题服务自身完成。
