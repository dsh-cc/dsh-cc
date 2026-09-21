# Cost-Gated Plan-Step Compaction: compact at todo boundaries only when the cache math wins

Date: 2026-09-20. Status: design — two critic rounds; second round passed with amendments
(8 findings: compactNow re-architected to the idle seam, optional-service guard pinned,
shadow-aware surface accessor named, main-agent scoping added, breaker classes narrowed;
all baked in below). This document doubles as the executor work order (§7).

Origin: SoL-Pi (arXiv:2609.20519) Online Context Compact. Two imported ideas: (1) trigger
compaction at **plan-step completion boundaries** — the moment the session has a natural
summary seam — instead of only at window pressure; (2) a **cost gate** that compares
projected input-token savings against the prompt-cache rewrite price, carrying unrecovered
rewrite cost forward so repeated compactions need ever-larger margins.

## 1. Problem

dsh-cc today has two compaction paths and neither reasons about economics:

- the upstream basic engine (wrapped by `compaction-basic-cc`) triggers at context-token
  pressure — a *reactive* trigger that always pays a full-prefix cache rewrite precisely
  when the bill is largest;
- `compaction-micro` folds stale tool results on `agent/pre-step` by **result count**
  (`compaction-micro/src/index.ts:135-167`), model-free and cheap, but it never compacts a
  long *conversation* prefix.

Between them sits an unclaimed slot: at a plan-step boundary the agent is about to start a
fresh unit of work, context is at a local maximum of staleness (the just-finished step's
detail is least likely to be re-read), and a compaction here amortizes the cache rewrite
over the entire remaining plan. The missing piece is knowing when the math is worth it —
compacting at every boundary would bleed cache writes.

## 2. Ground facts (verified 2026-09-20 against this checkout and the read-only harness
checkout; anchors re-verified in review)

- **Trigger detection seam:** `tools/post-execute` listeners receive the full parsed tool
  input (`exec.arguments` carries the todos array; `tool-types.ts:120-131`), and the
  runtime tool name is `todo_write` (harness name; `cc-names.ts`). Detection is cheap and
  mid-turn — but see §3.4 for why detection and action are different seams.
- **`compactNow` is idle-only — the blocking review finding.** Harness contract
  (`deepseek-harness/packages/compaction/compaction/src/index.ts:66-140`, read-only):
  `compactNow(agent, signal, sourceCommandId)` requires `ManualCompactAgentContext`, whose
  `runMaintenance` "throws synchronously when the agent is already active." A
  post-execute listener fires mid-turn, so calling it there is a guaranteed
  `ManualCompactionError('busy')`. `busy` and `cancelled` are *expected* failure classes
  (consumed at `command-compact/src/index.ts:29-46`), alongside `changed | summary |
  commit | persistence`.
- **The idle seam exists and is the compaction family's own precedent:** harness emits
  `agent/status` on every transition (`agent-loop/src/agent.ts:124`), and the upstream
  basic compaction package itself listens on it for its idle maintenance
  (`deepseek-harness/packages/compaction/compaction-basic/src/index.ts:168`). Scoped
  listener form: `ctx.on('agent/status', ({ agent, status }) => …)`; dsh-cc-side emission
  precedent in `hooks-claude-code/tests/events.spec.ts:355`.
- **Compaction invocation precedent:** `ctx.compaction.compactNow(...)` at
  `command-compact/src/index.ts:70`; `setCompactHint(agent, hint)` /
  `takeCompactHint` (`compaction-basic-cc/src/hint.ts:18,23`) — consumed inside
  `summarize()` and cleared in `finally` by the manual command path; our hint ordering is
  pinned in §3.4.
- **cordis strict-read (0.1.5):** reading an uninjected context property **throws**;
  optional resources must be read behind try/catch without injecting them — in-repo
  precedent `dshHomeFn` reading `ctx.dshHomePath` this way
  (`compaction-micro/src/index.ts:84-90`; `cache-health/src/index.ts:61-67`). §3.1 applies
  this to the compaction service.
- **Shadow-aware surface accessor (named, per review):** `session.surface.nodes` +
  `session.eventAt(seq)` — the microcompact `snapshotCandidates` precedent
  (`compaction-micro/src/index.ts:345` region). Surface nodes exclude events shadowed by
  prior compactions/microcompact folds; summing `tokenMeter.estimateMessage` over
  message-carrying surface nodes is the correct "current context" number (raw
  `snapshotEvents()` would double-count shadowed spans and systematically over-trigger).
