# @dsh-cc/input-budget

English | [中文](README.zh.md)

Per-step input budget governor for the context-engineering input-governance program: one outermost gate over the final `agent/pre-step` enter batch, arbitrating producer content by class and byte budget 〔src:ws:docs/plans/2026-11-12-per-step-input-budget-governor.md#L53-L59〕. Three layers ship together: the pure core (`govern()` — a function of its arguments, so the whole algorithm is testable without a runtime), the `agent/pre-step` listener the preset's `input-budget` row mounts, and the row emission that persists one `GovernorRow` per gate invocation through `@dsh-cc/input-ledger` 〔src:ws:docs/plans/2026-11-12-per-step-input-budget-governor.md#L105-L107〕. It ships observe-first: in observe mode the batch is returned untouched and only the decisions are recorded.

## Classes — explicit membership only

Membership is closed and explicit 〔src:ws:docs/plans/2026-11-12-per-step-input-budget-governor.md#L61-L73〕. Anything unlisted — an unknown kind, a late plugin, an absent or empty `source.kind` — is `passthrough` **by construction**, so unenumerated producers are never trimmed and never deferred.

| class | kinds | policy |
|---|---|---|
| `governance` | `turn-rules`, `edit-recovery-hint`, `completion-gate`, `permission-rules`, `agent-instructions`, `hooks-claude-code`, `compact-checkpoint`, `moa-escalation` | never trim, never defer; counted |
| `task` | `user`, `progress-rebuild`, `moa`, `subagent-settled`, `cc-subagent-children`, `vwa-evidence`, `cc-workflow-completion` | never trim, never defer; counted |
| `memory` | `memory` | trim/defer FIFO under `memory-budget-bytes` |
| `advisory` | `advisor`, `retry-attendant`, `compaction-micro`, `compaction-cost-gate` | trim/defer FIFO under `advisory-budget-bytes` |
| `passthrough` | `cc-shell-glue` (v1 hard rule), `command-preset`, `side-query`, `tool-web-fetch`, `tool-registry`, named harness kinds, everything else | never trim, never defer; counted |

`cc-shell-glue` sits in `passthrough` in v1 as an **algorithmic rule**, not an annotation: `mcpReadyNotice` commits its once-per-session latch *before* returning the notice, so any enforced trim, defer or oversize drop of a glue notice would be a silent one-shot miss 〔src:ws:docs/plans/2026-11-12-per-step-input-budget-governor.md#L71-L71〕. `memory` and `advisory` are the only budgeted classes; a 12 KiB memory entry is judged against `memory-budget-bytes`, never against the advisory limit 〔src:ws:docs/plans/2026-11-12-per-step-input-budget-governor.md#L67-L67〕〔src:ws:docs/plans/2026-11-12-per-step-input-budget-governor.md#L92-L92〕.

## Budget model (per enter batch)

1. Classify each message; compute per-class UTF-8 bytes (text blocks only — the same measurement `@dsh-cc/input-ledger` records, so the two row families agree byte for byte) 〔src:ws:docs/plans/2026-11-12-per-step-input-ledger.md#L82-L82〕.
2. `governance` / `task` / `passthrough`: never modified, never charged.
3. `memory`: while memory bytes exceed `memory-budget-bytes`, trim the oldest memory message (whole message, FIFO).
4. `advisory`: while advisory bytes exceed `advisory-budget-bytes`, trim the oldest advisory message.
5. Enter budget: if the batch total exceeds `enter-budget-bytes`, trim advisory (then memory) further. If the budget cannot be met within the trimmable classes, nothing further is trimmed, protected classes are untouched, and `hardOver` records the overflow 〔src:ws:docs/plans/2026-11-12-per-step-input-budget-governor.md#L77-L83〕.

A trimmed message whose own bytes alone exceed its class budget is dropped `drop-oversize` immediately and never enqueued — defer-then-drop would record a deferral that could never succeed.

## Defer queue

Per-session backlog of `{ message, enqueuedAtSeq, lastOfferedSeq }`, all values in `gateSeq` units. `gateSeq` is a **monotonic per-session invocation counter** incremented on every gate call; `agent/pre-step`'s `step` is turn-local and is never used 〔src:ws:docs/plans/2026-11-12-per-step-input-budget-governor.md#L75-L75〕. `govern()` receives the counter and returns the next one; the listener owns it per session.

