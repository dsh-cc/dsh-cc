# moa revival: scope-aware listener registration + relaxed tier ladder

## Status: Design r3 (converged) — probe-verified root causes; three-seat blind review converged (codex GO, critic GO, grok GO; ledger §7). 

All code anchors cite tree `3bddc9ee` (main). Harness anchors cite `dsh`
0.2.0-rc.2 (global launcher install, unchanged since 2026-10-01). Runtime
evidence cites the 2026-10-25 live probes (profile `tui`, pool synced from
`2106cff0399` on 2026-10-24 21:07 CST).

## 1. Problem

Two independent defects currently leave `moa` (tiered cascade routing, PRs
#214/#225) fully inert for every fresh main conversation:

1. **Event-delivery regression (Bug B, composition defect).** The moa plugin
   registers all of its agent-plane listeners exactly once per runtime —
   on whichever preset standing mount applies it FIRST — while the main
   conversation's agent is bound to whichever preset the session actually
   resolved. When those two trees differ, no `agent/inbox/claimed`,
   `agent/request`, or `system-prompt/assemble` event ever reaches moa:
   scope-tagged dispatch flows strictly up the scope chain
   (`dsh-scope` `scopeTarget`), and a listener tagged with the sibling tree's
   key is structurally unreachable. Live-verified 2026-10-25: with the user's
   `vwa-preset.selectedDefault: "vwa"`, every fresh main session binds to the
   preset-vwa standing mount while moa's listeners live in the preset-cc
   mount (order 5 mounts first and claims the module singleton; the
   preset-vwa apply early-returns without registering anything).
2. **Degenerate-ladder arming refusal (Bug A, config semantics).**
   `validateArming` (router.ts:114; the pairwise-distinct check itself is
   tiers.ts `resolveTiers`) demands four pairwise-distinct tier models. The
   user's current aliases map both `haiku` and `sonnet` to
   `llmbox_ant/deepseek-v4.1-flash`, so arming is refused ("moa ladder is
   degenerate: \"sketch\" and \"draft\" resolve to the same model") and the
   feature fails open — with only a warn-once on a TUI-invisible stderr
   channel.

### 1.1 End-to-end proof chain (2026-10-25, pool `2106cff0399`)

- Baseline: fresh pty-driven TUI sessions complete real turns
  (turn/start → request/header → assistant/message → turn/end in
  `session.v4.jsonl.zstd`) while `~/.dsh/moa/routing.jsonl` gains no row.
  Ledger last row before the probe: 2026-10-23 16:49 CST.
- Pool-side tryArm stub (reverted after each probe; SHA-1 verified):
  `tryArm FAILED: moa ladder is degenerate …` with the stock aliases;
  `tryArm OK` once `sonnet` is set to a distinct model.
- Scope fingerprint stub (also reverted, SHA-1 verified): two applies —
  fiber chains `…/agent.cordis.yml` (cc tree, first, registers listeners)
  and `…/agent.vwa.cordis.yml` (vwa tree, second, early-returns) — and the
  main agent's scope parent equals the **vwa** standing-mount key
  (`parentIsTag0=false parentIsTag1=true`).
- Counterfactual A (`vwa-preset.selectedDefault: "cc"` alone): agent returns
  to the cc tree (`parentIsTag0=true`); still no ledger row — blocked by the
  degenerate ladder (Bug A).
- Counterfactual B (`selectedDefault: "cc"` AND `sonnet → glm-5.3-flash`):
  `routing.jsonl` gains `2026-10-25T04:38:57Z tier=sketch P=0.7999` — full
  revival. Each defect is individually necessary; both are jointly
  sufficient.

Known attribution trap, documented for future probes: a shared
`/tmp/moa-trace.log` is written by every process using the pool, including
the user's concurrently running TUI sessions; a listener-firing observation
made this session look alive until the writer's pid was checked. All stubs
now carry `process.pid`.

### 1.2 Why the existing tests missed it

- The preset composition tests (`packages/preset/cc/tests/`) boot the shared
  body in one scope, or (post-#283 `dual-preset.boot.spec.ts`) assert MCP
  registry sharing — no test dispatches an agent-scoped event through a real
  scope carrier across two standing scopes and asserts it reaches the same
  plugin instance (see §2.3 for why "two isolate realms" alone does not
  exercise the failure).
- The moa suite wires `apply` through fake ctx rigs in a single scope, so
  the "second apply early-returns" idempotency was never exercised across
  sibling scopes.
- Bug A is by-design behavior interacting with user config; the warn-once
  lands on a channel the TUI never renders.

## 2. Fix B — scope-aware listener registration (shared core, per-tree wiring)

### 2.1 Mechanism pin

`packages/interaction/moa/src/index.ts` `apply()`:

- module-level `core` singleton (settings reader / arming / bookkeeping /
  validation) plus `setRuntimeCore` module state — correct to keep global:
  both trees must observe the SAME arming truth and ledger;
- `ctx.on('agent/inbox/claimed' | 'agent/pre-step' | 'agent/request' |
  'system-prompt/assemble' | 'agent/turn-stopping', …)` registrations,
  `ctx.inject(['settings','ccModelRoutes'], tryArm)` retry, and the
  `createRequestRouter`/`createAcceptanceJudge` construction — WRONG to
  gate behind `if (core !== undefined) return`.

Harness facts (verified in `dsh-agent-preset-registry`/`dsh-scope`
0.2.0-rc.2):

- Every declared preset gets its own standing mount with a fresh scope key;
  the registry eagerly mounts each (`activate` → `createScope(key)`).
- A session agent binds its scope key to the generation's key
  (`bindScopeParent(agentKey, generation.key)`); selection is
  `recorded ?? vwa-preset.selectedDefault ?? configPreset` (tui
  `preset.ts` `resolvePresetId`) — user-controlled, so main sessions can
  live in either tree.
- Dispatch carriers are `scopeTarget(agent, agent)`; the carrier's filter
  admits a hook only when the hook ctx's scope tag is the dispatch key or
  an ancestor. Sibling-tree listeners are unreachable by construction.
  Conversely, the two tagged listeners can never both run for one event: a
  carrier would have to be a common descendant of two sibling keys, which
  cannot exist — this is also the ledger-concurrency argument (§2.2.6).

### 2.2 Change — split the idempotency boundary

1. **Shared core (once per runtime):** the `core` singleton keeps
   `arming`, `bookkeeping`, `validation`, and the arming-time ladder
   snapshot (§3.2.4) — and NOTHING ELSE. In particular the core does
   NOT hold a settings reader: cordis resolves `ctx.get('settings')`
   through `getTraceable(ctx, impl.value)`, a fresh per-caller proxy,
   and `registerNamespaceSafe` memoizes its `readers` WeakMap by that
   PROXY — so each tree already owns an independent reader closed over
   its own context (verified in cordis + `settings-ns` source across
   both delta rounds). The per-tree wiring (item 2) reads settings
   through its own tree-local reader via `deps`; `core.readSettings` is
   removed (it was the first tree's reader — the exact cross-tree
   capture the per-tree split exists to eliminate). Survivor semantics:
   a tree's reader dies only with its own tree, and both wiring paths
   re-check `enabled` per firing through their own reader; standing
   mounts are process-lifetime, so cross-tree reader death is a
   non-scenario recorded here for the record.

2. **Per-tree wiring (every apply):** each tree constructs its own
   `createRequestRouter(core, { validation, ensureArmed: <this tree's
   tryArm closure>, deps: buildDeps(<this tree's ctx>) })` and
   `createAcceptanceJudge(...)` and registers the five listeners plus the
   `ctx.inject(['settings','ccModelRoutes'], tryArm)` retry on ITS OWN ctx.
   Each tree's listeners serve that tree's agents. `core.router` /
   `core.judge` are dropped from the shared core (last-apply-wins was a
   latent bug; the runtime-state accessors used by the sanitizer are the
   shared seam, and they already live in `setRuntimeCore` state, not
   `core.router`).
3. **Arming truth is shared; route resolution is tree-local.** The
   ladder-shape validation (`validation.ok`) is configuration-global
   (both trees read the same alias table), so the first tree to validate
   sets it once. But `tryArm` closures and `deps.routes` remain per-tree:
   if the second tree's `ccModelRoutes` (an in-realm isolate service) is
   late or absent, that tree's per-firing tier resolution fails open with
   its own warn-once — never a cross-tree ctx capture. This is the
   ownership contract between the shared gate and per-tree wiring.
4. **Warn/row dedup lives on the shared core.** `warnedReasons` moves into
   `core` (or the shared validation object): two trees' tryArm closures
   must not double-warn or double-queue the unarmed row for one reason.
   A success on either tree clears unarmed rows still pending in
   `pendingRows`.
5. **Listener callbacks are per-fiber-disposed by cordis** (`ctx.on`
   disposes with the fiber), so a tree teardown cleans up naturally.
6. **Ledger concurrency is a non-issue by the scope filter** (§2.1): the
   two tagged listeners never both run one event, `appendJsonl` is a
   single `O_APPEND` write of a small line, and the existing helper tests
   already cover concurrent appends. One ledger file, one record per
   routing decision (asserted in §2.3); ordering stays best-effort.

Rationale for rejecting alternatives:

- **Registering listeners on `ctx.root`** (untagged hooks are admitted
  globally by `scopeTarget`): rejected — `tryArm`'s `ctx.inject` of
  `ccModelRoutes` would resolve nothing at root (in-realm service), arming
  would fail, and the positive assertions of §2.3 would even pass under
  this fix, which is exactly why the spec's negative case exists.
- **Hoisting moa to the bundle layer** (like `tool-search` post-#283):
  rejected — moa's rows are agent-plane by design (PR #214 composition),
  and the same fix would be needed for every future agent-plane
  interaction plugin; fixing the plugin's scope-blindness is the general
  repair.

### 2.3 Acceptance tests

The dual-scope spec must exercise the REAL scope machinery, not
`isolate()`-only realms (r1 grok/codex finding: an isolate realm never
calls `createScope`, its contexts are untagged, and cordis's hook list is
global — an untagged listener is admitted to every carrier, so the
spec-as-Mirroring-`dual-preset.boot.spec.ts` passes on current main):

- `createScope(root, keyA)` and `createScope(root, keyB)`; run `apply` on
  each scoped ctx with real deps (a minimal mount of the moa row only —
  not the full `agent.shared.cordis.yml`, whose other rows need the
  MCP-only rig).
- Bind a fake agent key: `bindScopeParent(agentKey, keyB)`; dispatch
  `agent/inbox/claimed` and `agent/request` through a production-shaped
  carrier (`scopeTarget(base, agentKey)`).
- Assert: the vwa-parented carrier runs the keyB registration and NOT
  the keyA one (capture map write, ledger row, overlay applied — the
  exact regression; fails on current main).
- Assert negative: a third carrier parented to `keyC` reaches NEITHER
  tree (this is what rules out the rejected root-registration fix).
- Assert exactly one ledger record per routing decision when both trees
  are wired.
- Retain: single-scope boot behavior unchanged (existing suite);
  `getMoaCore()` identity shared across both applies; disposal of the
  first tree followed by a settings update still routes through the
  second (each tree's proxy-keyed reader and wiring are independent by
  construction, §2.2.1 — no rebind needed).

## 3. Fix A — relaxed ladder semantics

### 3.1 Arming condition

`resolveTiers` changes from "four pairwise-distinct tier models" to
"**contiguous runs, at least two distinct models**": a model may repeat
only adjacent to itself (`[A,A,B,C]` arms); any reappearance after a
different model (`[A,B,A,C]`) still refuses — without this,
`nextDistinctTier` can hop DOWN to a cheaper model and burn a retry on a
downgrade, which is not an escalation (r1 grok finding 3). A fully
degenerate ladder (all four identical) still refuses arming. The warn
message gains the resolved ladder table so the operator sees exactly what
each tier maps to.

### 3.2 Escalation skips same-model rungs

With duplicated rungs legalized, the acceptance judge must not re-roll the
same model, and the current strict bookkeeping invariant makes skip-
escalations throw:

- **`state.ts` `recordRetryUsed` relaxes from `toTier === floor + 1` to
  `fromTier === floor && toTier > floor`** (floors still only rise;
  `retriesUsed` still increments exactly once per retry). The existing
  state.spec pin that `recordRetryUsed(seq, 0, 2)` throws is REWRITTEN to
  assert the two-rung jump is legal and backward/out-of-range transitions
  still throw. This invariant is replaced, not preserved (r1 all three
  seats, same point).
- **`judge.ts` currently hardcodes `toTier = snap.fromTier + 1`** (it does
  not call `nextTierUp`); the advance becomes
  `nextDistinctTier(snap.fromTier, ladder)` where `ladder` is the
  **arming-time snapshot** stored on the shared validation (§3.2.4) — a
  hot alias edit mid-turn must not land the retry on a model inconsistent
  with the ladder the turn was routed under.
- **`isEscalatable` folds the distinct-tier-above check** (currently any
  `fromTier < TIER_COUNT-1` passes): with `[A,B,C,C]`, `fromTier=2` would
  spend a judge call and then no-op. `nextDistinctTier` returning `none`
  makes the turn ineligible BEFORE the judge call.
- The origin-seq floor records the tier actually applied; the escalation
  status row names the target tier and, when it skips a rung, renders
  `moa: escalate → <tier>` (single-line, no parenthetical noise).

### 3.2.4 Ladder snapshot at arm time

`resolveTiers` already resolves the full ladder during `validateArming`;
the resolved `(provider, model)` table is stored on the shared validation
object. All runtime decisions (§3.2 advance, §3.3 applied-index collapse)
read that snapshot; live route re-resolution remains the per-firing
fail-open path only when the snapshot is somehow absent.

### 3.3 Classification and applied index

System One still classifies into all four tiers (the verdict remains
ledger-informative and a later alias edit re-differentiates the ladder
with zero behavior change at the classify seam). But on a duplicated-rung
ladder, the raw argmax between `sketch` and `draft` (same model) is start-
index noise: the winner changes the stored tier index, the status label,
and the gap `recordRetryUsed` sees, with no model change. The applied
index therefore **collapses to the first index of the contiguous run**
before `setTurnTier` and the ledger's `tier` field (the raw argmax label
is kept as an additional ledger field).

### 3.3.5 Escalation origin identity (pre-existing bug, fixed in this
batch)

Judge capture currently assigns `originSeq: Number(lastUser.seq)` — for a
typed escalation followup opening (which is itself a `user/message` with
its own seq), each subsequent judgment consults a FRESH bookkeeping entry,
so an uninterrupted automatic retry chain can exceed `max-escalations` for
the original request. Capture inherits `opening.source.originSeq` for
escalation openings (the retry-turn contract in `tierForTurn` already
reads it) and retains the ORIGINAL request text for judging. Tests:
repeated automatic rejections with limits 1 and 2 — one original-sequence
entry, monotonic floors, exact retry counts, no reclassification.

### 3.4 Tests

- Ladder matrix: 4 distinct / `[A,A,B,C]` / `[A,B,C,C]` (arms) /
  `[A,B,A,C]` (refused) / 1 distinct (refused) / tier unresolved
  (refused) — arming verdicts.
- Escalation: judge rejects on a duplicated-rung ladder → retry runs on
  the next distinct model, never the same model twice consecutively;
  two-rung jump legal; top-of-ladder with no distinct tier above → no
  judge call, no retry; backward transition still throws.
- Bookkeeping: floor monotonicity across skip-escalations; retry counts
  exact across automatic chains (§3.3.5).
- Applied-index collapse: same-model rung argmax flip does not change
  model, status label, or floor gap.

## 4. Visibility — unarmed must be observable

The r1 draft proposed queueing `moa: unarmed — <reason>` through
`queueMoaRow`; that seam cannot deliver the promised contract (r1 codex/
grok, same point): `queueMoaRow` is a one-shot transcript notice spliced
by the next pre-step, it cannot be retracted after delivery, and
`statusline-moa.ts` ignores tier-less moa notices by pinned test. The
revised contract:

- **The unarmed state is exposed through the existing statusline tap
  (`statusline-moa.ts`)**, extended with an explicit `unarmed` reason:
  the shared validation object carries a monotonic
  `unarmedReason` field; the tap renders it (a new payload field,
  additive like `moa:{tier}`) and clears it when an armed notice or
  arming success arrives. No new session-event type is introduced
  (poisons-reopen red line); the tap already subscribes to the session
  event stream.
- **`moa disabled` stays silent** (r1 critic finding 2): the row/tap
  renders only for the enabled-but-unarmed case (routes unavailable,
  degenerate ladder, judge-route failure) — never for the default-off
  population.
- Warn dedup and the row lifecycle live on the shared core (§2.2.4):
  per-reason, not per-firing; cleared on arming success.

Out of scope (design §10 deferred, unchanged): `/model moa` convenience,
buffer-then-stream, tool-turn upgrades.

## 5. Delivery plan

Single PR, three commits:

1. `fix(moa): register wiring per preset scope (shared core)` — Fix B +
   the real-scope dual-mount spec (§2.3, fails on current main) + the
   core.router/judge ownership cleanup.
2. `feat(moa): allow contiguous-run ladders; escalation skips same-model
   rungs` — Fix A. Touches `tiers.ts` (`nextDistinctTier`, contiguous-run
   validation), `state.ts` (invariant relaxation + spec rewrite),
   `judge.ts` (advance via snapshot, `isEscalatable` fold, originSeq
   inheritance), `router.ts` (applied-index collapse — no new lines
   beyond a call; router.ts is AT the 500-line `check:size` hard cap, so
   all new logic lives in `tiers.ts`), plus the §3.4 matrix.
3. `feat(moa): surface unarmed state in the statusline tap` — §4 + the
   statusline-moa extension and its pinned-test update.

The per-slice battery runs the full local gate set; `smoke:profile-boot`
runs once (no yml/composition edit in this PR, so it is a tripwire, not
an expected signal).

## 6. Probe evidence appendix (folded from §1.1)

Commands and artifacts (all reverted; SHA-1 receipts):

- pool `index.js`/`router.js` restored to
  `60da51e1…`/`cbae04e9…` after every stub round; `grep -c '__tr'` → 0.
- `~/.dsh/settings.json` restored from byte-identical backup after the
  counterfactual (selectedDefault back to `vwa`, `sonnet` back to
  `deepseek-v4.1-flash`).
- Revival row: `{"type":"route","ts":"2026-10-25T04:38:57.415Z","turnId":1,
  "tier":"sketch","probabilities":{"sketch":0.7999,…},"latencyMs":202}`.

## 7. Review ledger

### r1 (2026-10-25, all three seats GO-WITH-CHANGES; brief
`.scratch/moa-revival/review-brief.md`, raw verdicts
`{critic,codex,grok}-r1.md`)

