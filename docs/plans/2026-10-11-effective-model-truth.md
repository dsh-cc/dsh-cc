# effective-model-truth — Make the Harness's Model Bookkeeping Match the Wire Under Per-Request Overlays

Status: Design v6 (post round-5 review). Defect evidence live (2026-10-11, session `tui-5f6c2347`, §2); rounds 1–5 also surfaced and fixed a **pre-existing moa arming bug** (§5.2), a **lifecycle error in this document** (round 3: the step order is claim → assemble → pre-step → request — §2, source-verified) which drove the classification seam redesign, a **frozen-snapshot window** (round 4: the sanitizer publishes `selection.assembled`, not `selection.current` — §5.1), and an **over-engineered persona-effort mechanism** (round 5: deleted — the persona renders no effort, §5.3). Round verdicts in §11. User has ratified the subpath host `@dsh-cc/moa/sanitizer`.

## 1. Goal and scope

When moa (or any future per-request model overlay) is active, three surfaces lie about which model is serving the session:

1. The harness's `[model changed: …]` notice claims "the session continues with `<selection>`" while the wire runs the overlaid pair — re-emitted at nearly every step (session `tui-5f6c2347`: seq 54/93/130/172/201/230/256/281/308/325/353, one per step of turn 1).
2. The system-prompt identity ("You are a coding agent powered by `<model>`") states the session selection, not the model actually generating.
3. The statusline model segment shows the selection.

Additionally (round-1 discovery, worse than the notices): **the arming truth table's "explicit `/model` > overlay" row is unreachable while overlaid** (§5.2) — a user's mid-session `/model` is silently ignored on the wire.

This design makes every surface either tell the truth or explicitly distinguish **selection** (user intent, owned by harness `ModelSelectionRef`) from **effective** (the pair that actually serves the request).

Scope: dsh-cc only. The harness repo is read-only by directive; an upstream proposal is filed separately and is NOT a dependency (§5.5).

## 2. Evidence (live, 2026-10-11, worktree moa-debug)

Source: `~/.dsh/sessions/--…moa-debug--/tui-5f6c2347-…/session.v4.jsonl.zstd`, decompressed and event-typed:

- 12/12 `assistant/message` events carry `message.source.model = llmbox_ant/deepseek-v4.1-flash` (turn 1, steps 1–12). Zero glm-5.3.
- The single `request/header` records `config = {provider: orchestrix, model: llmbox_ant/deepseek-v4.1-flash, reasoningEffort: max}`.
- moa's status row (seq 53): `{"kind":"moa","form":"notice","summary":"moa: routed → sketch","tier":0}` — sketch tier → lane peer `haiku` → the user's `haiku` alias = deepseek-v4.1-flash (`cc-model-aliases/src/resolver.ts:58-64`).
- Harness `model-selection` notices (seq 54 onward): `summary "llmbox_ant/deepseek-v4.1-flash → llmbox_ant/glm-5.3"` — one per step, never converging.

Root cause (code-anchored):

- moa overlays the `agent/request` return value post-`next()` (`packages/interaction/moa/src/router.ts:210 withTier`). Its listener registers at plugin apply (t0, no prepend) and is therefore OUTER relative to the harness's `installModelSelection` request listener, which registers at agent creation (t1, no prepend) and re-forces `selection.assembled` — the overlay wins on the wire (proven by the header above).
- The harness's notice listener (`deepseek-harness packages/core/agent/src/model-selection.ts:117-126`, registered `{prepend:true}`) compares `selection.assembled` with `agent.session.requestHeader()?.config` at `:121`. Under an overlay these never converge, so the notice re-fires every step.
- The harness's assemble listener (`model-selection.ts:82-95`) writes `variables.provider/model` from `selection` — the persona therefore states the selection, not the effective model.

**Step lifecycle (source-verified, round-3 correction; load-bearing for §5.3).** One step proceeds: `inbox.claim` (`agent-loop/src/agent.ts:271`, which emits `agent/inbox/claimed` per claimed message, `inbox.ts:112`) → `systemPrompt.assemble` waterfall (`agent.ts:272` — the harness model-selection assemble listener snapshots `selection.current` into `selection.assembled` and writes it into `variables` here) → `agent/pre-step` waterfall (`agent.ts:276+`; the harness notice listener compares the freshly-snapshotted `selection.assembled` against the last request header here) → `agent/request` waterfall. There is NO async seam between claim and assemble other than the assemble waterfall itself.

## 3. Concepts

- **selection** — what the user chose. `selection.current` = live intent (mutated by `/model`; ACP pins it per admitted turn); `selection.assembled` = the per-assembly snapshot the harness itself compares and forces into request config.
- **effective** — the pair that actually served / will serve the request: the post-waterfall resolved config, durably recorded in `request/header` and per-message `assistant/message.source.model`. These records are already correct today and are the truth source; this design makes everything else agree with THEM.
- **boot pair** — the session's boot selection (the first main-agent selection ever observed by this process), shared by the arming machine and the sanitizer as THE baseline (§5.2).

