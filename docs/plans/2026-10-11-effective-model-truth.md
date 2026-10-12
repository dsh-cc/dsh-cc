# effective-model-truth — Make the Harness's Model Bookkeeping Match the Wire Under Per-Request Overlays

Status: Design v3 (post round-2 review). Defect evidence live (2026-10-11, session `tui-5f6c2347`, §2); rounds 1–2 surfaced and this revision fixes a **pre-existing moa arming bug** (the `/model` escape hatch is unreachable while overlaid — §5.2, code-verified). Round 1: critic GO-WITH-CHANGES (10), codex NO-GO (8). Round 2 (on v2): critic GO-WITH-CHANGES (all 10 folds OK + 3 doc findings), codex NO-GO (1 fold PROBLEM + 1 BLOCKER + 1 MAJOR), grok NO-GO (7) — all folded, ledger §11. Pending user re-ratification: sanitizer host revised from a standalone package to a subpath export of `@dsh-cc/moa` (§5.5).

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
- The harness's notice listener (`deepseek-harness packages/core/agent/src/model-selection.ts:117-126`, registered `{prepend:true}`) compares `selection.assembled` (glm-5.3) with `agent.session.requestHeader()?.config` (flash — the post-overlay wire truth) at `:121`. Under an overlay these never converge, so the notice re-fires every step.
- The harness's assemble listener (`model-selection.ts:82-95`) writes `variables.provider/model` from `selection` — the persona therefore states the selection, not the effective model.

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

A side-effect-free module inside `@dsh-cc/moa`, exported via the subpath `@dsh-cc/moa/sanitizer` (exports-map entry whose import graph MUST NOT pull the plugin `apply()` path):

```ts
installModelSelectionSanitizer(agentCtx: Context, selection: ModelSelectionRef): () => void
```

**Co-location (load-bearing).** Registered immediately after every dsh-cc call site of `installModelSelection`, because it needs the `selection` ref from the same closure and must register later-with-prepend to become the outermost `agent/pre-step` listener (the harness notice listener is `{prepend:true}` at agent creation; an inner listener cannot strip what the outer appends). Known call sites: `packages/ui/tui/src/harness/driver.ts` (`withSelection`), `packages/acp/cc-acp/src/model-control.ts` (`install`). The implementation MUST re-grep `installModelSelection` across the repo; a missed entry point degrades to today's behavior (fail-soft, G5).

**Listener shape (one outermost `agent/pre-step` listener, two halves):**

```
preStep(payload, next):
  publishLiveSelection(payload.agent, selection.current)   // BEFORE next() — inner listeners read it (§5.2)
  const decision = await next()                            // inner chain, incl. harness notice append
  if (decision === undefined || decision.kind === 'reject' || decision.messages === undefined) return decision
  const assembled = pair(selection.assembled)              // same snapshot the harness compares
  const boot = moaBootDefault()                            // from the shared moa runtime state (§5.2)
  const drop = moaArmed() && assembled !== undefined && boot !== undefined && sameFields(assembled, boot)
  if (!drop) return decision
  return { ...decision, messages: decision.messages.filter(m => m.source?.kind !== 'model-selection') }
```

**Drop rule: `drop iff moa is armed AND pair(selection.assembled) == the moa boot pair`; pass through otherwise.**

- The harness emits a notice iff `assembled != header`. moa overlays iff armed, and (after §5.2) armed iff the observed live selection equals the boot pair. So under "armed AND assembled == boot", the notice's advertised continuation model is exactly what the overlay will NOT serve → phantom → drop. Every other state passes through untouched, which means: **the sanitizer is inert unless moa is actually armed and on its boot selection** — no-moa deployments, disarmed sessions, validation-failed sessions, and non-moa overlays see byte-identical harness behavior (G5).
- The `boot` used here is the SHARED moa boot pair (§5.2), not a sanitizer-local latch — the round-2 BLOCKER (sanitizer-latched bootPair diverging from the arming bootDefault under a ship-dark `/model`-before-enable) cannot occur because there is exactly one baseline, captured unconditionally.
- The sanitizer is now moa-aware by construction (same package, shared module state). That is deliberate: it removes the divergence and the no-moa false-drop. Cost: a future non-moa overlay needs its own condition/sanitizer (§9 residual).
- The sanitizer does NOT promise to keep any particular true notice: the harness's own `assembled`-snapshot timing decides when a switch notice appears at all (see §5.3's lifecycle note). The design's obligation is "never keep a phantom".

### 5.2 S2c — fix the arming observation: make "explicit /model > overlay" real (PR-1, prerequisite)