Critic (10 findings) / codex (8) / grok (6, incl. 2 blockers). Folds:

1. **Skip-escalation violates `recordRetryUsed`'s `toTier === floor + 1`;
   judge catches and swallows; `judge.ts` hardcodes `+1`** — all three
   seats, same point → §3.2 rewrite (invariant replaced, judge advance
   via `nextDistinctTier`, `isEscalatable` fold, state.spec rewrite,
   commit-2 file list).
2. **Dual-scope spec as drafted passes on current main** (untagged
   listeners admitted globally; isolate realms never call `createScope`)
   — grok blocker + codex major → §2.3 rewritten around real
   `createScope`/`bindScopeParent`/`scopeTarget` carriers, negative
   third-key case, moa-row-only mount.
3. **Per-tree tryArm/warn/row double-fire into shared state** — all three
   seats → §2.2.4 (shared `warnedReasons` + row lifecycle), §4 contract
   rewrite.
4. **`moa disabled` must stay silent** (default-off population) —
   critic + grok → §4.
5. **`queueMoaRow` cannot deliver a persistent clearable status;
   statusline-moa ignores tier-less notices** — codex + grok → §4
   rewritten to the statusline-tap contract.
6. **Per-tree validation ownership** (`validation.ok` short-circuit vs
   tree-local routes readiness) — codex → §2.2.3 contract.
