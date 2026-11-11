# @dsh-cc/bundle-acp

[English](README.md) | 中文

面向 dsh 的 Agent Client Protocol（ACP）profile bundle，以单个 cordis bundle patch 交付：插入 cc preset 花名册、挂载 `@dsh-cc/acp` 协议驱动，并替换 harness 自带的 `acp` 插件。宿主 agent plane 由 [`@dsh-cc/bundle-shell`](../cc-shell/README.zh.md) 统一腾空 —— 清单与 TUI 车道共享，不在本 bundle 复述。

## 用法

本包没有可导入的 API。它通过 `./cordis.patch.yml` 导出作为 bundle patch 消费——通常经由 `dsh-cc acp` 启动器子命令安装到 `cc-acp` profile：

```yaml
bundle:
  patch: '@dsh-cc/bundle-acp/cordis.patch.yml'
```

## 它提供什么

按注册顺序：

- 宿主 plane 禁用项 —— 仅 `acp` 与 `session-title-llm-cc` 两行（见下文「替换」）。22 行的 agent-plane 清单一律由 `@dsh-cc/bundle-shell` 禁用，本 bundle 自身不声明任何 agent-plane 行。有意不含 `hmr`：保留的 `@deepseek-ai/dsh-acp-app` bundle 已在 profile 激活时将其禁用。
- Preset 花名册 —— `agent-preset-registry`（默认 `cc`）加上 `preset-cc`，其 `cc-composition` include 行从 profile 的 node_modules 挂载 `@dsh-cc/preset-cc/agent.cordis.yml`。
- `acp-cc` —— `@dsh-cc/acp` 插件，带 `inject: [acpAppStartup]`（防止插件在启动参数解析前抢占 stdout 的 stdio 闩锁）与 `presetId: 'cc'`；provider/model 路由覆盖为可选项。
- 替换 —— 禁用 harness 的 `acp` 行（由 `acp-cc` 取代；能生效是因为 dsh-acp-app bundle 保留在 floor 中），并禁用 `session-title-llm-cc`，避免每个会话产生标题模型调用。

## 备注

- 不得触碰：`tools`（cc-shell 重新挂载 tools-cc）、`settings`/`permission-rules`（cc-permissions）、`user-questions`、HTTP/webserver 行。
- `@deepseek-ai/dsh-agent-preset-registry`、`@deepseek-ai/dsh-agent-preset` 与 `@deepseek-ai/cordis-plugin-include` 行一律由 dsh 安装树**环境化解析**，绝不可成为 floor/bundle 的依赖副本：这些包一旦存在第二个 realpath，模块级全局状态即分裂（dsh-scope 的 `kScope` 是模块局部 Symbol），roster standing scope 的注册会塌落到全局层、导致 preset 挂载失败（2026-10-10 活体根因实证）。这与 bundle-tui 同款惯例：harness 自有运行时包走环境化解析，只有 dsh-cc 自有的包（`@dsh-cc/acp`、`@dsh-cc/preset-cc`——include 行的文件路径锚点）才是硬依赖。
