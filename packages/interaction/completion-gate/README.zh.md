# @dsh-cc/completion-gate

完成门（completion gate）：为每次落定的工具执行记录哈希收据——同时写入会话事件
（`completion-gate/receipt`）与 `<dshHome>/completion-gate/receipts/` 下的仅哈希
JSONL 台账——并在 `agent/turn-stopping` 时检测：当最终助手消息声称
完成（"tests pass"、"committed"、"pushed"、"build succeeded"）而自最近一次真实
用户消息以来没有匹配的执行证据时，每会话至多注入一次提醒。

- 默认关闭（`cc-completion-gate.enabled`）：哈希字段收据始终记录；隐私清洗后的
  bash 命令头（≤200 字节，六步 scrubber）仅在开启时捕获，且绝不写入台账文件。
- 委派工作：子会话收据会提升（lift）到顶层会话的 lineage 桶；未观测到委派的
  证据窗口按 fail-open 处理。
- 声明表是数据（`src/claims.json`），按命令分段匹配。

设计文档：`docs/plans/2026-10-09-runtime-verified-completion.md`