Each invocation, in order 〔src:ws:docs/plans/2026-11-12-per-step-input-budget-governor.md#L87-L95〕:

1. **Age** — entries with `gateSeq - enqueuedAtSeq > defer-ttl-steps` drop `drop-expired`.
2. **Backlog admission** — walk the backlog FIFO and admit the head while the entry's **own** class budget has room (memory entries against `memory-budget-bytes`, advisory against `advisory-budget-bytes`, with this invocation's already-admitted bytes as `used`). Admitted entries lead this step's batch.
3. **Fresh trim** — the budget model above; surviving-fresh trims append to the backlog tail.

`lastOfferedSeq` starts at `enqueuedAtSeq` and advances to the current `gateSeq` at the end of every invocation that evaluated the entry — admission, rejection and re-defer alike. TTL is bounded by invocation count, not admission count.

## Observe mode

`mode: 'observe'` runs the identical fresh-batch computation and records the same rows under `mode: 'observe'`, but returns the incoming batch untouched, keeps no defer queue, simulates no backlog and emits no `drop-expired` rows. `drop-oversize` *is* possible in observe, because it is a fresh-batch computation 〔src:ws:docs/plans/2026-11-12-per-step-input-budget-governor.md#L97-L103〕. Because an observe invocation returns an empty backlog, an `observe → enforce` flip starts with an empty queue by construction — no cross-mode carryover.

## Wiring — listener, preset row, ledger emission

`registerGovernorListener(ctx)` registers one `agent/pre-step` listener with `{ prepend: true }`, so it runs **outermost** among the preset's pre-step rewriters and sees the final decision on the way back out; it is delegate-first (it awaits `next()` and then spreads the returned decision, replacing only the message batch) and it never throws into the waterfall 〔src:ws:docs/plans/2026-11-12-per-step-input-budget-governor.md#L53-L59〕. The preset row `input-budget` in the shared preset body mounts it through `apply()`, ordered after `tool-task` so the subagent strip-instructions/settled-notice pair stays inside the gate; the composition pin and the two live-fold ordering tests keep that boundary a tested property rather than an accident 〔src:ws:docs/plans/2026-11-12-per-step-input-budget-governor.md#L57-L59〕.

Rows leave through `createGovernorLedgerSink()`: one content-free `GovernorRow` per gate invocation, appended to `$DSH_HOME/input-ledger/<projectKey>/<sessionId>.jsonl`, the same sink and path convention the ledger's own observers use (the project bucket is the first 16 hex chars of `sha256(realpath(cwd))`, replicated locally because `@dsh-cc/input-ledger` keeps it private) 〔src:ws:docs/plans/2026-11-12-per-step-input-budget-governor.md#L105-L107〕. The dependency is soft by design: with no dsh-home, no session cwd, or `cc-input-ledger.enabled: false` the governor still runs and rows are simply not persisted; an append failure is swallowed, debug-logged and counted in `getGovernorLedgerHealth().droppedRows` — never thrown into the waterfall and never awaited on the hot path 〔src:ws:docs/plans/2026-11-12-per-step-input-budget-governor.md#L122-L131〕. A governor exception returns the unmodified decision with an `{ error: true }` row, so a failing gate can never half-apply a batch 〔src:ws:docs/plans/2026-11-12-per-step-input-budget-governor.md#L122-L124〕.

## Governor pipeline

The exported pipeline seam fixes the stage order to `dedupe → caps → trim` and nothing else. `runGovernorPipeline(input, hooks?)` runs every `GovernorStageHook` of a stage over the batch the preceding stage produced, then hands the result to the trim stage, which is `govern()` itself. A hook sees the batch the listener received, namely the claimed enter batch after every inner `agent/pre-step` listener ran, and returns the batch the next stage evaluates. `GovernorStage` names the three stages and `GOVERNOR_STAGES` carries the frozen order as a runtime value. No dedupe or cap logic lives here yet, so both pre-trim stages take an empty hook list by default and the pipeline is the trim alone. A hook failure propagates to the listener, which returns the unmodified decision with `{ error: true }`, so a broken stage can never half-apply a batch.