7. **First-tree settings reader lifetime** — critic + codex → §2.2.1
   service-keyed reader semantics verified and disposal test re-scoped to
   the provider read-through path (§2.2.1).
8. **`[A,B,A,C]` allows a downgrade hop; argmax noise between merged
   rungs** — grok → §3.1 contiguous-run rule + §3.3 index collapse.
9. **Ladder snapshot vs hot alias edit** — critic + codex → §3.2.4.
10. **`isEscalatable` wastes a judge call at a duplicated top rung** —
    critic + grok → §3.2.
11. **Escalation origin identity across automatic retry turns** (pre-
    existing) — codex → §3.3.5.
12. **Sizing/anchor precision** (router.ts AT cap; commit 2 includes
    state.ts + judge.ts; `validateArming` line anchor; ledger
    concurrency documented as a non-issue; `core.router` last-apply-wins
    dropped) — critic + codex + grok → §2.2.2, §2.2.6, §5.
13. **Namespace registration is app-level, not per-scope** (do not
    "fix" it into a per-tree owner) — grok → §2.2.1 keeps the call
    first-in-apply.

Rejected-from-fold: none — all r1 findings folded. Delta round pending.

### r2 (delta confirmation, 2026-10-25; brief `delta-brief.md`)

- codex: 13/13 folds OK — VERDICT: GO (14.4k tokens).
- critic: 10/10 folds OK, no NEW — VERDICT: GO.
- grok: 12/13 OK; fold 7 PROBLEM — "rebinding `readSettings`
  per apply cannot install a survivor reader: `registerNamespaceSafe`
  returns a reader memoized by the settings service object and closed
  over the first context". Verified against `settings-ns` source by the
  orchestrator: the claim is PARTIALLY right — the memo key is the
  service object (so both trees already share one reader and "rebind"
  is a no-op), but the reader's value path is a provider-level
  `settings.get(ns)` read-through whose lifetime is the settings service
  (tree-independent); only the scope-fallback reacquisition branch is
  first-tree-coupled. §2.2.1 was rewritten to the verified service-keyed
  semantics and the §2.3 disposal test re-scoped to the provider
  read-through path, with the standing-mounts-are-process-lifetime
  assumption recorded. Micro-confirmation round pending (grok only).

### r3 (grok micro-confirmation, 2026-10-25)

grok still flagged fold 7 — and its factual claim was verified TRUE
against cordis source: `ctx.get('settings')` resolves through
`getTraceable(ctx, impl.value)` (a fresh per-caller proxy), so the
`settings-ns` readers WeakMap is PROXY-keyed — each tree owns an
independent reader; the r2 "same service object → same memoized
reader" reasoning was wrong (same underlying service, different proxy
keys). Fold: §2.2.1 rewritten again — the shared core drops
`readSettings` entirely (it was the first tree's reader, a cross-tree
capture); per-tree wiring reads settings through tree-local `deps`;
survivor semantics hold by construction. §2.3 "reader rebind" wording
residue fixed (grok NEW). A final micro-confirmation was dispatched.

### r4 (grok final micro-confirmation, 2026-10-25)

"fold 7 + RESOLVED" — VERDICT: GO. Review convergence complete:
codex GO (r2 delta, 13/13), critic GO (r2 delta, 10/10), grok GO
(r4, after two additional mechanism-precision rounds on the
settings-reader ownership). User sign-off pending per house rules;
implementation authorized by the user's pipeline directive.
