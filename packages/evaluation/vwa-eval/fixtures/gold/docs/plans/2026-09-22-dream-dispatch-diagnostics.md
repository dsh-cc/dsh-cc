# Auto-dream dispatch diagnostics + lock hygiene（R4 取证先行）

2026-09-22 · 状态：待评审 · 上游事实：PR #102（pressure 机制）、PR #109（session-scan 修复）、同日下午两次受控触发实证

## 1. 问题与证据（全部实测定案）

R4 未修：pressure dream 的 fork 从不物化。2026-09-22 新构建（含 #109）下两次独立触发同签名：

- 14:15:27（pid 48567）与 15:23:13.491（pid 40442，宿主全程存活受控）：gate 全通（cooldown pass → `markPressureForced` stamp → `scanSessions` → `gateWindow` pass → `tryAcquireLock` 成功），随后 **memory-consolidation fork 会话文件零落盘**（T+21s/100s/7.5min 三窗全量 zstd label 扫描恒 0；历史上 extract/dream fork 全天为 0，而同刻 pre-step 路径的 memory-recall fork 正常物化）。
- 三个失血点：
  1. `runDream` 里 `await startMemoryJob(...)` **throw 路径无 `rollbackLock`**——锁裸滞留 1h（今天两把锁的死因）。listener 的 `.catch` 只有 `ctx.logger.warn`。
  2. `ctx.logger`（`memory:scan`/`memory:dream-gates`/`memory:dream-outcome`/dispatch warn）**进程外不可回收**（`~/.dsh` 无日志落盘）——#109 加的可观测性运行时实际看不到，R4 因此至今无错误文本。
  3. `startMemoryJob` 的 seam-undefined 快速失败分支完全静默（虽会经 `job.done` 回滚锁，但无任何痕迹）。

断点已收敛：`tryAcquireLock` 之后、fork 落盘之前，即 `startMemoryJob` 内 `subagents.start` 一段。**缺的是 throw 还是 hang、以及错误全文。**

## 2. 本 PR 范围（诊断 + 止血；spawn 根因修复留给拿到错误文本后的跟进 PR）

### 2.1 新增 `packages/memory/memory-consolidation/src/diagnostics.ts`

`recordDreamDiagnostic(fs, dir, policy, entry)`：向 `<workspaceMemoryDir>/.dream-last-error.json` **整文件覆写**。写入形态与 `lock.ts`/`pressure.ts` 逐字节同款（`fs.writeText(target, content, policy)` 直写，**禁止走 `writeMemoryFiles`**——FILE_NAME 白名单会拒 `.json`/dotfile；评审已核实 `memoryWritePolicy` 仅 `{mode:'workspace-write', workspaceRoot:dir}`，直写放行）。entry 形状：

```json
{ "at": 1790061793491, "pid": 40442, "sessionId": "tui-…", "phase": "dispatch-throw", "detail": "Error: …\n<stack>" }
```

设计取舍：覆写而非追加——失败是低频冷路径，只需"最新一份"；复用既有 policy 免得新开写入面。诊断文件永不 throw（try/catch 吞掉，但 catch 保留一行 `ctx.logger.warn`——评审 Minor-3；诊断不能反过来杀 dream）。

### 2.2 `src/index.ts`（runDream）三处改动

1. **try 域从"拿锁成功"开始包到 `startMemoryJob` 返回**（评审 Major-2：`buildConsolidationPrompt` 同步 throw 同样裸滞留锁）。catch 里 `recordDreamDiagnostic(phase:'dispatch-throw', String(err)+stack)` → `rollbackLock(fs, dir, priorAt, policy)` → 保留 `ctx.logger.warn` → 正常返回（不再抛给 listener；listener 的 `.catch` 留作兜底）。
2. **`dispatch-started` 标记**（评审 Major-1）：`tryAcquireLock` 成功后、spawn 前先覆写一条 `phase:'dispatch-started'`。文件停在 started = hang（subagents.start 不 resolve 不 reject）；文件缺席 = 没走到 spawn；再被 dispatch-throw/outcome-failed 覆写 = throw。一行写入，hang/throw 双死法皆可区分。
3. 既有 `job.done.then(outcome => …)` 的 `status !== 'completed'` 分支：回滚锁**之前**补 `recordDreamDiagnostic(phase:'outcome-failed', detail)`——把 seam-unavailable、fork stopReason 异常、validate/write-back 失败全部落盘。
4. 成功路径不变（tomb marker、放锁语义照旧）。

边界明示（评审 Minor-4）：拿锁之前的 throw（readPressure/scan reject）仍走 listener warn、不落诊断——无锁泄漏，且证据已收敛到锁后段，可接受。

### 2.3 `src/memory-job.ts`

不改签名。seam-undefined 分支的可见性由 2.2.2 覆盖（`done` resolve 为 failed 且 detail 含 `'jobs/subagents seam unavailable'`，经 outcome-failed 落盘）。如评审认为应就近，也可在该分支加一行 `ctx.logger.warn`，二者不冲突。

### 2.4 测试（`packages/memory/memory-consolidation/tests/`）

- dispatch-throw：fake `subagents.start` reject → 锁内容回到 `priorAt` + `.dream-last-error.json` 存在且 phase 正确。
- outcome-failed：run.result resolve `{stopReason:'error'}` → 回滚 + 诊断落盘。
- seam-unavailable：ctx 无 jobs/subagents → 诊断落盘且 detail 匹配。
- 诊断写自身失败（fake fs throw）→ dream 流程不受影响。
- priorAt 语义钉死（评审 Minor-5）：构造 `priorAt = now - 5min`（<LOCK_STALE_MS），dispatch-throw 回滚后断言立即 `tryAcquireLock` 返回 null（回滚写出 `at>0` 的 epoch，被 held 判定挡住——既有 quirk，测试文档化之）。
- dispatch-started 标记：fake `subagents.start` 返回永不 settle 的 run → 断言文件停在 `dispatch-started`（hang 可区分性的直接证明）。
- 既有套件全绿（基线 5338P）。

## 3. 明确不做

- **spawn 根因修复**（候选排序：a. turn-stopping 相无驱动——改挂下一 turn 的 `agent/pre-step`，armed marker 即天然队列；b. `subagents.start` 参数面在 prod 炸；c. signal/abort 浅因）：必须等 2.1 产出的错误文本定案，否则是换一种静默死法。
- hung-run watchdog：`LOCK_STALE_MS`（1h）已兜底，追加计时器只增 fiber 复杂度。
- 会话 inbox notice 通道：文件 sink 已够取证，notice 是加分项留给后续。
- capabilities manifest / parity：纯内部诊断写，不触 CC 兼容面；presubmit 照常跑 `check:capabilities`/`check:parity` 验证此判断。

## 4. 验收探针（复用 9-22 实证手法）

merge + sync profile 后：marker 现仍 armed，cooldown 至 16:23:13——之后任意存活会话 turn-end 自动复现（或同名覆写把索引顶过 25000B 主动 arm）。触发后读 `<workspaceMemoryDir>/.dream-last-error.json`：

- 拿到错误全文 → 开 Phase B PR（按 §3 候选排序）。
- fork 落盘 + marker tomb + MEMORY.md mtime 前进 + 锁正常释放 → R4 已愈，本诊断链留作常设可观测。

## 5. 风险

极低：新代码只在失败冷路径执行（这些路径今天只丢信息）；每失败一次一次覆写，无累积；诊断写自身吞错。对成功路径零改动。