## Arithmetic (pinned to the verified model)

`available(budget, used) = budget - used` (saturating), `fits(budget, used, bytes) = bytes <= available(...)`, `oversize(budget, bytes) = budget < bytes` — identical to `Formal.fits` / `Formal.oversize` in `specs/lean/input-admission-arithmetic/Model.lean`. Protected classes are never charged; that is the arithmetic face of "never touched".

## Row fields

`@dsh-cc/input-ledger` owns the row schema; this package supplies only `mode`, `bytesByClass`, `trimmed`, `offeredBacklog` and `hardOver` 〔src:ws:docs/plans/2026-11-12-per-step-input-budget-governor.md#L105-L107〕. `trimmed` entries are `{ kind, bytes, action }` with `action` in `defer | drop-expired | drop-oversize`.

Conventions this package pins, because the design leaves them to the implementation: `bytesByClass` always carries all five class keys, in table order, measured over the **decision** batch (so observe and enforce agree); `offeredBacklog` is the backlog present when the invocation started (always 0 in observe mode); the decision batch is the admitted backlog entries first (they are older), then the surviving fresh messages in arrival order — no other reordering; and an entry whose bytes exceed its class budget is dropped `drop-oversize` during the backlog walk too, which is reachable only when the hot-read budgets shrank after enqueue.

## Settings — `cc-input-budget`

Kebab-key, user-layer settings, re-read per gate invocation so a toggle applies on the next step without a restart 〔src:ws:docs/plans/2026-11-12-per-step-input-budget-governor.md#L109-L120〕.

| key | type | default | bounds |
|---|---|---|---|
| `enabled` | bool | `true` | — |
| `mode` | `'observe' \| 'enforce'` | `'observe'` | — (a flip to enforce resets the defer queue) |
| `enter-budget-bytes` | int | `24576` | 4096..262144 |
| `advisory-budget-bytes` | int | `8192` | 512..65536 |
| `memory-budget-bytes` | int | `16384` | 1024..131072 |
| `defer-ttl-steps` | int | `3` | 1..16 |

Defaults are carried on four surfaces that must agree: the schema `.default()`s, the `DEFAULT_INPUT_BUDGET_SETTINGS` constants, the fail-soft raw reader (absent or malformed file, out-of-bounds integers → defaults or bounds, unknown mode → `observe`) and the wiring fallback. No settings file means the defaults, which means **observe mode runs**.

## Usage

```ts
import { govern, messageBytes, createGovernorListener } from '@dsh-cc/input-budget'

// The pure core: the whole algorithm as a function of its arguments.
const result = govern({ messages, settings, backlog, gateSeq })
// result.messages  — the decision batch (the input batch untouched in observe mode)
// result.decision  — { mode, bytesByClass, trimmed, offeredBacklog, hardOver }
// result.backlog   — the defer queue to carry into the next invocation
// result.gateSeq   — the next gateSeq to carry into the next invocation

// The wiring: a preset row mounts it, a test host can mount it directly.
const release = registerGovernorListener(ctx) // prepended agent/pre-step listener
```

## Caveats

- Observe mode is the ship default and the only mode exercised in production today; enforcement budgets are meant to be set from ledger data before flipping 〔src:ws:docs/plans/2026-11-12-per-step-input-budget-governor.md#L137-L137〕.
- Deferred messages re-enter only through the governor's own return value, never through `agent.inject`, so no extra claimed batches form.
- The two ordering defenses (live-fold producer-chain tests, the late-prepended-listener boundary) and the repo-wide kind enumeration scan are pinned in `tests/live-fold.spec.ts` and `tests/kinds-enumeration.spec.ts`; the enumeration hard-fails when the pinned harness checkout is missing 〔src:ws:docs/plans/2026-11-12-per-step-input-budget-governor.md#L57-L59〕〔src:ws:docs/plans/2026-11-12-per-step-input-budget-governor.md#L73-L73〕.
- Advisory starvation under sustained overload is bounded, not eliminated; per-kind caps are the sibling doc's job.
