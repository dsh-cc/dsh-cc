# @dsh-cc/workflow-journal

[English](README.md) | 中文

CC 对齐的工作流恢复日志。它注册 `cc-workflow-journal` 子代理 provider，包装
预设的 `spawn` provider 并为每个结算的工作流子代理记录日志，使同一会话中
通过 `resumeFromRunId` 发起的后续运行直接重放未变更的前缀，而非重新派生
（frozen-until-first-miss）。

## 行为

- **日志记录。** 每个在线子代理在结算后按到达序号写入日志（prompt、状态、
  结果）。一次运行的日志文件位于
  `$DSH_HOME/workflows/runs/<sessionId>/<runId>.jsonl`，每次刷新整体重写
  （tmp+rename），排序由 `ccWorkflowRunRegistry` 服务的 drain 顺序保证。
- **重放。** 收到恢复声明后，按到达顺序与旧日志逐一比对：对已完成行的
  哈希命中（prompt + outputSchema + agentOptions）返回一个伪造的
  `SubagentRun`——全新会话 id、结果取自日志、`dispose()` 立即完成——并通过
  `registry.markCached(runId, arrivalIndex)` 为持久的
  `tool-workflow/agent-start`/`agent-end` 记录附加 `cached: true`。首次失配
  （哈希、非完成状态、缺失行、损坏、到达字节上限）后该运行永久冻结：失配
  及其后的子代理全部在线派生（fail-open）。
- **保留策略。** 日志仅限同一会话：runId 在结算表条目存活期间可恢复。启动
  时清扫 `runs/` 下 mtime 超过 TTL（默认 24h）的会话目录；清扫只是磁盘
  卫生，并非崩溃恢复。
- **前向拷贝。** 对"已恢复运行"再次恢复时，先把重放的前缀拷入自己的日志，
  因此第二次恢复仍保留原始前缀。

## 与 CC 的偏差（已记录）

仅限同会话重放——跨会话与 `claude --resume` 式重放未实现；缓存键为请求
三元组（比 CC 仅按 prompt 键控更严格）；持久代理记录附加了 harness 不具备
的 `cached` 字段。
