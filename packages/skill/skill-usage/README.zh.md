# @dsh-cc/skill-usage

English | [中文](README.zh.md)

Skill-usage 遥测：一个只观察的 cordis 插件，把每一次已提交的 skill 加载记入按工作区划分的 sidecar 账本，并派生每工作区的 utility 报告，其 demote 候选列表**仅作报告**——降级（demotion）由人工执行。**默认开启**（`cc-skill-usage.enabled: true`）。

## 观察什么

- **工具形态** —— 只读的 `tools/result` 监听器（`@mode emit`，绝不使用 `tools/post-execute`）：仅当最终裁定结果为成功（`exec.name === 'skill'`，`result.isError === false`）才计一次加载，即瀑布之后、取消之后。技能名取自 `exec.arguments.name`（收窄为 string）；结果值上若有 string `provider`，原样复制到行上作为免费归因。
- **斜杠形态** —— `session/event` 监听器，匹配持久化的 `source.kind === 'skill-invocation'` 的 `user/message` 事件。手势语义在 tool-skill 内；本监听器绝不重新解析用户文本。每个通过校验的技能一条事件；一条消息含多个 `/name` 记号时产生多条。
- **Rollup 触发器** —— `session/created` 监听器在报告过期时重算 utility 报告（基于输入水位）；`skills/learned-changed` 监听器删除全部报告，使目录变更令所有工作区失效。

每次加载是追加式 JSONL 的一行 `{ v:1, ts, sessionId, skill, via: 'tool'|'slash', provider? }`（`ts` 为 epoch 毫秒）。项目键不可解析时跳过该行（debug 日志）；无 provider 的宿主上遥测是完全的 no-op。绝不向会话转录追加任何内容——自定义 session 事件在该 JSONL 持久化层会毒化重开（设计 §3.6），因此 v1 仅用 sidecar，`sessionId` 列为后续连接保留键。

## Sidecar 布局（`<dshHome>/skill-usage/`）

- `loads-<projectKey>.jsonl` —— 只追加账本，每次已提交加载一行。
- `observing-since-<projectKey>` —— 观察覆盖起点标记（缺则建；遥测禁用期间删除，因此覆盖指"开启状态下的墙钟时间"）。
- `utility-<projectKey>.md` —— 派生的、可再生的 utility 报告：每技能加载数（30 天 / 全历史）、去重会话数、最近加载、从未加载的 learned 技能（按 SKILL.md mtime 计龄）、demote 候选（learned、30 天零加载、龄 > 14 天、覆盖 ≥ 30 天），以及标注归因不确定的当前遮蔽项。以唯一临时文件 + rename 原子发布；报告原样陈述规则，并注明**降级由人工执行**（`manage_skill` 删除或编辑）——v1 不采取任何动作。

## 配置（仅用户层）

用户层 `settings.json` 中的 `cc-skill-usage` 命名空间。逐事件原始读取对项目作用域不可见（与 advisor watchdog 相同的限制）。

| 键 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关，经逐匹配事件的用户层原始读取热切换。为 false 时：不追加账本、不写报告；既有文件保留，覆盖标记被删除。 |
| `rollup-stale-hours` | `24` | 报告过期窗口（rollup 时经级联读取）。 |
| `never-loaded-days` | `30` | 仅约束报告的"Never loaded"一节。 |

## 限制

- **仅主 realm**：观察接缝按作用域过滤，子代理的 skill 加载不可见（明确陈述的边界，而非数字缺口）。
- **`enabled` 的原始读取仅看用户层** —— 项目/仓库层设置对逐事件闸门不可见。
- **按名归因**：加载以技能名计；当前被遮蔽的 learned 技能，其加载可能属于遮蔽它的技能（报告中标注归因不确定）。
- **v1 账本无上限**：只追加，每次 rollup 全量扫描；轮转为后续项。
