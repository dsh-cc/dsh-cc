# @dsh-cc/compaction-cost-gate

English | [中文](README.zh.md)

Cost-gated plan-step compaction. Completing a plan step (a `todo_write` transition to completed) arms a boundary; when the agent next goes idle, the service evaluates whether a full-prefix compaction pays for itself — projected input-token savings over the remaining plan versus the prompt-cache rewrite cost plus any unamortized rewrite debt — and only then calls `ctx.compaction.compactNow` on the root session. Passes are invisible except in the ledger.

## How it decides

- **Detection (mid-turn):** a `tools/post-execute` listener filters `todo_write`, diffs the todos snapshot against the previous one, and arms the boundary on any transition to completed. It never mutates the downstream decision.
- **Action (idle):** an `agent/status` listener (`status === 'idle'`, the compaction family's own precedent) runs for the latched root session only. Subagent todo completions and requests never arm or trigger.
- **Gate arithmetic:** `projectedSavedInput = contextTokens × shrink × requestsPerStep × pendingSteps` must strictly exceed `margin × (rewriteCost + debtTokens)`. `contextTokens` is summed over the shadow-aware surface (`session.surface.nodes` + `eventAt`) so compacted spans are not double-counted. A past compaction's rewrite cost contributes as debt until 5 subsequent provider requests. `pendingSteps === 0` never fires — plan end has no future requests to amortize over. With a resolvable price row, savings price at the cache-read rate and rewrite at the cache-write rate; without one the comparison stays in tokens (conservative).
- **Window-pressure override:** when `contextTokens ≥ window-pressure-tokens` the gate is bypassed (cooldown and the failure fuse still apply).

## Circuit breakers

Only real defect classes (`changed | summary | commit | persistence`, unexpected throws) count. The expected `busy`/`cancelled` classes are ledgered as skips. At 3 consecutive real failures the feature pauses for the session with one model-visible notice pointing at manual `/compact`. After any actual compaction the gate cools down for `cooldown-ms` (default 600 000).

## Config (settings namespace `cc-compaction-cost-gate`)

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Ships dark. |
| `mode` | `'dry-run'` | `dry-run` evaluates and ledgers both sides of the inequality, never calls `compactNow`. |
| `margin` | `1.0` | Required savings multiple over rewrite + debt. |
| `cooldown-ms` | `600000` | Cooldown after an actual compaction. |
| `window-pressure-tokens` | unset | Gate-bypass threshold; unset = no override. |
| `model-table` | unset | Optional price table (`ModelPrice[]`, same shape as `/cost`). |

Ledger: `<dshHome>/compaction-cost-gate/<projectKey>.jsonl`, append-only, fire-and-forget.

## Usage

```ts
import type { Context } from '@deepseek-ai/cordis'
import CompactionCostGate from '@dsh-cc/compaction-cost-gate'

export function apply(ctx: Context): void {
  ctx.plugin(CompactionCostGate)
}
```

The service is mounted by the cc preset (`cc-services` group, id `compaction-cost-gate`). The compaction engine is deliberately not injected: cordis strict-read means a hard `inject` would kill the service where compaction is absent. It is read through a guarded accessor; when absent the package inactivates with one log line and one `compaction-unavailable` ledger row.