**The bug (round-1 BLOCKER, code-verified).** `decide()` (`router.ts:339-356`) feeds `arming.observeRequestModel` the **stale session request header**, guarded by "skip the observe when `header == lastAppliedPair`". In the armed steady state the header always equals the overlay pair — `buildRequest` logs the post-overlay resolved config (`agent-loop/src/agent.ts:612-633` writes `request/header` after the waterfall), and `applyModelSwitch` writes ONLY the in-memory selection (`driver-pickers.ts:98-119`, no session append). So the guard skips the observe forever, `/model` never disarms moa while overlaid, and the user's explicit choice is silently overridden. This contradicts `arming.ts`'s own module doc ("this machine always sees the user's live selection (pre-override), never moa's own overlay").

**Fix, part 1 — one unconditional boot baseline.** The boot pair is captured at the FIRST main-agent selection ever seen by the process, **regardless of `moa.enabled`**; only the arm/disarm TRANSITIONS stay gated by `enabled`. Concretely: the arming machine gains an unconditional `noteBootPair(pair)` (first non-undefined pair wins; never overwritten) and `observeRequestModel(pair)` keeps its enabled gate but no longer controls the capture. This kills the round-2 divergence: a session that starts with moa disabled, gets `/model`-ed, then enables moa still shares ONE baseline, so "selection == boot" means the same thing to the sanitizer and the machine.

**Fix, part 2 — observe the live selection before anything else, at pre-step.** The sanitizer's outer pre-step half publishes `selection.current`'s pair into the shared moa runtime state (§5.1); moa's `preStepListener` then does, as its FIRST act:

```
const live = readPublishedSelection(payload.agent)       // undefined in deployments without the sanitizer
if (live?.model !== undefined) core.arming.observeRequestModel(live)
if (!opts.validation.ok) opts.ensureArmed?.()            // per-firing retry for the mount race (index.ts:117-154)
```

This is what makes classification timing correct: with the live selection observed at pre-step, switch-away disarms BEFORE `decide()` (so no classify, no `moa: routed → …` row for a turn that will not be overlaid) and switch-back re-arms BEFORE `decide()` (so that turn IS classified and overlaid — no un-routed transition turn).

**Fix, part 3 — delete the header observe; keep a request-time observe as the always-on guarantee.** Remove the header read and the self-feedback guard from `decide()`. In the `agent/request` listener, after `await next()` and BEFORE `withTier`, on EVERY request (idempotent):

```
const resolved = await next()                       // the harness's inner listener forces selection.assembled here
if (!isSubagentAgent(payload.agent)) arming.observeRequestModel(pairOf(resolved))
```

The observed pair is pre-overlay by construction (moa applies `withTier` strictly after), so the old self-feedback trap is structurally impossible. This observe is retained even though part 2 already observes at pre-step: it keeps the arming truth correct in deployments that install `installModelSelection` WITHOUT the sanitizer (the publish is absent there), and the two observes are idempotent.

**Listener specs.** PR-1 ships BEFORE the hoist, so its `agent/request` listener must still classify (otherwise `turnTier` is always empty and moa stops routing). Two specs:

*PR-1 shape* — request listener: clause 1 (settings fast-bail) → clause 2 (subagent bail) → `const resolved = await next()` → clause 3 (observe as above) → clause 4 (`if (!arming.isArmed() || !validation.ok) return resolved`) → clause 5 mark: if the turn was classified in `decide()` (called at `isNewTurn` inside this listener, as today) apply `withTier`, else `return resolved`. `decide()` keeps `ensureArmed` (see part 2 / §5.3) but loses the header observe.

*PR-2 final shape (post-hoist)* — the request listener loses classification entirely:
1. `if (!core.readSettings().enabled) return next()` — zero-overhead default-off.
2. `if (isSubagentAgent(payload.agent)) return next()` — children own their declared models.
3. `const resolved = await next()`.
4. `if (!isSubagentAgent(payload.agent)) arming.observeRequestModel(pairOf(resolved))`.
5. `if (!arming.isArmed() || !validation.ok) return resolved` — the transition guard. **When this clause skips `withTier`, also drop any status row queued for this turn** (part 2 should have prevented the queue, but a settings change between pre-step and request can still leave one; a row advertising a tier that was not applied is a lie of the same family as the notice).
6. `if (turnTier?.turn === payload.turn) return withTier(resolved, turnTier.tier, payload.signal)`; else `return resolved` (classification miss → fail-open).

The moa-escalation retry path in `decide()` keeps its `if (!arming.isArmed()) return undefined` gate (retry turns under a disarmed machine pass through unmodified — §3.4 conformance).

