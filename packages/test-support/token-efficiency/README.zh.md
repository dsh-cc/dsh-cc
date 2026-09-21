# @dsh-cc/token-efficiency

dsh-cc 的 token 效率评测装置：固定语料库、冻结验收门槛与比较器（计划见 `docs/plans/2026-09-20-token-efficiency-eval-harness.md`）。Slice A 仅交付 redactor 与语料加载器。

## Tier 语义

- **replay** — 指标定义回归套件。向量是（固定脱敏 fixture、当前 `metrics.ts`）的确定性函数；replay 向量变化意味着指标定义变了。绿色 replay tier 永远不构成"某功能省了 token"的证据。replay 唯一允许的失败方式是解析/折叠错误。
- **mock-script** — 功能接线回归套件。MockAdapter 脚本化运行断言功能会触发（或正确地不触发），且指标折叠记录了流量。每个功能两个脚本：触发用例与不触发对照。
- **live** — 改进声明的唯一归属地。held-out、逐 PR、手工运行；结果作为证据附在 PR 上，绝不回流用于调优同一候选。

## 纪律规则（约束性）

1. `eval-gate.yaml` 的修改必须单独成 PR — 由 presubmit 冻结检查强制执行。
2. live tier 的结果绝不用于调优它所度量的候选。
3. baseline 刷新是独立的 PR；`metrics.ts` 的变更强制刷新 baseline。
4. 每个声称效率收益的 PR 必须运行各 tier，并把报告首行粘贴到 PR 描述中。

## 语料布局

描述符 YAML 集中放在本包的 `corpus/` 下；脱敏 replay fixture 放在 `fixtures/` 下。已记录的取舍（计划 §3.2 vs §6）：**v1 采用本包下的集中式 `corpus/`；按功能共置仍可通过 fixture 路径实现。**

原始会话日志永不提交；redactor（`src/redactor.ts`）产出字节稳定的脱敏 blob 供评审与提交。

## CLI（bin）

`pnpm check:token-efficiency` 以包内默认参数运行 `check`；bin 本身通过 tsx 运行（`pnpm exec tsx packages/test-support/token-efficiency/src/bin.ts <子命令> …`）：

- `sanitize <session.jsonl|.zstd|-> [--out <path>]` — 原始日志 → 规范化脱敏 JSONL（Phase-0 dogfooding）。`--out` 要求恰好一个输入；否则输出到 stdout。
- `run [--gate <path>] [--corpus <dir>] [--write-baseline <path>]` — 折叠每个 replay 任务的 fixture；逐任务打印一行向量（tokens、cost、counters）及页脚。`--write-baseline` 写出 `{foldedAt, ref: $TOKEN_EFFICIENCY_BASELINE_REF ?? 'unpinned', vectors}`。
- `check [--gate <path>] [--corpus <dir>]` — 加载门槛与 baseline、折叠候选、逐任务判定、逐任务 usage 覆盖率、页脚。解析失败、capability 回归、定义变更、counter 期望不满足、候选/baseline 向量缺失时退出 1；参数错误退出 2。

非 replay 任务被跳过并打印一行延迟提示；mock-script 运行器属于后续 slice。

每次运行都以页脚结尾：

> token-efficiency tiers: replay = metric-definition stability only (a green replay tier is NOT savings evidence) · mock-script = wiring regression · improvement claims belong to the live tier only

## Presubmit 门槛（freeze + rot）

`scripts/check-eval-gate.mjs`（CI 步骤 `check:eval-gate`，仅 PR）基于与 `origin/main` 的净 PR diff 强制执行上述纪律：

1. **Freeze** — `eval-gate.yaml` 的修改或删除若与任何 `packages/**/src` 变更同时出现即被拒绝：门槛必须单独成 PR。**豁免**：在本 PR 中新建该文件（净状态 A）属于 bootstrap 情形，静默放行。
2. **Rot** — `src/metrics.ts` 新增或修改时，若门槛 `baseline.vector` 指向的文件未在同一 diff 中新增/修改，则被拒绝。当 `eval-gate.yaml` 在磁盘上缺失或不可解析时跳过（带日志）。

live tier 属于 Phase 2 延后项：仅手工运行（单向阀），任何 nightly 排期之前至少需要 ≥3 次手工运行。

## Mock-script 档位（接线回归）

`corpus/mock/*.yaml` 描述符由 mock 档位运行器（`src/mock-run.ts`，plan §3.2）
执行：每个任务 id 对应一个场景，启动真实的插件栈——真实 agent loop、真实工具
运行时、真实 token meter、真实特性插件（ContextCrusher / CompactionCostGate），
以及真实的 basic 压缩引擎——仅用脚本化的 `MockAdapter` 顶替 LLM（参照
context-crusher 的 `composition.spec.ts`）。场景在描述符 `prompt` 上驱动真实
agent loop，通过真实的会话 surface 访问器（`session.surface.nodes` +
`session.eventAt`，不用 `snapshotEvents()`）收集结果，并折叠：

- `foldMetricVector(events, { task })` —— 共享 token/cost 轴（仅报告，绝不参与 mock 档位门禁）；
- 特性自有的 `foldCounters`（从 `@dsh-cc/context-crusher` 与
  `@dsh-cc/compaction-cost-gate` 包根导出，§3.4）并入 `counters`；
- `capability: { ok }` —— 脚本化运行干净地跑完到最终文本。

未知 mock id → 显式报错（绝不静默丢弃）。Mock 向量永不写入 baseline blob：
门禁只按 `capability.ok` + `counters.expect` 评估它们。

### 任务

- `mock/ccr-fires` —— crusher 开启，`biggrep` 输出越过 min-bytes 门限；期望 `ccr.applied >= 1`。
- `mock/ccr-control` —— crusher 开启，输出低于 min-bytes；期望 `ccr.applied = 0`。
- `mock/costgate-fires` —— `todo_write` 完成武装边界，idle 以极小 margin 通过门禁，真实压缩引擎端到端执行；期望 `costgate.gate >= 1`、`costgate.compacted >= 1`。
- `mock/costgate-control` —— 门禁武装并评估但不等式失败（大 margin）；期望 `costgate.gate >= 1`、`costgate.compacted = 0`。

> 注：committed replay fixtures currently fold ccr.* counters to zero — no genuine CCR production markers appear in the source sessions; genuine counter coverage lives in the mock tier (ccr-fires/ccr-control)
