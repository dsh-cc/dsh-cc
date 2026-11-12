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
| `context-routing.mode` | `off` | off/shadow/active —— 上下文感知分类 v2（见下） |
| `context-routing.timeout-ms` | `1500` | 单次决策超时毫秒数（读取时钳制 100..8000） |
| `context-routing.max-input-tokens` | `4000` | 路由状态 + 问题的预算（读取时钳制 512..16000） |
| `context-routing.max-under-tier-probability` | `0.10` | 所选档位之上的概率质量上限（0..0.5） |
| `context-routing.min-top-probability` | `0.60` | 最高概率低于此值时回落到实际选择（0.25..1） |

## 上下文路由 v2

`context-routing`（可选，默认 `off`）把对四档答案取 argmax 的做法，替换为
上下文感知的分类加尾部风险档位策略：分类器看到该轮的有界历史切片（当前
请求、最近三条用户请求、最近一次助手回答与工具名 —— 绝不含参数、路径或
结果），应用的档位是「其之上的概率质量不超过 `max-under-tier-probability`」
的最便宜档位。`shadow` 与旧分类器并行：模型仍由旧结果决定，因此 shadow 明确
接受双份分类调用的开销；`active` 完全取代旧分类器。两者都要求
`moa.enabled: true` 且武装成功，显式 `/model` 依然优先。升级重试路径与
子代理 / fork 会话永不分类。启用 `active` 前必须先通过离线评估闸门
（`moa/eval/context-routing.json`，120 条盲标用例）；把
`context-routing.mode` 设回 `off` 即完成全部回滚。

## 启用阶梯

启用时 moa 通过 `ccModelRoutes` 解析四个 lane 别名（`resolveTiers`，
`src/tiers.ts:50`）。任一 lane 不能解析为具体的 provider 和 model 时拒绝启用。
解析后的阶梯必须由「连续段」构成且至少含两条不同路由：同一路由只能紧邻重复
（`[A,A,B,C]` 可启用），在另一路由之后再次出现（`[A,B,A,C]`）会因升级会向下
跳而拒绝，全部相同的阶梯同样拒绝。升级沿启用时拍下的阶梯快照移到下一个不同档位。

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
- **系统提示声明实际模型。** 只要覆盖生效，moa 的 assemble 监听器会把
  系统提示的 `provider`/`model` 变量改写为解析后的档位对（绝不写 effort
  字段）；任何 fail-open 路径（分类失败/超时、偏离 boot 选择、已禁用）
  都保留 harness 自己的选择变量 —— 提示与线路始终一致。
- **状态栏显示实际配对。** 覆盖生效时，状态栏渲染
  `<模型 id> ◂ <档位别名>`（例如 `<模型 id> ◂ sketch`），
  而非裸档位别名 —— 内置底栏与自定义命令负载（`moa: {tier, model}`）
  皆如此。真实切换离开时清空该段；无覆盖时显示普通选择。
- **状态栏显示未武装的原因。** `moa.enabled: true` 但武装被拒（路由不可用、
  档位阶梯退化、judge 路由窗口校验失败）时，状态栏渲染
  `moa:unarmed — <原因>`，自定义命令负载携带 `moa: {unarmed}` ——
  配置问题因此可见，而非只藏在警告行里。武装成功（或收到已路由通知）即清空。
  `moa disabled`（默认关闭人群）不渲染任何内容。