**Shared state module.** The boot pair, arming machine, `validation`, and the published live selection live in a side-effect-free module (e.g. `packages/interaction/moa/src/runtime-state.ts`) imported by `index.ts` (provider), `router.ts`, and `sanitizer.ts` — so `@dsh-cc/moa/sanitizer` never imports the plugin `apply()` path.

### 5.3 S3 — classification hoist + truthful persona variables + row upgrade (PR-2)

**Hoist.** Move turn classification out of the `agent/request` listener into `router.preStepListener`, after the part-2 observe, with the harness's own admission predicate VERBATIM:

```
preStep(payload, next):
  const decision = await next()
  if (isSubagentAgent(payload.agent)) return decision                              // BEFORE any sticky commit
  if (decision.kind === 'reject' || payload.signal.aborted) return decision
  if (decision.messages.length === 0 && (payload.step === 1 || payload.messages.length > 0)) return decision
  if (payload.turn !== lastSeenTurn) { lastSeenTurn = payload.turn; turnTier = undefined; tier = await decide(payload) }
```

- Payload field names are destructured from the pre-step payload (`payload.turn`, `payload.step`, `payload.signal`, `payload.messages`) — not bare identifiers.
- **Opening availability (verified):** `capture.listener` records the map BEFORE calling `next()` (`capture.ts`: the `captured.set` happens before `return next()`), and it is registered before `router.preStepListener` (`index.ts:158` vs `:161`, same event, same priority → outer first). The inner hoisted `decide()` therefore reads a filled map. Pinned by test (P-F).
- Sticky commits happen ONLY after the admission predicate AND the subagent bail — a rejected/aborted/empty pre-step or a child never consumes a turn number.
- `pendingRows` splice stays before the classify call in the same listener; rows queued here land at the next pre-step exactly as today.
- Retry-turn routing (§3.4) and the moa-escalation provenance skip path move with `decide()` unchanged.

**Row upgrade (ships in PR-1).** The queued status row carries the pair: `moa: routed → sketch (llmbox_ant/deepseek-v4.1-flash)`. Same `source.kind:'moa'` shape, tier field, delivery mechanics.

