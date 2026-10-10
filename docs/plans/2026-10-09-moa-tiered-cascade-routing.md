# moa — Tiered Cascade Routing for the Main Conversation

Status: Implemented — live probes passed (P0–P6b, pre-registered gates); three-lane blind review converged (r1–r7, final verdicts critic GO / codex GO / grok GO, ledger in §11); user sign-off on the design received. Implementation shipped in PR #225 (default OFF, ships dark); calibration loop pending (§7).

**Terminology**: this is *tiered cascade routing* (FrugalGPT/RouteLLM family: classify → cheapest sufficient tier → escalate on rejection), not Mixture-of-Agents (parallel fan-out + aggregation). `moa` is only the internal feature name.

## 1. Goal and v1 scope

When armed, each user message in the **main conversation** is classified by a System One decision call into one of four capability tiers — the existing lane aliases `sketch` / `draft` / `blueprint` / `masterplan` (peer chain haiku/sonnet/opus/fable, `cc-model-aliases/src/resolver.ts:55-64`) — and the turn runs on that tier. If the (optional, default-OFF) acceptance judge rejects the answer, the turn is retried once on the next higher tier.

v1 scope cuts (review-driven, see §11 ledger):
- **Escalation only for effect-free turns** (zero tool calls executed in the turn). Tool-using turns never auto-replay in v1 (tool side effects cannot be withdrawn).
- **Append-second-answer** presentation. Surface-replace withdrawal (probe-verified engine path) is rejected for v1 (§3.5 decision record).
- **Acceptance judge default OFF** with a shadow-mode calibration loop; routing-only is a legitimate first PR.
- N=1 escalation per user message (default; configurable ceiling 3).

Non-goals: subagent model routing (frontmatter owns that), `/model moa` convenience (later), buffer-then-stream, multi-escalation chains by default.

## 2. Probe evidence (all live, pre-registered gates)

| Probe | Result | Key numbers |
|---|---|---|
| P1 `agent/request` override seam | PASS | override lands on every step of a 2-step tool-call turn; independently observed at `llm/stream` |
| P2 System One wire reuse | PASS | non-approval question shapes (4-way choice + binary choice, single request) work on `systemoneDecide`/bjev |
| P3a re-entrancy hard gate | PASS | one-shot classify inside the waterfall never re-enters `agent/request` (firings == step count) |
| P3b degradation | PASS | adapter failures surface as terminal `finish{kind:'error'}` chunks, NOT exceptions — judge wrapper must detect error-finish/empty text (runSideQuery precedent), then fail-open to the unmodified route |
| P4 routing mini-corpus | PASS vs pre-registered gate | bjev: 16/16 exact on both of 2 runs, 0 flips, p50 195ms / max 516ms; trivial baselines 0.25 / 0.3125 |
| P5 acceptance mini-corpus | PASS vs gate, with a load-bearing miss | FP 0/6; **FN 1/6 — buggy dedup loop accepted at P(acceptable)=0.846**, far above any ~0.5 τ: that miss class is not threshold-tunable |
| P6b withdraw+re-answer engine path | PASS (engine level) | surface-replace of tail `assistant/message` via `user/message` carrier works; re-run turn sees rewritten history; `agent/request` re-fires |

Probe artifacts were session-local one-offs (a vitest spec driven against the real agent loop + mock adapter, and a System One corpus script over `systemoneDecide`); their numbers are frozen in this section. The spec is to be re-created as the positive tests of §8 when `@dsh-cc/moa` is implemented; the System One script is not retained.

Honest limits: P4/P5 corpora are hand-picked and cleanly stratified — they prove the classifiers are not random, not deployment reliability. P5 n=6 carries almost no statistical information (95% CI upper bound ~46% for FP). Short follow-ups ("继续") are entirely uncovered.

## 3. Design

### 3.1 Entry and arming (truth table)

Settings namespace `moa` (new package `@dsh-cc/moa`, interaction realm):

| state | behavior |
|---|---|
| `moa.enabled` absent/false (default) | no listeners, zero overhead |
| enabled + no explicit `/model` this session | overlay armed on the **main agent only** |
| enabled + `/model <catalog pair>` this session | **disarmed for the rest of the session** (escape hatch; matches in-memory `applyModelSwitch` semantics, `driver-pickers.ts:98-119`) |
| `/model` back to the boot default | re-arms (the user explicitly returned to "no opinion") |
| subagent spawn / fork / workflow children | **never** overlaid (frontmatter `model:` owns them) |
| any classify/judge failure | fail-open to the live selection |

