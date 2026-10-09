# @dsh-cc/completion-gate

完成门（completion gate）为每次落定的工具执行记一条哈希收据；收据存两份：
会话事件（`completion-gate/receipt`）和 `<dshHome>/completion-gate/receipts/`
下的仅哈希 JSONL 台账。`agent/turn-stopping` 时做一次检测：最终助手消息若声称
完成（"tests pass"、"committed"、"pushed"、"build succeeded"），而自最近一条真实
用户消息以来没有匹配的执行证据，就注入一次提醒。

- 默认关闭（`cc-completion-gate.enabled`）。哈希字段始终记录；清洗过的 bash
  命令头（≤200 字节，六步 scrubber）只在开启时捕获，且绝不写入台账文件。
- 提醒预算由 `nudges-per-session` 控制，默认每会话一次。两个键都只认用户层
  settings.json，每个事件热读。
- 委派工作：子会话的收据会 lift 到顶层会话的 lineage 桶；窗口里有委派收据
  而进程内没观测到子会话时，按 fail-open 处理。
- 声明表是一份数据文件（`src/claims.json`），按命令分段匹配。
- 跨包义务：注入类型 `completion-gate` 已加入 `@dsh-cc/memory`（recall）、
  `@dsh-cc/turn-rules`（matcher）、`@dsh-cc/advisor-watchdog`（delta）三处
  注入源拒绝列表，提醒文本不会进入 recall 查询、turn-rules 匹配候选或
  advisor 审查窗口。

设计文档：`docs/plans/2026-10-09-runtime-verified-completion.md`