**Persona variables.** moa registers a `system-prompt/assemble` listener (plugin-apply registration, outer relative to the harness's assemble listener; **pinned by the live-fold composition test**):

```ts
const assembled = await next()
const selectionVars = pairOf(assembled.variables)          // the harness's inner listener already wrote the selection here
const tier = tierForCurrentTurn                                   // from the last hoisted classify
if (!moaArmed() || isSubagentAgent(context.agent) || tier === undefined) return assembled   // fail-open
if (selectionVars === undefined || !sameFields(selectionVars, moaBootDefault())) return assembled  // selection is off the boot pair → moa will serve the selection → leave the harness's own variables
return { ...assembled, variables: { ...assembled.variables, ...tierRouteVariables(tier, selectionVars.effort) } }
```

- The extra `selectionVars == boot` condition is the round-2 hardening: persona and wire now share ONE invariant ("overlay applies iff the selection is on the boot pair"), evaluated at assemble time from the harness's own just-written variables and at request time by the observe. The switch-away transition step's persona/wire mismatch found in round 2 is thereby eliminated: on that step the harness variables already carry the new selection, so moa leaves them alone and the persona states exactly what clause 5 will serve.
- `tierRouteVariables(tier, carriedEffort)` is a SHARED PURE helper extracted from `withTier`'s pair/effort computation: reads the effort cache read-only (no `resolveEfforts` — no signal at assemble time), never queues notices. `carriedEffort` comes from the harness-written selection variables (i.e. `selection.assembled.reasoningEffort`). **On an effort-cache miss, leave the harness variables unchanged** (fail-open) rather than guessing — the wire's `withTier` may still keep the effort after its own fetch; the resulting one-step divergence is a documented residual (§9).

### 5.4 S4 — statusline effective display (PR-2)

Extend the existing moa statusline channel (PR #233: `packages/ui/tui/src/harness/statusline-moa.ts`, fed via `moaRef` at `driver.ts:258`) to carry the effective pair alongside the tier; render `<model-id> ◂ <tier-alias>` using the resolved tier route's model id (e.g. `deepseek-v4.1-flash ◂ sketch`) when an overlay is active, the plain selection otherwise. No new data plumbing — moa publishes through the same ref update path it uses for the tier today.

### 5.5 Decision record

- **No harness-repo edits** (read-only directive). Upstream proposal: `modelSwitchNotice` should compare against the previous selection, not the last request header. The sanitizer stays even if adopted (defense against any overlay).
- **No mutation of `ModelSelectionRef.current` from moa.** No public seam; it pollutes the user-intent surface; it would feed the arming observe a self-authored pair.
- **Hosting: subpath export `@dsh-cc/moa/sanitizer`** (round-1 revision; pending user re-ratification). The tui already depends on `@dsh-cc/moa`; `cc-acp` has no `@dsh-cc` deps and gains exactly this one. Rejected: a standalone package (full registration checklist for one module) and `@dsh-cc/model-aliases` (couples a notice concern to alias-resolution ownership, and forces a tui→compat edge).
- **No overlay registry.** The sanitizer needs `(selection ref, shared moa boot pair, moa armed)` — all available in-package (§5.1). Residual for future non-moa overlays in §9.

## 6. Probes and gates (implementation-blocking)

| Probe | Gate | Method |
|---|---|---|
| P-B ordering | the sanitizer's post-agent-creation `prepend:true` pre-step listener is outermost (sees harness-appended `model-selection` rows, and its publish precedes moa's `preStepListener`); moa's assemble listener is outer relative to the harness's | live-fold composition test (`composition.spec` rig) |
| P-C hoist safety | firings == steps (P3a re-run); hoisted classification picks the same tier as the request-time baseline on the routing mini-corpus replay; admission/subagent commits never consume a turn | rig replay + ledger diff |
| P-D truth (live A/B) | with moa armed on its boot selection: zero `kind:'model-selection'` rows in a fresh session transcript; moa row carries the pair; `/model` away → the wire serves the new selection and **no FALSE notice is kept** (do not assert "a kept true notice" — the harness's own snapshot timing decides whether one appears); `/model` back → the wire serves the boot selection on the transition turn (row suppressed or none) and overlay resumes on the next classified turn; steady overlay never disarms | transcript-gated live A/B in the moa-debug worktree |
| P-E lifecycle | within one step: pre-step observe → classify → assemble (persona == the pair the request will serve) → request | rig lifecycle test |
| P-F capture/pre-step order | a hoisted `decide()` sees the opening captured by an outer-registered `capture.listener` in the same pre-step | rig test |
| P-G baseline | session started with moa disabled, `/model`-ed, then enabled: sanitizer drop-condition and machine boot pair agree; no phantom survives and the escape hatch still works | rig + live A/B |

## 7. Test plan

1. Sanitizer: drop only under `armed && assembled == boot`; pass-through otherwise (no-moa, disarmed, validation-failed, `assembled`/`boot` undefined, `messages` undefined, reject decisions); never mutates the harness decision object (returns a copy); field comparison not identity.
2. Sanitizer wiring: co-located registration is outermost (P-B); missed entry point = documented degradation.
3. Arming: `/model` away under overlay disarms before classification (no stale `moa: routed` row) and the wire serves the new selection; switch back re-arms before classification (the transition turn IS overlaid); steady overlay never disarms; per-request observe retained (works without the sanitizer's publish); subagent requests never reach either observe; disabled start → `/model` → runtime enable shares one boot pair (P-G).
4. Hoist: admission predicate verbatim (reject / aborted / empty-first-step / emptied-continuation); subagent bail before the sticky commit; pendingRows ordering; escalation provenance; P-F opening visibility; P-C parity.
5. Persona: variables carry the tier pair only when `armed && selection vars == boot`; fail-open paths leave the harness's variables; the shared pure helper matches `withTier` pair+effort; effort-cache miss leaves the harness variables (documented residual); P-E lifecycle.
6. Statusline: `<model-id> ◂ <tier>` rendering; PR #233 tests green.
7. Invariant: `assistant/message.source.model` equals the applied overlay pair on every classified turn; clause-5 skips drop the turn's queued row.

## 8. Delivery

- **PR-1**: §5.2 arming fix (parts 1–3) + §5.1 sanitizer (subpath module + co-located registration; cc-acp gains the `@dsh-cc/moa` dep) + §5.3 row upgrade + the PR-1 listener shape. User-visible behavior changes (notices filtered, `/model` honored under overlay) → `engine.moa` manifest row update + parity regen are MANDATORY in this PR. moa README updated. If the user prefers a standalone package over the subpath host, the module moves verbatim and only the dependency wiring changes.
- **PR-2**: §5.3 hoist + persona + §5.4 statusline + tests 4–6; the moa design doc §3.2 gets the hoist amendment.
- Upstream issue filed separately; not a dependency.

## 9. Risks and residuals

- R1 The hoist touches P3a and retry-turn routing — PR isolation, P-C/P-F, §7.4. Fallback if it fails: ship PR-1 only (notices truthful, `/model` honored); the persona stays wrong on step 1 — documented, not silent.
- R2 Ordering assumptions (sanitizer outermost; moa assemble outer; capture outer-before-write) are empirical and pinned by P-B/P-F; a harness reorder turns the pins red rather than silently lying.
- R3 A future dsh-cc entry point calling `installModelSelection` without the sanitizer reintroduces phantoms there and disables the pre-step publish (the request-time observe still keeps recreation/`/model` correct) — fail-soft.
- R4 Upstream may change the notice semantics — the sanitizer matches `source.kind === 'model-selection'` (stable, module-augmented); an upstream fix lands in the pass-through branch.
- Residuals (accepted, each bounded):
  - Effort on a cold cache: the persona leaves the harness variables while `withTier` may still keep the effort after its own fetch — one step of pair-equal/effort-unequal divergence on the first request of a new tier pair.
  - A `/model` landing between a step's assemble and its request: the persona reflects the pre-switch state for that one step; clause 5 already serves the new selection.
  - A future non-moa overlay gets no persona truth and no notice filtering unless it adopts the same boot-pair invariant.
  - First step of a session's first turn may assemble before any classification exists; fail-open turns state the selection (both truthful about the wire).

## 10. Deferred

- `/model` picker header showing effective.
- Rewriting phantoms into a positive "effective model" row — the §5.3 row already carries the truth.
- Upstream adoption of the notice-semantics fix.

## 11. Review ledger

**Round 1 (v1 → v2).** critic GWC (1 BLOCKER, 2 MAJOR, 5 MINOR, 2 NIT), codex NO-GO (2 BLOCKER, 5 MAJOR, 1 MINOR), grok interrupted (auth). Adjudication: both BLOCKERs converged on "moa disarms on /model while overlaid" being unverified — orchestrator code-verification CONFIRMED the defect is real and pre-existing (header observe + self-feedback guard unreachable under overlay). Folded: §5.2 observe fix (v2), §5.1 bootPair rule, §5.2 six-clause listener, §5.3 admission predicate/helper, §5.5 registry residual, hosting revised to subpath, §7/§9 additions.

**Round 2 (v2 → v3).** critic GWC (all 10 folds OK; 3 doc findings), codex NO-GO (fold #1 PROBLEM + 1 BLOCKER + 1 MAJOR), grok NO-GO (7). Adjudication and folds:

- codex BLOCKER / grok #1 (baseline divergence: sanitizer latch vs arming capture under a ship-dark `/model`-before-enable) — CONFIRMED against `arming.ts`/`settings.ts`. Folded: one unconditional shared boot pair (§5.2 part 1), sanitizer drop rule gated on `moaArmed() && assembled == boot` (§5.1). grok's sub-point that a no-moa/disarmed return to the boot pair also dropped a true notice is fixed by the armed gate.
- codex MAJOR / grok #3 (switch-away classifies and queues a row for a turn clause 5 serves unmodified; switch-back re-arms after classification so the transition turn is un-routed) — CONFIRMED by ordering. Folded: the sanitizer publishes the live selection at the outermost pre-step BEFORE `next()`, moa observes it before `decide()`; clause 5 also drops any row queued for a skipped turn (§5.2 part 2 / clause 5).
- grok #2 (the "switch-away notice is true" proof does not hold under the pre-registered lifecycle; the switch step's notice still names the old assembled) — CONFIRMED. Folded: §5.1 no longer promises a kept true notice; P-D asserts "no FALSE notice" instead.
- grok #4 (capture ordering; subagent bail before the sticky commit) — half RESOLVED by code verification (`capture.ts` writes before `next()`; registered before `router.preStepListener`), documented with the anchor + new P-F; the subagent-bail clause folded into §5.3.
- grok #5 (PR-1 shipped the post-hoist listener spec, which would stop routing; `ensureArmed` home dropped) — CONFIRMED. Folded: separate PR-1 and PR-2 listener shapes, `ensureArmed` placed in part 2 / §5.3.
- grok #6 (persona turn id, cold effort cache, unstated carried-effort source) — CONFIRMED. Folded: `carriedEffort` from the harness-written selection variables, read-only cache, cache-miss leave-unchanged + §9 residual.
- grok #7 / critic r2 #1–3 (snippet hygiene: in-place vs copy, `messages === undefined` guard, payload destructuring, statusline string, §5.5-vs-§8 inconsistency, module that must not import `apply`; no-moa switch-back residual; `ensureArmed` home; retry-turn observe test) — folded.
- critic r2 explicitly verified all 10 round-1 folds as OK and judged the observe-the-resolved-pair fix the root-cause fix; its residual request (no-moa switch-back) is now obviated by the armed gate.
