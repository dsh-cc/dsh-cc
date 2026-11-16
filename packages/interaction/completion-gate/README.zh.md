# @dsh-cc/completion-gate

完成门（completion gate）为每次落定的工具执行记一条哈希收据；收据存两份：
会话事件（`completion-gate/receipt`）和 `<dshHome>/completion-gate/receipts/`
下的仅哈希 JSONL 台账。`agent/turn-stopping` 时做一次检测：最终助手消息若声称
完成（"tests pass"、"committed"、"pushed"、"build succeeded"），而自最近一条真实
用户消息以来没有匹配的执行证据，就注入一次提醒。

- **2026-11-11 起默认开启**（`cc-completion-gate.enabled` 默认 `true`，经生产
  dogfood 由暗发布转正；如需关闭设 `false`）。哈希字段始终记录；清洗过的 bash
  命令头（≤200 字节，六步 scrubber）只在开启时捕获，且绝不写入台账文件。
- 提醒预算由 `nudges-per-session` 控制，默认每会话一次。两个键都只认用户层
  （harness 家目录 `<dshHome>/settings.json`），每个事件热读。
- **enforce 模式**（可选开启，设计文档
  `docs/plans/2026-11-17-completion-gate-enforce-mode.md`）：设
  `cc-completion-gate.mode: 'enforce'` 后，一次性提醒升级为有界强制循环——
  最终助手消息仍带未证实的完成声明时，门会重开本回合（同回合注入），直到
  声明被一次成功（`outcome: 'ok'`）的收据满足、模型从最终消息里删掉该短语
  （撤回），或窗口级预算（`enforce-max-cycles`，默认 3，夹取 1-10）耗尽。
  耗尽时记录 `completion-gate/enforce-exhausted`；真正的 `turn/end` 时由
  对账逻辑在最终消息仍带未证实声明的情况下补写终局
  `completion-gate/unverified` 标记（微任务延迟 append；标记只进会话事件流，
  暂无 TUI 渲染）。撤回是词面级的：道歉时仍包含声明短语不算撤回。咨询性
  `nudges-per-session` 预算与之独立（enforce 提醒带 `cycle` 字段，不消耗
  它）。enforce 模式的满足判定要求执行成功，lineage lift 的子收据同样携带
  `outcome`。评估类 fail-open（窗口内压缩、composite、horizon）会同时跳过
  强制与终局标记。默认仍是 `mode: 'nudge'`——enforce 待 dogfood 后再定。
- 委派工作：子会话的收据会 lift 到顶层会话的 lineage 桶；窗口里有委派收据
  而进程内没观测到子会话时，按 fail-open 处理。
- 声明表是一份数据文件（`src/claims.json`），按命令分段匹配。
- 跨包义务：注入类型 `completion-gate` 已加入 `@dsh-cc/memory`（recall）、
  `@dsh-cc/turn-rules`（matcher）、`@dsh-cc/advisor-watchdog`（delta）三处
  注入源拒绝列表，提醒文本不会进入 recall 查询、turn-rules 匹配候选或
  advisor 审查窗口。

设计文档：`docs/plans/2026-10-09-runtime-verified-completion.md`
