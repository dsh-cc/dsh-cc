# moa — 分层级联路由

`@dsh-cc/moa` 将主会话轮次路由到四个 lane 别名（`sketch` / `draft` /
`blueprint` / `masterplan`）：每个用户轮次由 System One 决策调用分类到
足够胜任的最便宜档位；可选的验收 judge 在拒绝时升级到上一档。
**默认关闭** —— `moa.enabled: false` 时不挂载任何监听、零开销。
子代理 / fork 永远不被覆盖。

## 配置（`moa` 命名空间）

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `false` | 在主代理上启用分层路由 |
| `acceptance.enabled` | `false` | 运行验收 judge 并对拒绝采取行动 |
| `acceptance.shadow` | `false` | 运行 judge，仅记录结论 |
| `acceptance.tau` | `0.7` | `P(acceptable) < tau` 时拒绝 |
| `max-escalations` | `1` | 每条消息的升级上限（读取时钳制为 3） |
| `judge-route` | `llmbox_systemone/bjev` | 别名或 `{provider, model, protocol}` |
| `classify-budget-tokens` | `4000` | 分类输入预算 |
| `call-budget-ms` | `8000` | 每条消息的级联截止时间 |