- **tokenMeter pricing convention:** `ctx.tokenMeter.estimateMessage(message)` (CCR
  `index.ts:209-214`; microcompact `:282`). Money layer: `resolvePrice(table, provider,
  model)` three-tier (`command-cost/src/cost.ts:108-131`); deployment table is
  Config-injected (`command-cost/src/index.ts:20`).
- **Failure-breaking precedent:** microcompact's consecutive-failure cap pauses the
  feature with one notice (PR #81, `_injectPauseNotice` at `compaction-micro/src/index.ts:206`).
- **agent/status carries subagents too** — `agent/session-start`/`agent/status` fire for
  every agent in the tree; see §3.4 scoping.
- Line numbers drift; implementation must re-verify anchors.

## 3. Design

### 3.1 Package `packages/compaction/compaction-cost-gate` (`@dsh-cc/compaction-cost-gate`)

One Service, `static inject = ['tokenMeter']` (present in the preset; verified precedent).
The compaction service is **not injected** — cordis strict-read means an absent
`compaction` would kill the service at mount if injected. Instead:

```ts
function optionalCompaction(ctx: Context): CompactionEngine | undefined {
  try { return ctx.compaction } catch { return undefined }   // dshHomeFn precedent
}
```

When absent, the package inactivates with one logger line and one ledger row
(`reason:'compaction-unavailable'`) — the note lives in code that always runs, not inside
the never-started dependency.

### 3.2 State, per root session (in-memory; nothing durable)

```ts
type SessionStats = {
  boundaryArmed: boolean;              // a todo completed since the last idle evaluation
  streamRequestCount: number;          // main-loop requests, this session only
  completedSteps: number;
  lastTodoSnapshot: ReadonlyMap<string, string>;   // content hash -> status
  rewriteDebt: { tokens: number; requestsSince: number }[];
  cooldownUntil: number;
  consecutiveFailures: number;         // §3.5 classes only
  lastShrink?: number;                 // measured context reduction of the last compact
  lastProvider?: string; lastModel?: string;
}
```

Keyed by the **root session id**, latched on the first main-loop `llm/stream` observation
(§3.4 scoping). Nothing is written to disk except the ledger; after a resume the estimator
starts cold and under-triggers — the safe direction.

### 3.3 Gate arithmetic (evaluated fresh at the idle seam, §3.4)

1. `contextTokens` = Σ `tokenMeter.estimateMessage` over message-carrying **surface nodes**
   (`session.surface.nodes` / `eventAt`, the shadow-aware accessor per §2). Unit test with
   a compacted session pins that shadowed spans are not double-counted.
2. `requestsPerStep` = `streamRequestCount / max(completedSteps, 1)`, floored at 1.
3. `pendingSteps` = non-completed todos in the latest snapshot. **`pendingSteps === 0`
   never compacts**: plan end is a natural session tail with no future requests to
   amortize over — stated, not discovered.
4. `shrink` = measured reduction of the last compaction in this session
   (`contextTokens` before vs after, recorded at the next idle evaluation); cold prior 0.5.
5. `projectedSavedInput` = `contextTokens × shrink × requestsPerStep × pendingSteps`.
6. `rewriteCost` = `contextTokens` (the rewritten prefix).
7. Debt: a past compact's `rewriteCost` contributes until it has seen
   `DEBT_AMORTIZE_REQUESTS` (5) subsequent provider requests. Pass ⇔
   `projectedSavedInput > margin × (rewriteCost + debtTokens)`, margin default `1.0`.
8. Pricing layer (optional): with a `modelTable` row resolved for the last observed
   provider/model (`resolvePrice`), savings price at cache-read rate, rewrite at
   cache-write rate; otherwise the comparison stays in tokens (conservative: cache writes
   price above reads).

**Window-pressure override:** `contextTokens ≥ window-pressure-tokens` bypasses the gate
(cooldown and fuse still apply).

### 3.4 Detection vs. action — the two-seam split (review finding 1)

- **Detection (mid-turn):** the `tools/post-execute` listener (no prepend; never mutates
  the decision) filters `todo_write`, diffs the todos snapshot against
  `lastTodoSnapshot`, and on any transition to completed sets `boundaryArmed = true` and
  refreshes `pendingSteps`/`completedSteps`. That is ALL this listener does.
- **Action (idle):** an `agent/status` listener (compaction-basic's own precedent, §2)
  fires on `status === 'idle'` for the **latched root session only** (subagent agents are
  ignored; their todo completions and stream requests never arm or trigger — their
  contexts are their own problem and their short horizons rarely justify a rewrite).
  On idle with `boundaryArmed`: run the §3.3 gate fresh (surface may have changed since
  the boundary), then:
  - pass → `setCompactHint(agent, 'plan-step-complete:<just-completed-todo-title>')`
    **immediately before** the call (the hint must survive only the instant between
    set and consume; it is cleared on any failure path, per the hint module's `finally`
    convention) → `compactNow(agent, freshSignal, 'compaction-cost-gate')` with a new
    `AbortController` (the turn-scoped `exec.signal` is dead by idle and must never be
    reused);
  - record debt/cooldown/lastShrink bookkeeping; disarm `boundaryArmed`.

At the idle seam `runMaintenance` cannot throw busy for a well-ordered call — and the
cache rewrite economically belongs here anyway: the next request (start of the next
turn) is what pays it.

### 3.5 Circuit breakers (PR #81 pattern, narrowed per review)

- `consecutiveFailures` increments only on `ManualCompactionError` classes
  `changed | summary | commit | persistence` and on unexpected throws — real defects.
  `busy`/`cancelled` are expected classes (an already-running compaction, user
  interruption): they reset nothing, count toward nothing, and are ledgered as
  `skipped:<class>`.
- At 3 consecutive real failures the feature pauses for the session with one durable
  notice pointing at manual `/compact`; a success resets the counter.
- Cooldown after any actual compaction: `cooldown-ms` default 600 000.

### 3.6 Config — namespace `cc-compaction-cost-gate` (settings-ns safe helpers only)

| key | default | note |
|---|---|---|
| `enabled` | `false` | ship dark |
| `mode` | `'dry-run'` | `'dry-run' \| 'on'` — dry-run evaluates and ledgers both sides of the inequality, never calls compactNow |
| `margin` | `1.0` | §3.3.7 |
| `cooldown-ms` | `600_000` | §3.5 |
| `window-pressure-tokens` | unset | bypass threshold; unset = no override |
| `model-table` | unset | optional Config-side `ModelPrice[]` (type reused from `@dsh-cc/command-cost`) |

Registration strictly through `registerNamespaceSafe`/`installSectionSafe` (PR #82
collision rules — mounted inside the cc preset beside ten other settings users). Ledger:
`<dshHome>/compaction-cost-gate/<projectKey>.jsonl`, append-only, error-swallowing,
fire-and-forget (CCR ledger precedent).

### 3.7 Capability manifest impact

New entry `engine.compaction-cost-gate`, anchored to the preset row `id:
compaction-cost-gate` in `packages/preset/cc/agent.cordis.yml` (I4 rule) with evidence
pointing at §7.5's composition spec + unit specs; I3/I7 observed (placement sorted within
its category; ux/behavioral levels consistent). Run `pnpm docs:parity` and commit all
three generated artifacts in the same commit.

## 4. Why not extend compaction-micro

Microcompact is deliberately model-free surface hygiene; this feature invokes the full
summarizing engine, needs pricing, and has its own circuit fuse. Bolting it on would break
microcompact's "no model, no money" invariant. Separate package, shared patterns.

## 5. Dogfood gates before flipping defaults

Ledger rows make the gate's economics observable without flipping behavior: gate fire
rate, pass rate, median `contextTokens` at fires vs today's pressure-only compactions,
measured `shrink` vs the 0.5 prior, and the cache signature (read ↓, write ↑) visible via
cache-health. Promotion criterion: dry-run ledger over ≥20 real sessions shows
gate-passed idle evaluations with priced margin ≥ 1.2 in the median.

## 6. Verification

- **Unit (repo root, `node_modules/.bin/vitest run packages/compaction/compaction-cost-gate`
  — package-cwd vitest is a false green):** transition diffing (add/remove/reorder,
  content-hash identity); gate arithmetic table incl. debt amortization at exactly 5
  requests, strict `>` margin edge, token-vs-priced fallback; `pendingSteps === 0` never
  fires; shadow-aware surface summation against a compacted session (the §2 accessor, no
  double-count); breaker class matrix (busy/cancelled never count; changed|summary|commit|
  persistence do); cooldown; absent-compaction inactivation via the guarded accessor;
  boundary-arm/disarm lifecycle; subagent sessions never arm the root gate.
- **Composition:** real preset + ReplayAdapter stream; scripted: todo completion mid-turn
  arms; turn ends (status idle) → gate passes → `compactNow` called once on the root
  agent with hint set and fresh signal; immediate second completion blocked by cooldown;
  `mode: 'dry-run'` never calls. Failure-path spec: hint cleared on a throwing fake
  compaction service.
- **Observable behavior claim for the commit message:** with `cc-compaction-cost-gate`
  enabled, completing a todo leaves a durable ledger line at each boundary and fires
  `compactNow` at the turn's idle boundary only when the projected savings beat the
  rewrite cost plus unamortized debt — and passes are invisible except in the ledger.
- **Static gates:** `node_modules/.bin/tsc -b tsconfig.packages.json --force` (incremental
  lies), `node scripts/check-spec-deps.mjs`, file-size budget, `pnpm docs:parity` +
  `check:capabilities`, README trio (`node scripts/check-readme.mjs --write` after
  drafting), and `pnpm smoke:profile-boot` after the preset-row edit (escalated in the
  worktree: pty) — the yml schema drift gate.

## 7. Execution decomposition (work order)

One executor, TDD, each step green on the package suite before the next:

- **E1.** Package skeleton: `package.json` (`@dsh-cc/compaction-cost-gate`;
  `exports`/`peerDependencies`/`devDependencies` link-closure per
  `packages/compaction/compaction-micro/package.json` — copy its shape, inflate nothing),
  tsconfig, registration in **`tsconfig.packages.json` references only** (pnpm-workspace
  globs `packages/*/*` — do NOT edit it), README trio stubs, preset row `-
  id: compaction-cost-gate` in the cc-services group of
  `packages/preset/cc/agent.cordis.yml`, invariant companion file per sibling packages.
  Run `pnpm smoke:profile-boot` immediately after the preset edit (escalated) — a
  malformed row fails boot, not vitest.
- **E2.** `src/state.ts` + `src/todo-diff.ts`: `SessionStats` and the pure snapshot
  differ. Tests first (§6 unit list).
- **E3.** `src/gate.ts`: pure gate (§3.3), incl. debt amortization and priced fallback.
  Table-driven tests.
- **E4.** `src/index.ts`: Service — post-execute arming listener (todo_write filter, no
  prepend, decision untouched), `agent/status` idle action listener with root-session
  latch (§3.4), guarded compaction accessor (§3.1), breakers/cooldown/dry-run/ledger
  (§3.5/§3.6), hint-then-call ordering with `setCompactHint` and fresh AbortController.
- **E5.** Settings: namespace via settings-ns safe helpers; idempotence spec
  (duplicate-mount under /clear per PR #82 shape).
- **E6.** Manifest entry (§3.7) + `pnpm docs:parity` + generated artifacts.
- **E7.** Composition specs (§6), then orchestrator runs: package suite, repo-root full
  suite, `--force` tsc, readme re-record, parity/capability checks, boot smoke.

Hard constraints: English comments/docs; TSDoc on public API; ≤500 lines per source file
(extract modules, never ratchet the baseline); no new runtime dependencies (zod from
existing graph; types from `@dsh-cc/command-cost`, helpers from `@dsh-cc/settings-ns` —
declare in devDependencies/peer per the link-closure rule and verify with
check-spec-deps); lockfile untouched; **never run git — orchestrator commits**.

## 8. Review outcomes and residual risks

Critic cold reviews (2026-09-20): round 1 failed to report (transport); round 2
GO-WITH-AMENDMENTS, 8 findings; blocking/major baked in above:

1. [blocking→fixed §3.4] `compactNow` is idle-only (harness contract verified read-only);
   detection and action split across the todo post-execute seam and the `agent/status`
   idle seam — also the economically correct placement (the next turn pays the rewrite).
2. [major→fixed §3.1] Hard `inject` would have killed the service silently when
   compaction is absent — replaced by the guarded `ctx.compaction` accessor (dshHomeFn
   precedent), with the inactivation note in always-running code.
3. [major→fixed §3.3.1/§2] "Current context" now names the shadow-aware surface accessor
   (`session.surface.nodes` + `eventAt`), with a compacted-session unit test; raw-event
   summation would have systematically over-triggered.
4. [major→fixed §3.4] Main-agent scoping: root session latched, subagent agents ignored
   for arming, counting, and action.
5. [major→fixed §3.5] Breaker counts only real defect classes; expected `busy`/`cancelled`
   excluded.
6-8. [minor→fixed §3.3/§3.4/§7/§3.7] `pendingSteps === 0` stated; `lastShrink`
   measurement path defined; fresh signal + `sourceCommandId` + hint-ordering pinned;
   E1 registration points corrected (tsconfig references, not pnpm-workspace; boot smoke
   added); manifest anchor id and evidence named.

Residual risk handed to the executor: the exact `PostToolDecision` pass-through type for
an observe-only post-execute listener must match the harness signature (return the
downstream decision unchanged after `await next()`); pin it in E4's first spec before
writing the listener body. Residual risk handed to dogfood: `shrink`'s cold prior of 0.5
is uncalibrated until §5's ledger study publishes measured values.
