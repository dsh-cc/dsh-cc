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
| `judge-route` | 别名 `gauge` | 别名或 `{provider, model, protocol}`；未设置时用 `gauge` 通道别名（须解析为 System One 路由，否则 moa 保持未启用） |
| `classify-budget-tokens` | `4000` | 分类输入预算 |
| `call-budget-ms` | `8000` | 每条消息的级联截止时间 |

## 如实的模型记账

当 moa 在 boot 选择上覆盖某个档位时，以下两处原本会谎报实际服务的模型：

- **过滤幻影通知。** 覆盖生效时，harness 几乎每一步都会重发
  `[model changed: …]` 通知，声称会话将继续使用一个覆盖层并不会
  服务的模型。共置的 sanitizer（`@dsh-cc/moa/sanitizer`，在 TUI driver
  与 ACP model control 中紧跟 harness 的 `installModelSelection` 注册）
  会精确丢弃这些行：仅当覆盖在 boot 选择上激活时。其余一切状态 ——
  moa 关闭、已解除武装、校验失败、或根本没有 moa —— 通知原样透传。
- **覆盖期间 `/model` 依然生效（逃生舱）。** 会话中途 `/model`
  切换离开 boot 选择会在下一轮分类之前解除 moa 的武装：线路按你的
  选择服务、不再发出状态行；切回 boot 选择后从下一轮重新武装。
  此前该切换在覆盖期间会被静默忽略。