A visible indicator is part of v1: a status row on every classify (`moa: routed → draft`) and escalate (`moa: sketch → draft`), so the tax and the routing decision are never silent.

`/model moa` stays rejected in v1 — moa is a policy, not a model; catalog validation (`model-catalog.ts:38-59`) is untouched. A later convenience PR may alias that input to "set `moa.enabled` + clear session disarm".

### 3.2 Routing classification

- Seam: `agent/request` waterfall listener, registered agent-scoped (main agent only), alongside the existing overlay precedents (`cc-model-aliases/src/service.ts:106-109`, resume-pins).
- Timing: classify once per user turn, at the turn's **first** `agent/request` — identified by a turn-id change (`payload.turn` not yet seen), NOT by `payload.step === 0`: the first dispatched request of a turn carries `step: 1` (harness `agent.ts` stores phase `step: 0` at turn open, then dispatches `phase.step + 1` — grok r4, source-verified; a step===0 gate would never fire and routing would silently never run); all later steps of the turn reuse the tier (P1 verified per-step override).
- **Input capture (pinned, grok r5, source-verified)**: at `agent/request` time the current turn's user messages are NOT yet in session history — `prepareRequest` (harness `agent.ts:408`, which emits `agent/request` at `:577`) runs BEFORE the accepted `user/message` batch is appended (`:419-421`), and neither waterfall sees them in history. A capture-only `agent/pre-step` listener (payload carries `messages: claimed` + turn/step, `agent.ts:277`) records, on the turn's **first** pre-step, `turn-id →` the **last element of `payload.messages`** (grok r6: `inbox.claim` (`inbox.ts:109-111`) appends the single next-turn message after every pending next-step message, so a queued leading notice — e.g. an `agent/created` inject — may precede it in the batch; the opening message is the batch's LAST element, not its first) — synchronous, no LLM call. The `agent/request` listener reads THAT capture, never session history, to (a) decide classify-vs-`tierFloor` and (b) build the classify state. Reading session history there would classify the previous turn's text — or nothing on the first turn.
- Classification **state contract** (pinned, per review): the last *genuine* user message (`source.kind === 'user'`) only — **as captured by the pre-step listener above**; hard token budget (default 4000 tokens, head 2/3 + tail 1/3 crop — probe-window precedent); on budget exhaustion or `input_tokens >= window` truncation sentinel → fail-open to live selection. laya (1024-token window) is unusable here; judge route defaults to bjev (16k).
- Escalation retries **never re-classify**: tier floor = last tier + 1, keyed by the origin user message's seq (§4), not by any synthetic retry event.
- Effort re-validation: when the overlay changes the model, a carried `/effort` selection is re-validated against the new model's advertised efforts, degrading exactly like `applyModelSwitch` (bare pair + notice).
- Failure handling: judge wrapper treats `finish{kind:'error'}` and empty text as failure (P3b fact), never relies on try/catch; all failures fail-open.

### 3.3 Acceptance judge (default OFF)

- Trigger: turn end (`agent/turn-stopping` window), only when (a) `moa.acceptance.enabled === true`, (b) the turn was effect-free (§3.4 gate), (c) escalation is still possible (below ceiling, retries left). If escalation is impossible the judge call is skipped entirely — a verdict with no user-visible outcome is wasted spend.
- Question: binary choice `acceptable`/`unacceptable`, moa-local criteria. Gate on `P(acceptable) < τ` (**never** on System One `confidence` — entropy-normalized, not threshold-safe; gauge precedent). Initial τ high (default 0.7): the watched metric during calibration is FN on known-defective answers; miss classes that sit above τ (like P5 f6 at 0.846) are declared **out of scope**, not threshold-chased.
- Judge input: the **originating genuine user request together with** the final answer text (answer text alone cannot establish whether the request was satisfied — codex r2), plus a digest of the turn's tool receipts when present (coding-turn corpus shape), budget-capped with the same crop rule.
- **Shadow mode**: when `moa.acceptance.enabled` is false but `moa.acceptance.shadow` is true, the judge runs and logs its verdict without acting. Shadow eligibility is **any** turn end (tool-using turns included — calibration needs the real distribution, codex r2), but every shadow record carries an `eligible` flag (would-this-turn-have-been-escalatable per §3.4), so the enablement gate's FP/FN statistics are computed on the eligible population, not the whole one (critic r2).
- Enablement gate for flipping the default (written down now, per review): ≥50 real dogfood cases; FP ≤ 5% **on the clear-acceptable subset** (the denominator is answers confirmed acceptable, codex r2); **and** a measured usefulness floor — FN catch rate ≥ 50% on the known-defective subset (a judge that rarely catches defects must not be enabled by FP alone); criteria frozen corpus-style (gauge 48-row precedent) before `acceptance.enabled` may default to true.

### 3.4 Escalation

- **Eligibility gate**: the turn executed **zero tool calls** (checked from the turn's session events). Tool-using turns are never auto-replayed in v1 — withdrawing text cannot undo edits/commands, and replaying would re-execute them. (P6b is a text-only proof; this constraint is what makes escalation honest.) The gate applies to **every candidate turn including retry turns**: a higher-tier retry that itself used tools cannot escalate further (doubly guarded by `retriesUsed`/`maxEscalations`, but the gate is the semantic rule — critic r2).
- **Retry mechanism**: the judge does NOT block the turn-stopping waterfall — capture the verdict inputs at `agent/turn-stopping`, run the judge **detached** (advisor-watchdog dual-half precedent for capture-now/act-later), and on reject wake the retry with `agent.followup` carrying the typed `moa-escalation` message. **Why followup, not inject** (grok r3, cross-confirmed by the harness seams inventory): the detached judge returns after the loop has settled idle, and `inject` only queues — it never wakes a settled idle loop (tool-workflow registry.ts idle vein) — so an inject-only retry would park until the next user message and escalation would silently never run. `followup` is safe here precisely because the message carries typed provenance (`source.kind === 'moa-escalation' ≠ 'user'`): it neither passes the genuine-user classify gate nor touches origin-seq bookkeeping. The message lands as a durable `user/message` with a **frozen typed provenance**: `MessageSourceMap` kind `moa-escalation` with payload fields `originSeq` / `fromTier` / `toTier`, a fixed text template, TUI visibility decided via `form: 'notice'` + `summary` (not rendered as human input), and a `deriveMessages` fixture proving the higher tier sees a continuation, not an ambiguous user utterance. **Never** a followup of the raw same user text with `source.kind === 'user'` — a fresh *genuine* `user/message` would reset bookkeeping and re-trigger classification (review-caught loop).
- **Retry-turn routing contract (pinned, grok r2; step gate retargeted r4; input capture r5)**: a retry turn (opened by the typed followup) issues its first `agent/request` like any turn (carrying `step: 1` — see §3.2). The listener's rule reads the **pre-step capture** (§3.2 — the followup is the **last element** of the turn's claimed batch, so its `moa-escalation` provenance is visible there): if the captured opening message carries `moa-escalation` provenance, **skip the System One classify entirely** and apply the live origin-seq `tierFloor`; otherwise (genuine user turn) classify on the turn's first request. A re-classify of the retry text would route the retry back to the cheap tier and make escalation a no-op.
- **Cap**: `moa.maxEscalations` default **1** (ceiling 3, hard ceiling `masterplan`). With the default, a sketch-routed message can reach at most draft — that is the deliberate dogfood blast radius, and it is documented rather than hidden.
- **Guards**: per-origin-seq state `{ tierFloor, retriesUsed }` (monotonic, never reset by synthetic events); one in-flight escalation per agent (atomic reservation at judge-dispatch time); **stale-result guard** — if a genuine user message (`source.kind === 'user'` — NOT the escalation's own typed followup, which must never discard its own verdict; critic r4), a `/model` change, or a session fork happened since the judge call started, the verdict is discarded.

### 3.5 Presentation — decision record (three forms weighed)

| form | verdict | reason |
|---|---|---|
| **Append second answer + status row** | **v1** | zero new mechanism; TUI appends natively; the retry is a single typed-provenance followup (§3.4), never an untyped duplicate user turn; rejected content stays visible (honest for an opt-in dogfood flag) |
| Surface-replace withdrawal (path C) | rejected for v1, engine-proven for later | `assistant/message` can never carry replace (surface.ts type+runtime ban) → carrier must be `user/message` = fake user turn on the wire; TUI replace folds only `user/message` and full-frame redraw makes scrolled text jump; retry context `go`+"withdrawn"+`go` can steer the higher tier off-task |
| Buffer-then-stream | rejected | holding `assistant/message` out of the log until judged fights the agent loop and kills streaming on the common no-escalate path |

Escalation presentation v1: status row (`moa: sketch → draft, first answer rejected by judge`), then the higher-tier answer streams normally. The first answer is kept.

### 3.6 Reuse boundary

Extract `systemone-client` + token-budget helpers from `permission-rules` into a small shared package (new `packages/llm-tuning/systemone/`), consumed by both permission-rules and `@dsh-cc/moa`. moa must not import permission-rules internals (its public exports are `.`/`./invariant`/`./types`). Question/gate/criteria stay moa-local; gauge's allow/ask/deny τ semantics are not reused. Budgets and breaker instances are moa-private, so cascade traffic can never consume approval-lane capacity (429 qpm is a shared upstream budget — pacing/backoff per the client).

Judge route resolution: `moa.judgeRoute` alias entry, **defaulting to an explicit object-form bjev route** (`{provider, model, protocol: 'systemone'}`); the armed `gauge` alias route is accepted as fallback **only if its resolved context window ≥ `classifyBudgetTokens`** (a 1024-window laya route against a 4000-token classify budget fail-opens every turn while still charging the TTFT tax — grok r2). If no route passes the window check, the feature stays unarmed with a warn-once.

### 3.7 Configuration

- `moa.*` keys: `enabled` (false), `acceptance.enabled` (false), `acceptance.shadow` (false), `acceptance.tau` (0.7), `maxEscalations` (1), `judgeRoute` (optional), `classifyBudgetTokens` (4000), `callBudgetMs` (8000, per-message cascade deadline, §5). New namespace — registered per the settings-landscape convention.
- Tier mapping lives in the existing `model-aliases` namespace (`sketch/draft/blueprint/masterplan`); unconfigured lanes follow the peer chain (= zero savings, existing `warnOnInherit` once-per-alias warn).
- **Arming-time validation**: resolve all four tiers; require four distinct resolved models; warn (and refuse to arm) if the ladder is degenerate (e.g. two tiers resolve to the same model) — aliases alone guarantee neither capability nor cost ordering.

## 4. Bookkeeping and lifecycle

Escalation state is an in-memory per-session map keyed by origin user-message seq. It survives compaction (origin seq is stable in the log; compaction replaces ranges, seqs are not renumbered). On session resume the map starts empty — conservative consequence: a resumed session may grant one extra escalation per message; accepted and documented rather than building event-sourced reconstruction in v1.

## 5. Cost accounting (honest version)

Per genuine user message, armed with acceptance ON, worst case: 1 classify (p50 195ms, **before first token** — a user-visible TTFT tax unlike gauge's in-flight approval calls) + up to `1 + maxEscalations` full generations (each possibly multi-step) + up to `maxEscalations` judge calls (each eligible rejection triggers another escalation, so N retries imply N judge calls — codex r2). Tool-using turns cost 1 classify only (no escalation path). The status rows make every classify/escalate visible. A per-message hard guard: `moa.callBudgetMs` (default 8000) is a **deadline enforced during calls** (an AbortSignal deadline composed into every classify/judge call of the cascade), not a post-hoc spend check — on expiry the rest of the cascade for that message fail-opens.

## 6. Priority and invalidation

Precedence (high→low): explicit `/model` this session > moa overlay > boot default. A `/model` change, a new genuine (`source.kind === 'user'`) user message, or a session fork **invalidates any in-flight classify/judge result** (stale-result guard, §3.4). Subagents, one-shot side-queries, and hook forks are never overlaid. A pinned test asserts: explicit `/model` → zero `agent/request` override from moa.

## 7. Dogfood and calibration plan

- Routing decisions logged (moa-namespaced session event per classify: originSeq, tier, probabilities, latencyMs, truncated flag) — the real-distribution corpus builder (R1).
- Acceptance shadow mode collects `P(acceptable)` on real turns without acting (R2).
- Short-followup behavior ("继续", "好的") is an explicit calibration target; v1 routes them like everything else and logs, criteria iteration decides whether they pin to the previous tier.
- Flip-stability: dogfood re-runs a sample of logged prompts to measure flip rate on real distribution (P4's 0/32 is clean-sample only).

## 8. Test plan

- Promote the probe spec into `@dsh-cc/moa` positive tests: P1 (multi-step override), P3a (no re-entry), P3b (error-finish degradation). Advisory fixes when promoting: drop the `as never` source-kind cast (declare a real `moa` message-source kind), assert on the derived message array instead of JSON substring matching; **pin that the first `agent/request` of a turn carries `step: 1` and that the classify trigger is the turn-id change** (grok r4); **pin that the current turn's user message is NOT in session history at `agent/request` time and that the classify input comes from the pre-step capture** (grok r5 — a fixture asserting the listener classifies the current turn's text proves the capture path; the fixture's claimed batch must include a leading notice plus the user/escalation message so the last-element rule is exercised — grok r6).
- New: arming truth-table tests (§3.1) — including the row "`/model` change while a judge call is in flight → switch back to boot default → re-armed, and the in-flight verdict stays discarded" (critic r2 stale-guard corner); explicit-`/model` → zero override (R6 anchor); escalation eligibility gate covering **both first turns and retry turns** (tool turn → no replay, critic r2); retry identity (typed followup carries originSeq; no re-classify; counter never resets); stale-result guard; **idle-wake test: verdict arriving after the loop settles idle must still produce the retry turn via followup** (an inject-only path provably parks — grok r3).
- P6b stays as engine evidence; surface-replace is not v1 product behavior.
- Probe System One script was a one-off and is deleted (its numbers are frozen into §2).

## 9. Risks and residuals (post-review)

- R1 corpus generalization: open, carried by §7 dogfood collection; v1 ships opt-in.
- R2 acceptance calibration: default-OFF + shadow + quantified enablement gate; FN miss class (P5 f6) declared out of scope, not threshold-tunable.
- R3 vs gauge-effort "wrong problem" precedent: differentiation holds structurally (cross-model cascade + post-hoc escalate-only ≠ pre-hoc single-model effort pick), but the four thorns are **not closed** — window (mitigated by bjev 16k + crop contract), corpus (parked on §7), failure economics (only pays if effect-free escalation proves useful in dogfood), flip-flop (clean-sample evidence only). Listed as residuals, not victories.
- R4 role mismatch: defused for v1 by rejecting path C (§3.5); remains on the table if withdrawal is ever revisited.
- R5 stream jump: defused for v1 (append, no replace).
- R6 priority: specified as a truth table + pinned test (§3.1/§6/§8).

## 10. Deferred

`/model moa` convenience; surface-replace withdrawal (path C, engine-proven); buffer-then-stream; `maxEscalations > 1` as a default; tool-turn escalation (continuation-from-tool-state design); acceptance default-on; held-out corpus expansion beyond dogfood.

## 11. Review ledger

r1 (three blind lanes, all GO-WITH-CHANGES): critic — 3 blockers (tool-turn replay gating, presentation form must be weighed against append-second-answer, quantified acceptance gate); codex — §3.3 NO-GO (arbitrary tool-turn replay), plus provenance/entry table, retry identity (immutable origin ID, monotonic tier, atomic reservation, stale guard), cost accounting realism, per-lane budget isolation; grok — explicit fold list (arming truth table + visible tier; N=1 + origin-seq floor + no re-classify; inject-not-followup; tool-turn policy; acceptance default OFF + calibration loop; extract System One client; TTFT in cost), would NO-GO a v1 still shipping path C + "N=2?" + acceptance-on.

Fold mapping: tool-turn gate → §3.4 eligibility; presentation decision record → §3.5 (append-second-answer); acceptance OFF + shadow + gate → §3.3/§7; retry identity + anti-loop → §3.4/§4; arming truth table → §3.1; state contract + truncation → §3.2; client extraction → §3.6; cost realism (TTFT, whole-turn replay) → §5; N=1 documented blast radius → §3.4; stale-result guard → §3.4/§6; effort re-validation → §3.2; degenerate-ladder validation → §3.7; bookkeeping-across-resume honesty → §4.

r2 (delta round, three lanes, all GO-WITH-CHANGES, no residual NO-GO): codex — judge input must include the originating user request, shadow eligibility wider than acting eligibility, N retries imply N judge calls, `callBudgetMs` must be an in-call deadline + registered config key, FP denominator + FN usefulness floor (folded: §3.3/§3.7/§5). critic — eligibility gate covers retry turns too, shadow records must carry an `eligible` flag so gate statistics use the eligible population, re-arm/stale-guard corner test row (folded: §3.4/§3.3/§8). grok — retry-turn routing contract pin (inject opens at step 0; skip classify on `moa-escalation` provenance, apply live origin-seq tierFloor — a step-0 re-classify would make escalation a no-op), frozen inject provenance/template/TUI-notice contract, judge route arming must check window ≥ classifyBudgetTokens (default explicit bjev object-form; gauge fallback only past the check), judge detached off the serial turn-stopping dispatch (advisor-watchdog is the only landed inject-reopens-turn precedent), `callBudgetMs` registration and shadow population (both already folded via codex/critic r2 — grok read the pre-fold revision; noted as a review/fold race, no conflict). All folded: §3.2/§3.3/§3.4/§3.5/§3.6/§3.7/§5/§8.

r3 (fold-confirmation): critic **GO** (zero residual; one cosmetic nit — title version — fixed); codex **GO** (all four r2 items verified landed; no new NO-GO from fold edits); grok **NO-GO, one real mechanism finding**: the detached judge (its own r2 pin) returns after the loop settles idle, and `inject` never wakes a settled idle loop (tool-workflow registry.ts idle vein; cross-confirmed by the harness seams inventory — advisor-watchdog's inject is explicitly non-waking) → an inject-only retry parks until the next user message. Folded into v3 (§3.4): retry wake = `agent.followup` carrying the same typed `moa-escalation` message — safe precisely because the typed provenance keeps it off the genuine-user classify gate and origin-seq bookkeeping; §8 gained an idle-wake test row. Note: this finding refines grok's own r1 preference for inject — recorded honestly as a fold, not a lane error.

r4 (final direct question): critic **GO** (followup change verified in-repo against registry.ts:354-359 + error-recovery non-user-followup precedent; one non-blocking precision folded: the stale-guard's "user sent new input" is concretized as `source.kind === 'user'` so the escalation's own followup never discards its own verdict); codex **GO** (no new NO-GO); grok **GO-WITH-CHANGES, one real mechanism finding, source-verified by the orchestrator** (harness `agent.ts:231` stores phase `step: 0`, `:315/:330` dispatch `phase.step + 1`): the first `agent/request` of a followup-opened turn carries `step: 1`, not `0` — so every `payload.step === 0` gate in the design would never fire, routing would silently never run, and the retry would not take the higher tier. Folded into v4 (§3.2/§3.4/§8): the classify trigger is now the turn-id change (`payload.turn` not yet seen), with the step-numbering fact named in the text so the implementation cannot regress into a step===0 gate.

r5 (final confirmation after the step-gate retarget): critic **GO** (turn-id trigger verified against the probe payload type; two non-blocking implementation notes: `lastSeenTurn` single-value instead of a set, and resume re-classify of the continued turn being fail-open-safe); codex **GO**; grok **GO-WITH-CHANGES, one real mechanism finding, source-verified by the orchestrator** (`agent.ts:408/:577` — `agent/request` fires BEFORE the accepted `user/message` batch is appended at `:419-421`, so neither waterfall sees the current turn's user text in session history): a listener reading "the last genuine user message" from the session would classify the previous turn's text — or nothing on the first turn — and would miss the `moa-escalation` provenance, so the retry would re-classify and the higher tier would never stick. Folded into v5 (§3.2/§3.4/§8): a capture-only `agent/pre-step` listener (payload `messages: claimed`, `agent.ts:277`) records `turn-id → opening message`; the `agent/request` listener reads that capture, never session history; §8 pins the not-in-history fact and the capture path.

r6 (final confirmation after the input-capture fold): critic **GO** (verified the ordering against harness source; two non-blocking notes folded: batch-vs-singular wording — the coordinated reading "record the batch, pick the last user entry" is now explicit, and the §8 fixture asserts the claimed batch); codex **GO**; grok **GO-WITH-CHANGES, one precision pin**: the claimed batch is an array — `inbox.claim` (`inbox.ts:109-111`) appends the single next-turn message after every pending next-step message, so a queued leading notice may precede the opening message; the capture must pin the **last element** of `payload.messages` on the turn's first pre-step, and the §8 fixture must include a leading notice plus the escalation followup. Folded into v6 (§3.2/§3.4/§8) — this matches the coordinated reading critic already blessed in r6.

r7 (grok-only final confirmation after the last-element pin): grok **GO** ($0.04/3 turns) — the pin is in all three places (§3.2/§3.4/§8) and they agree; no remaining NO-GO.

**Converged**: critic GO (r6), codex GO (r6), grok GO (r7). Seven rounds total; discovery categories degraded architecture → mechanism → contract text → element indexing — the expected convergence signature. Grok's lane found all three load-bearing mechanism holes (inject does not wake an idle loop, step:1 numbering, pre-append history visibility), each source-verified by the orchestrator against harness source before folding.