Rule of the design: nothing may rewrite `request/header` or per-message stamps; every other surface must either read the effective truth or label itself as selection. All pair comparisons are FIELD comparisons (provider === provider && model === model) — never object identity.

## 4. Goals / non-goals

Goals:

- G1 The running model is never told a false identity: no injected notice claims a continuation model that will not serve, and the persona variables state the effective pair, within the documented residuals (§9).
- G2 User-visible surfaces distinguish selection from effective.
- G3 Zero harness-repo changes.
- G4 Restore the moa arming §3.1 truth table (its "explicit /model" row is currently dead code under overlay) and keep the P3a `firings == steps` contract.
- G5 Fail-soft: any disabled/absent piece degrades to today's behavior, except §5.2 which is a deliberate bug fix changing (improving) today's behavior.

Non-goals: `/model` catalog validation; `request/header` / per-message stamp semantics; routing policy; subagent model handling (PR #235).

## 5. Design

### 5.1 S2 — the model-selection notice sanitizer (PR-1)

A side-effect-free module inside `@dsh-cc/moa`, exported via the subpath `@dsh-cc/moa/sanitizer` (user-ratified; exports-map entry whose import graph MUST NOT pull the plugin `apply()` path):

```ts
installModelSelectionSanitizer(agentCtx: Context, selection: ModelSelectionRef): () => void
```

**Co-location (load-bearing).** Registered immediately after every dsh-cc call site of `installModelSelection`, because it needs the `selection` ref from the same closure and must register later-with-prepend to become the outermost `agent/pre-step` listener (the harness notice listener is `{prepend:true}` at agent creation; an inner listener cannot strip what the outer appends). Known call sites: `packages/ui/tui/src/harness/driver.ts` (`withSelection`), `packages/acp/cc-acp/src/model-control.ts` (`install`). The implementation MUST re-grep `installModelSelection` across the repo; a missed entry point degrades to today's behavior (fail-soft, G5).

**Listener shape (one outermost `agent/pre-step` listener, two halves):**

```
preStep(payload, next):
  publishLiveSelection(payload.agent, selection.assembled)  // BEFORE next(), subagent-guarded — the FROZEN snapshot for this step (see below); inner listeners read it (§5.2)
  const decision = await next()                            // inner chain, incl. moa's observe (may disarm/re-arm) + harness notice append
  if (decision === undefined || decision.kind === 'reject' || decision.messages === undefined) return decision
  const active = moaOverlayActive()                       // = validation.ok && arming.isArmed(); false (never throws) when the plugin is not applied
  const boot = moaBootDefault()                            // undefined when the plugin is not applied
  const assembled = pair(selection.assembled)
  const drop = active && assembled !== undefined && boot !== undefined && sameFields(assembled, boot)
  if (!drop) return decision
  return { ...decision, messages: decision.messages.filter(m => m.source?.kind !== 'model-selection') }
```

**The publish source is `selection.assembled`, deliberately NOT `selection.current`** (round-4 challenge, adopted). A `/model` switch whose async effort validation resolves mid-assembly (driver-pickers.ts `applyModelSwitch`) leaves `assembled` frozen on the pre-switch pair for that step; publishing `current` would disarm at pre-step (releasing a notice naming the frozen pair) while the request-time observe of the same frozen pair re-arms and overlays — a false notice plus an un-honored switch for one step. Publishing the frozen `assembled` makes the whole step self-consistent (persona variables, arming observes, and the request all read the same pair); the switch is adopted at the NEXT assembly, which is the harness's own documented snapshot semantics. The publish carries the pair only — no effort (the persona never states an effort; see §5.3).

**Drop rule: `drop iff moa's overlay is active AND pair(selection.assembled) == the moa boot pair`; pass through otherwise.**

- The harness emits a notice iff `assembled != header`. moa overlays iff armed, and armed iff (after §5.2) the observed live selection equals the boot pair. So under "active AND assembled == boot", the notice's advertised continuation model is exactly what the overlay will NOT serve → phantom → drop. Every other state passes through untouched: **the sanitizer is inert unless moa's overlay is actually active on its boot selection** — no-moa deployments, disarmed sessions, validation-failed sessions, and non-moa overlays see byte-identical harness behavior (G5).
- `moaOverlayActive()` includes `validation.ok` (the arming machine's hot-reload row can set `armed` while validation has not passed — `arming.ts:60-63`); both accessors return inert values (false / undefined) when the moa plugin was never applied, instead of throwing.
- **Switch-away notices are true and survive** (round-3 correction): the harness notice listener runs at pre-step, AFTER this step's assembly refreshed `selection.assembled` to the current selection (§2 lifecycle). On a `/model`-away transition the notice therefore names the NEW selection, moa's inner observe disarms before the filter, `moaOverlayActive()` is false, and the (true) notice passes through. On switch-back the re-armed state drops the transition notice — which is a PHANTOM under P-D's expectations (the transition turn is classified and overlaid, so the "→ boot" continuation claim is false); the drop is correct, and the moa row carries the truth.
- The sanitizer is moa-aware by construction (same package, shared module state). Cost: a future non-moa overlay needs its own condition (§9 residual).
- The sanitizer does NOT promise to keep any particular true notice — its obligation is "never keep a phantom".

### 5.2 S2c — fix the arming observation: make "explicit /model > overlay" real (PR-1, prerequisite)

**The bug (round-1 BLOCKER, code-verified).** `decide()` (`router.ts:339-356`) feeds `arming.observeRequestModel` the **stale session request header**, guarded by "skip the observe when `header == lastAppliedPair`". In the armed steady state the header always equals the overlay pair — `buildRequest` logs the post-overlay resolved config (`agent-loop/src/agent.ts:612-633` writes `request/header` after the waterfall), and `applyModelSwitch` writes ONLY the in-memory selection (`driver-pickers.ts:98-119`, no session append). So the guard skips the observe forever, `/model` never disarms moa while overlaid, and the user's explicit choice is silently overridden. This contradicts `arming.ts`'s own module doc ("this machine always sees the user's live selection (pre-override), never moa's own overlay").

**Fix, part 1 — one unconditional boot baseline, with specified callers, and no competing capture.** The arming machine gains `noteBootPair(pair)` (first non-undefined pair wins; never overwritten; UNCONDITIONAL — runs regardless of `moa.enabled`), and `observeRequestModel` LOSES its own two `bootDefault` assignments (`arming.ts:60-63` hot-reload row and `:65-67` first-observe row) — the hot-reload row now only sets `armed = true` and **falls through** to the `same(pair, bootDefault)` comparison instead of returning early (round-5 finding: an early return would let a hot-enabled machine observe an off-boot pair without ever disarming); ALL captures go through `noteBootPair`. `noteBootPair` is called from exactly three places, all subagent-guarded: (a) moa's pre-step listener via the shared helper `observeLiveSelection(pair)` = `noteBootPair(pair); if (isEnabled()) observeRequestModel(pair)` reading the sanitizer's published frozen selection (part 2), (b) the request listener via the same helper after `await next()` (part 3), and (c) moa's assemble listener, which notes the harness-written selection variables DIRECTLY (`noteBootPair(selectionVars)` — no machine observe needed there; the gate uses the variables) BEFORE evaluating its gate (§5.3) — this is what keeps the session's very FIRST assembly from failing on an undefined boot pair. **Contract: every `observeRequestModel` call MUST go through `observeLiveSelection`; a direct call is a contract violation** (with `bootDefault` now possibly undefined, the machine's comparison additionally guards `bootDefault === undefined → return`, defense against refactor). The disabled fast-bail in every request-listener shape therefore becomes `const resolved = await next(); if (!isSubagentAgent(payload.agent)) observeLiveSelection(pairOf(resolved)); return resolved` — still zero classification and zero overlay, but the baseline is always captured, including ship-dark sessions that later enable.

**Fix, part 2 — observe the step's frozen selection at pre-step, before anything else.** The sanitizer's outer pre-step half publishes `selection.assembled`'s pair into the shared moa runtime state BEFORE `next()`; moa's `agent/pre-step` listener then does, as its FIRST act (subagent-guarded before touching shared state):

```
if (!isSubagentAgent(payload.agent)) {
  const live = readPublishedSelection(payload.agent)       // undefined in deployments without the sanitizer
  if (live?.model !== undefined) observeLiveSelection(live)
}
if (!opts.validation.ok) opts.ensureArmed?.()            // per-firing retry for the mount race (index.ts:117-154)
```

Because the published pair is the frozen `selection.assembled` (§5.1), the pre-step observe and the request-time observe see the SAME pair — no disarm/re-arm churn within a step, and a mid-assembly `/model` cannot flip the machine underneath the step (round-4 challenge, adopted). A switch that landed before this step's assembly refreshes `assembled` at :272, so both this observe and the assemble gate (which reads the harness-written variables directly) see it.

**Fix, part 3 — delete the header observe; keep a request-time observe as the always-on guarantee.** Remove the header read and the self-feedback guard from `decide()`. In the `agent/request` listener, after `await next()` and BEFORE `withTier`, on EVERY request (idempotent): `if (!isSubagentAgent(payload.agent)) observeLiveSelection(pairOf(resolved))`. The observed pair is pre-overlay by construction (moa applies `withTier` strictly after), so the old self-feedback trap is structurally impossible. Retained because it keeps the arming truth correct in deployments without the sanitizer.

**Listener specs.** PR-1 ships BEFORE the classification-seam move, so its `agent/request` listener must still classify (otherwise `turnTier` is always empty and moa stops routing). Two specs:

*PR-1 shape* — request listener: settings fast-bail (with baseline capture, part 1) → subagent bail → `const resolved = await next()` → observe (part 3) → `if (!arming.isArmed() || !validation.ok) return resolved` → if the turn was classified in `decide()` (called at `isNewTurn` inside this listener, as today) apply `withTier`, else `return resolved`. `decide()` keeps `ensureArmed` but loses the header observe.

*PR-2 final shape (post-seam-move, §5.3)* — the request listener loses classification entirely:

1. `if (!core.readSettings().enabled) { const resolved = await next(); if (!isSubagentAgent(payload.agent)) observeLiveSelection(pairOf(resolved)); return resolved }` — zero-overhead default-off, baseline still captured.
2. `if (isSubagentAgent(payload.agent)) return next()` — children own their declared models.
3. `const resolved = await next()`.
4. `if (!isSubagentAgent(payload.agent)) observeLiveSelection(pairOf(resolved))`.
5. `if (!arming.isArmed() || !validation.ok) return resolved` — the transition guard. When this clause skips `withTier`, **clear `pendingRows`** (the queue is untagged by design, `router.ts:198` — clearing is the specified mechanism; a row advertising a tier that was not applied is a lie of the same family as the notice).
6. `if (turnTier?.turn === payload.turn) return withTier(resolved, turnTier.tier, payload.signal)`; else `return resolved` (classification miss → fail-open).

The moa-escalation retry path keeps `if (!arming.isArmed()) return undefined` **in the PR-1 shape only**; in PR-2 the retry gate is the shared §5.3 condition (`enabled && validation.ok && selectionVars == boot`), not a bare `isArmed()` that lags at assemble time (round-5 finding: the two specs previously conflicted).

**Shared state module.** The boot pair, arming machine, `validation`, and the published live selection live in a side-effect-free module (`packages/interaction/moa/src/runtime-state.ts`) imported by `index.ts` (provider), `router.ts`, and `sanitizer.ts` — so `@dsh-cc/moa/sanitizer` never imports the plugin `apply()` path, and the sanitizer's accessors never throw when the plugin is absent.

### 5.3 S3 — classification into the assemble waterfall + truthful persona + row upgrade (PR-2)

**Round-3 correction drives the seam.** The v1–v3 plan hoisted classification to `agent/pre-step` — under the verified lifecycle (§2: claim → assemble → pre-step → request) that is too late for the persona: the assemble waterfall has already run. And `agent/inbox/claimed` is a synchronous emit (`inbox.ts:112`), not a waterfall — it cannot host an async classification. The only pre-persona async seam is the assemble waterfall itself. The seam therefore moves THERE, in two pieces:

**Capture (synchronous, at claim).** The opening capture moves from the pre-step listener to `agent/inbox/claimed` (per-message emit, payload `{agent, message, turn}` — `runtime-types.ts:299`). Rule unchanged from today's capture: per turn, the LAST claimed message wins (the claimed batch claims pending next-step items first, then the next-turn message, `inbox.ts:110-111` — so the last emit is the opening, exactly the current "last element of the batch" rule). Subagent-guarded before writing the shared map. The pre-step capture listener is removed.

**Classification + persona + row (async, at assemble).** moa registers a `system-prompt/assemble` listener (plugin-apply registration, OUTER relative to the harness's assemble listener registered at agent creation; pinned by the live-fold composition test). After `await next()` (so the harness has already written `variables.provider/model` from the live selection):

```ts
const assembled = await next()
const agent = context.agent                                  // absent on diagnostic assemblies → fail-open below
const selectionVars = pairOf(assembled.variables)            // the harness's just-written selection pair
if (agent !== undefined && !isSubagentAgent(agent) && selectionVars !== undefined) noteBootPair(selectionVars)  // FIRST (round-4: before the gate; the session's first assembly)
if (!opts.validation.ok) opts.ensureArmed?.()               // BEFORE the gate (round-4: recovery must precede the validation check)
const gate =
  core.readSettings().enabled && opts.validation.ok &&
  agent !== undefined && !isSubagentAgent(agent) &&
  selectionVars !== undefined && moaBootDefault() !== undefined && sameFields(selectionVars, moaBootDefault())
if (!gate) return assembled                                  // fail-open: persona states the selection
const turn = currentClaimedTurn()                            // the LAST turn seen by the agent/inbox/claimed listener (round-4: AssembleContext has no turn field — scope/signal/agent only)
const { tier, classifiedNow, suppressRow } = await tierForTurn(turn)   // sticky per turn; classifies (System One, bounded by call-budget-ms) on the turn's first assembly; fail-open → tier undefined
if (tier === undefined) return assembled                     // classification failed → persona states the selection, request clause 6 serves it — consistent
if (classifiedNow && !suppressRow) queueRow(`moa: routed → ${TIER_ALIASES[tier]} (${tierPair.model})`, tier)   // round-4: once per routing decision; escalation retries keep their suppression
return { ...assembled, variables: { ...assembled.variables, ...tierRouteVariables(tier) } }
```

- **The persona writes `provider`/`model` ONLY — no effort, ever** (round-5 simplification, resolving a three-seat divergence). The harness's own assemble listener writes only `provider`/`model` into variables (`model-selection.ts:82-95`); the persona renders no effort, so there is nothing to keep in sync and no effort source to reach for. Effort lives exclusively on the wire: `withTier` re-validates the harness-forced `selection.assembled.reasoningEffort` and degrades with its warn-once row, exactly as today. `tierRouteVariables(tier)` is therefore a pure pair computation.

- `currentClaimedTurn()` reads the shared runtime state, updated by the `agent/inbox/claimed` listener (whose payload carries `turn` and which provably precedes the assembly it feeds). Agent-bearing assemblies not tied to a step (diagnostics) simply re-derive the last-claimed turn — a benign rewrite, since `tierForTurn` is sticky. The turn source must be subagent-guarded on write.
- (Removed in v6 — see the no-effort bullet above: the persona states no effort, so no effort source is needed.)
- The escalation retry path inside `tierForTurn` uses the SAME gate condition (not a bare `arming.isArmed()` — at assemble time the machine may still reflect the previous step's state; `selectionVars == boot` is the operative invariant, round-4 finding) and preserves its `suppressRow` semantics.
- **The gate is simultaneously the classify gate and the persona gate** — one condition, evaluated once, so the persona and the wire cannot disagree about WHETHER an overlay applies. `selectionVars == boot` implies the arming machine is (or is about to be re-) armed per the §3.1 truth table: the only disarm reason is a selection off the boot pair, and the pre-step observe (§5.2 part 2) formalizes the re-arm before the request's clause 5. On a switch-away step the harness variables already carry the new selection → gate false → no classify (no wasted call), persona = new selection = what clause 5 will serve.
- `tierRouteVariables(tier)` is a SHARED PURE helper extracted from `withTier`'s pair computation: it returns the tier's provider/model from the resolved route, synchronously, with no cache access and no notice queueing. The wire's `withTier` keeps its own effort half (cache read + `resolveEfforts` + degradation row) unchanged.
- Classification latency moves into the assemble waterfall — the SAME serial position it occupies today (inside the request waterfall at step 1): total step-1 latency is unchanged. Timeout/failure fails open: no tier → persona states the selection AND request clause 6 serves the selection — truthful both ways.
- P3a: classification remains a hand-built side-query (no `sessionId`), never re-enters `agent/request`; firings == steps unchanged.
- The pre-step listener reduces to: subagent bail → observe (§5.2 part 2) → `ensureArmed` → pendingRows splice (row delivery — now landing in the SAME step as the overlay, since the row is queued during assemble and spliced by the immediately following pre-step).
- Retry-turn routing (§3.4) and the moa-escalation provenance skip path port into `tierForTurn` unchanged — they are inputs to classification, not call-site properties.

### 5.4 S4 — statusline effective display (PR-2)

Extend the existing moa statusline channel (PR #233: `packages/ui/tui/src/harness/statusline-moa.ts`, fed via `moaRef` at `driver.ts:258`) to carry the effective pair alongside the tier; render `<model-id> ◂ <tier-alias>` using the resolved tier route's model id (e.g. `deepseek-v4.1-flash ◂ sketch`) when an overlay is active, the plain selection otherwise. No new data plumbing — moa publishes through the same ref update path it uses for the tier today.

### 5.5 Decision record

- **No harness-repo edits** (read-only directive). Upstream proposal: `modelSwitchNotice` should compare against the previous selection, not the last request header. The sanitizer stays even if adopted (defense against any overlay).
- **No mutation of `ModelSelectionRef.current` from moa.** No public seam; it pollutes the user-intent surface; it would feed the arming observe a self-authored pair.
- **Hosting: subpath export `@dsh-cc/moa/sanitizer`** (user-ratified). The tui already depends on `@dsh-cc/moa`; `cc-acp` gains exactly this one dep. Rejected: a standalone package (full registration checklist for one module) and `@dsh-cc/model-aliases` (couples a notice concern to alias-resolution ownership).
- **No overlay registry.** The sanitizer needs `(selection ref, shared boot pair, overlay-active)` — all available in-package. Residual for future non-moa overlays in §9.

## 6. Probes and gates (implementation-blocking)

| Probe | Gate | Method |
|---|---|---|
| P-B ordering | the sanitizer's post-agent-creation `prepend:true` pre-step listener is outermost (sees harness-appended `model-selection` rows; its publish precedes moa's pre-step observe); moa's assemble listener is outer relative to the harness's | live-fold composition test (`composition.spec` rig) |
| P-C seam safety | firings == steps (P3a re-run); the assemble-seam classification picks the same tier as the request-time baseline on the routing mini-corpus replay; admission/subagent commits never consume a turn | rig replay + ledger diff |
| P-D truth (live A/B) | with moa active on its boot selection: zero `kind:'model-selection'` rows in a fresh session transcript; the moa row carries the pair and lands in the same step as the overlay; `/model` away → the wire serves the new selection, moa disarms before classifying, no FALSE notice is kept; `/model` back → the transition turn is classified and overlaid (gate re-passes via `selectionVars == boot`); steady overlay never disarms | transcript-gated live A/B in the moa-debug worktree |
| P-E lifecycle (corrected) | within one step: claim (`agent/inbox/claimed` capture) → assemble (classify → persona variables == the pair the request will serve) → pre-step (observe + row splice) → request (overlay). A green probe must be driven against THIS order | rig lifecycle test |
| P-F capture visibility | the assemble-seam classification sees the opening captured by the `agent/inbox/claimed` listener during the claim that precedes the assembly | rig test |
| P-G baseline | session started with moa disabled, `/model`-ed, then enabled: one shared boot pair; the escape hatch still works; no phantom survives | rig + live A/B |

## 7. Test plan

1. Sanitizer: drop only under `overlayActive && assembled == boot`; pass-through otherwise (no-moa, disarmed, validation-failed, plugin-absent accessors return inert values, `assembled`/`boot` undefined, `messages` undefined, reject decisions); returns a copied decision; field comparison not identity.
2. Sanitizer wiring: co-located registration is outermost (P-B); missed entry point = documented degradation (request-time observe still keeps arming correct).
3. Arming: `/model` away under overlay disarms before classification (no wasted call, no stale row) and the wire serves the new selection; switch back re-passes the gate and the transition turn IS overlaid; steady overlay never disarms; the disabled fast-bail still captures the boot baseline; both observes are subagent-guarded; escalation retry turns observe the boot pair as a no-op; disabled start → `/model` → runtime enable shares one boot pair (P-G).
4. Seam move: P-F capture visibility; sticky-tier per turn; fail-open on classification timeout (persona = selection AND wire = selection); retry/escalation provenance; P-C parity vs the request-time baseline; P3a re-pin.
5. Persona: variables carry the tier pair only when the gate passes; fail-open paths leave the harness's variables; the persona NEVER writes an effort field; the shared helper gives persona and wire the identical pair; P-E lifecycle.
6. Statusline: `<model-id> ◂ <tier>` rendering; PR #233 tests green.
7. Invariant: `assistant/message.source.model` equals the applied overlay pair on every classified turn; clause-5 skips clear `pendingRows`.

## 8. Delivery

- **PR-1**: §5.2 arming fix (parts 1–3, with the specified `observeLiveSelection` callers and the disabled-path baseline capture) + §5.1 sanitizer (subpath module + co-located registration; cc-acp gains the `@dsh-cc/moa` dep) + the row upgrade + the PR-1 listener shape. User-visible behavior changes (notices filtered, `/model` honored under overlay) → `engine.moa` manifest row update + parity regen are MANDATORY in this PR. moa README updated.
- **PR-2**: §5.3 seam move (capture at `agent/inbox/claimed`, classify/persona/row at assemble) + §5.4 statusline + tests 4–6; the moa design doc §3.2 gets the seam amendment.
- Upstream issue filed separately; not a dependency.

## 9. Risks and residuals

- R1 The seam move touches P3a-adjacent timing and retry-turn routing — PR isolation, P-C/P-F, §7.4. Fallback if it fails: ship PR-1 only (notices truthful, `/model` honored); the persona stays wrong — documented, not silent.
- R2 Ordering assumptions (sanitizer outermost; moa assemble outer; claim-then-assemble) are source-verified (`agent.ts:271-276`, `inbox.ts:112`) and pinned by P-B/P-E/P-F; a harness reorder turns the pins red rather than silently lying.
- R3 A future dsh-cc entry point calling `installModelSelection` without the sanitizer reintroduces phantoms there and loses the pre-step publish (the request-time observe still keeps arming correct) — fail-soft.
- R4 Upstream may change the notice semantics — the sanitizer matches `source.kind === 'model-selection'` (stable, module-augmented); an upstream fix lands in the pass-through branch.
- Residuals (accepted, each bounded):
  - Switch-back transition notice: the re-armed state drops the harness's "→ boot" notice — a phantom under P-D (the transition turn is classified and overlaid, so the continuation claim is false); the moa row carries the truth.
  - The persona states no effort at all (it writes provider/model only, matching the harness's own variable shape); the wire may carry one via `withTier` — since the persona makes no effort claim, no divergence is possible on that axis.
  - A `/model` resolving mid-assembly (the frozen-snapshot window, §5.1): the switch is adopted at the NEXT assembly; during the gap the wire serves the frozen pair and the persona states the same frozen pair — the publish, both observes, the notice filter, and the request all read the frozen pair, so no false notice and no split surfaces (round-4 challenge folded into the publish design).
  - A future non-moa overlay gets no persona truth and no notice filtering unless it adopts the same boot-pair invariant.
  - Classification failure/timeout: persona states the selection and the wire serves the selection — truthful, but the turn runs unrouted (cost, not truth).

## 10. Deferred

- `/model` picker header showing effective.
- Rewriting phantoms into a positive "effective model" row — the §5.3 row already carries the truth.
- Upstream adoption of the notice-semantics fix.

## 11. Review ledger

**Round 1 (v1 → v2).** critic GWC (1 BLOCKER, 2 MAJOR, 5 MINOR, 2 NIT), codex NO-GO (2 BLOCKER, 5 MAJOR, 1 MINOR), grok interrupted (auth). Adjudication: both BLOCKERs converged on "moa disarms on /model while overlaid" being unverified — orchestrator code-verification CONFIRMED the defect is real and pre-existing (header observe + self-feedback guard unreachable under overlay). Folded into v2.

**Round 2 (v2 → v3).** critic GWC (all 10 folds OK; 3 doc findings), codex NO-GO (1 fold PROBLEM + 1 BLOCKER + 1 MAJOR), grok NO-GO (7). Folded into v3: one shared unconditional boot baseline; armed-gated sanitizer rule; pre-step selection publish; PR-1/PR-2 listener shapes; persona `selectionVars == boot` condition; snippet hygiene.

**Round 3 (v3 → v4).** critic GWC (2 folds OK, 1 fold PROBLEM + 1 MAJOR + 1 MINOR + 1 NIT), codex NO-GO (folds #2–#8 OK, fold #1 PROBLEM + 2 MAJOR + 1 MINOR), grok NO-GO (folds #2–#5, #7 OK; fold #1 PROBLEM, fold #6 PROBLEM; 1 NEW MAJOR, 1 NEW MINOR). Adjudication:

- **Lifecycle correction (grok fold #6 + NEW MAJOR, confirmed against source).** v3's P-E claimed pre-step → assemble → request; the loop is actually claim → assemble → pre-step → request (`agent.ts:271-276`). This was THE load-bearing error of the round: codex's fold-#1 PROBLEM and critic's MAJOR-#1 (both: "switch-away keeps a false notice naming the stale assembled") were traced under the doc's stated order and are VOID under the verified one — the assembly refreshes `selection.assembled` before the notice listener runs, so the switch-away notice names the new selection and is true. Both seats' findings are recorded here as dissolved-by-correction, not as folded fixes; the corrected §5.1 states the true behavior.
- **Seam redesign (driven by the same correction).** Classification moves to the assemble waterfall (the only pre-persona async seam), capture to `agent/inbox/claimed`; the gate is shared by classify and persona; the row lands in the same step as the overlay (§5.3 rewritten).
- codex MAJOR / grok fold-#1 (`noteBootPair` has no caller; disabled fast-bail skips the baseline) — CONFIRMED. Folded: `observeLiveSelection` helper with two specified subagent-guarded call sites; the disabled fast-bail captures the baseline after `next()` (§5.2 part 1).
- codex MAJOR / grok NEW MINOR / critic fold-#2 (the pre-step observe lacks a subagent guard) — CONFIRMED (three-seat hit). Folded: guards on publish, observe, and capture before any shared-state touch.
- grok fold-#1 sub-points (accessors throw before `apply()`; `observeRequestModel` hot-reload row sets armed while `validation.ok` is false) — CONFIRMED. Folded: `moaOverlayActive()` = `validation.ok && arming.isArmed()` with inert accessor fallbacks (§5.1).
- grok fold-#6 sub-points (variables carry only provider/model; cache-miss residual mischaracterized as pair-equal) — CONFIRMED. Folded: `carriedEffort` from `selection.assembled.reasoningEffort`; cache-miss writes the pair and omits the effort; residual recharacterized (§5.3, §9).
- codex MINOR (P-D still described the v2 un-routed transition turn) — folded; P-D now requires the transition turn to be classified and overlaid.
- critic NIT (clause-5 "drop rows for this turn" has no mechanism) — folded: clear `pendingRows` explicitly (§5.2 clause 5).
- User ratified the subpath host during round 3 (§5.5 updated).

**Round 4 (v4 → v5).** codex NO-GO (adjudication CONFIRM; folds #1–#4 OK; 5 MAJOR + 1 MINOR), critic GWC (adjudication CONFIRM with its own source re-verification; 2 MAJOR + 1 NIT), grok NO-GO (adjudication CHALLENGE — accepted; folds #2–#5, #7 OK; fold #1 PROBLEM, fold #6 PROBLEM; 2 MAJOR + 1 MINOR). Adjudication of the challenge: grok identified a narrow real window — a `/model` whose async effort validation resolves during the assemble await leaves `selection.assembled` frozen on the pre-switch pair; publishing `selection.current` (v4) would disarm at pre-step, release a notice naming the frozen pair, then re-arm at the request's observe of the same frozen pair and overlay — one false notice plus an un-honored switch. ACCEPTED; the publish source is now the frozen `selection.assembled` (§5.1), which also resolves codex's MINOR (residual reworded, §9). The two CONFIRMs stand for the main ordering claim — the challenge refined a sub-case, not the ordering. Folds:

- Baseline capture (codex M1 / grok fold-#1, both valid): `noteBootPair` now has THREE callers, the earliest being the assemble listener BEFORE its gate (the session's first assembly no longer fails on an undefined boot pair); `observeRequestModel` loses its own `bootDefault` assignments (grok: the hot-reload row would clobber the noted baseline — `arming.ts:60-63` assigned unconditionally).
- `contextTurn` source (codex M4 / critic M1 / grok NEW MINOR — three-seat hit): the turn comes from runtime state updated by the `agent/inbox/claimed` listener (payload carries `turn`, precedes the assembly); `AssembleContext` has no turn field.
- Row gating (codex M5 / critic M2 / grok NEW MAJOR-1 — three-seat hit): the row queues only on the turn's FIRST classification (`classifiedNow`), escalation retries keep `suppressRow`.
- `ensureArmed` before the assemble gate (codex M3): recovery must precede the `validation.ok` check that the gate reads.
- Retry floor gate (codex M2): the escalation-retry path uses the shared gate condition (`selectionVars == boot`), not a bare `isArmed()` that lags at assemble time.
- `carriedEffort` source (grok fold-#6): the publish carries `selection.assembled.reasoningEffort` — the only reachable effort source from the plugin's assemble listener.
- Verification provenance note (advisory, adopted): round-4 findings were adjudicated by lifecycle traces against the source-anchored ordering plus direct reads of `arming.ts`/`agent.ts`/`model-selection.ts`; no finding was accepted on the seat's word alone, and the one challenge was resolved by adopting the challenger's prescription rather than rebutting it.

**Round 5 (v5 → v6).** critic GWC (2 folds OK; 1 fold PROBLEM — a wording fold claimed in the round-5 brief but not actually applied, caught and now applied; 1 MINOR + 1 NIT), codex NO-GO (folds #2–#4, #7–#8 OK; #1 PROBLEM, #5 PROBLEM, #6 PROBLEM; 1 NEW MAJOR), grok GWC (folds #1–#4, #7–#8 OK; #5 PROBLEM, #6 PROBLEM; 1 NEW MAJOR + 1 NEW MINOR + 1 NIT). Folds:

- **Effort divergence (codex #6 + NEW MAJOR; grok #6 + NEW MAJOR; critic MINOR — three-seat divergence on the remedy, resolved by simplification):** all seats correctly found that the v5 `publishedEffort` (published at pre-step) is consumed EARLIER at assemble — undefined on the first assembly, the previous step's value thereafter. Remedies proposed: a guarded getter (codex), a dedicated sanitizer assemble listener between moa's and the harness's (grok). Resolution adopted instead: **delete the persona-effort mechanism entirely** — verified against `model-selection.ts:82-95`: the harness writes only `provider`/`model` into variables; the persona renders no effort, so no sync is needed. `tierRouteVariables(tier)` is pair-only; effort lives exclusively on the wire (`withTier`, unchanged). Both seats' remedies are thereby mooted by removing the requirement; recorded as the resolved form.
- **Hot-enable fallthrough (codex fold-#1 PROBLEM):** after removing the observe's `bootDefault` assignments, the hot-reload row must NOT return early — it falls through to the `same(pair, bootDefault)` comparison, or a hot-enabled machine could observe an off-boot pair without disarming (§5.2 part 1).
- **Retry-gate conflict (codex #5 / grok #5):** §5.2's retry sentence (bare `isArmed()`) conflicted with §5.3's shared gate — now scoped: bare gate in the PR-1 shape only, shared condition in PR-2.
- **Switch-back wording (critic fold-#3 PROBLEM):** the §5.1 bullet and §9 residual had claimed-but-unapplied "true-but-transient" wording; both now state the P-D-consistent phantom characterization.
- **Part-2 stale claim (grok NEW MINOR):** "arming transitions visible before classification" was v3 language — classification now runs at assemble; the sentence now attributes pre-assembly switches to the assemble gate via the harness variables.
- **Caller wording (grok NIT) + wrapper contract (critic NIT):** `noteBootPair` has the three callers (the assemble path calls it directly, not via `observeLiveSelection`); every `observeRequestModel` call MUST go through `observeLiveSelection`; the machine guards `bootDefault === undefined` defensively.

**Round 6 (v6 → v7, closing).** critic **GO** (adjudication CONFIRM; all folds OK; 1 NIT), codex **GO-WITH-CHANGES** (adjudication CONFIRM; all 5 folds OK; 1 MINOR), grok **GO-WITH-CHANGES** (adjudication CONFIRM; all 5 folds OK; 1 MINOR + 1 NIT). All three seats CONFIRMED the effort-deletion resolution (grok additionally source-verified that the request listener applies effort at `model-selection.ts:102-109` and the persona interpolates only `{{model}}`). Remaining findings were two single-phrase deletions, both applied in v7: the stale "(+ its `reasoningEffort`)" in §5.2 part 2 (all three seats hit it) and a redundant effort parenthetical in §5.3 (grok NIT). Micro-confirmation round to the two non-GO seats follows; critic's GO stands.
