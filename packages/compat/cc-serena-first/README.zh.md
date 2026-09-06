# @dsh-cc/serena-first

CC 预设的 serena 优先提示词引导（参见 `README.md`）。

当 serena MCP 服务器已连接（仓库 `.serena/project.yml`，用户级
`~/.claude.json` 条目——见 `docs/code-intelligence-health.md`）时，会话中
存在约 30 个 `mcp__serena__*` 符号工具，可以在不整读文件的情况下回答代码
问题。本插件让系统提示词说明这一点：

- **贡献 A** —— 注册 `serena-first` 段落（order 105），动态 provider 在
  serena 就绪时渲染策略段落，否则渲染空字符串（渲染时被丢弃）。
- **贡献 B** —— `system-prompt/assemble` 瀑布监听器（`{ prepend: true }`，
  最外层，返回值权威），在 serena 就绪时以 replace-not-mutate 方式为上游
  `tool:read` 与 `tool:grep` 段落各追加一句。

检测仅依赖注册表且实时求值：对 `mcpConnections` 做鸭子类型读取
（`state: 'ready'` 且 `toolCount > 0`），每次组装时重新求值，因此会话中途
断开会在下一轮停止引导。无作用域的组装直接放行（与 `tool-append-order`
一致）；`tool:write`、`tool:edit`、`tool:glob` 永不改写。

配置：`enabled`（默认 `true`）、`serverName`（默认 `'serena'`）——后者同时
决定探测与所有 `mcp__<serverName>__*` 工具名。
