# effective-model-truth — Make the Harness's Model Bookkeeping Match the Wire Under Per-Request Overlays

Status: Design v2 (post round-1 review). Defect evidence live (2026-10-11, session `tui-5f6c2347`, §2); the round-1 review surfaced and this revision fixes a **pre-existing moa arming bug** (the `/model` escape hatch is unreachable while overlaid — §5.2, code-verified). Round 1: critic GO-WITH-CHANGES (10 findings), codex NO-GO (8 findings) — all folded, ledger §11; grok interrupted (auth), to be seated fresh on this revision. User decisions: classification hoist = yes; sanitizer hosting revised from "new package" to a subpath export of `@dsh-cc/moa` (§5.5 decision record — review-driven revision, pending user re-ratification).

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

- **selection** — what the user chose (`ModelSelectionRef.current` mutated by `/model`; `selection.assembled` = the per-assembly snapshot the harness itself compares and forces into request config). Unchanged semantics.
- **effective** — the pair that actually served / will serve the request: the post-waterfall resolved config, durably recorded in `request/header` and per-message `assistant/message.source.model`. These records are already correct today and are the truth source; this design makes everything else agree with THEM.

Rule of the design: nothing may rewrite `request/header` or per-message stamps; every other surface must either read the effective truth or label itself as selection.

## 4. Goals / non-goals

Goals:

- G1 The running model is never told a false identity: no injected notice claims a continuation model that will not serve, and the persona variables state the effective pair (PR-2), within the documented one-step transition residuals (§9).
- G2 User-visible surfaces distinguish selection from effective.
- G3 Zero harness-repo changes.
- G4 No regression to moa arming semantics — in fact §5.2 RESTORES the §3.1 truth table (its "explicit /model" row is currently dead code under overlay) — or the P3a `firings == steps` contract.
- G5 Fail-soft everywhere: any disabled/absent piece degrades to today's behavior, except §5.2 which is a deliberate bug fix changing (improving) today's behavior.

Non-goals: changing `/model` catalog validation; changing `request/header` / per-message stamp semantics; routing policy changes (tier ladder untouched); subagent model handling (fixed separately in PR #235).

## 5. Design

### 5.1 S2 — the model-selection notice sanitizer (PR-1)

A sanitizer module inside `@dsh-cc/moa`, exported via a clean subpath `@dsh-cc/moa/sanitizer` (exports-map entry; import graph = the installer only, not the plugin apply path):

```ts
installModelSelectionSanitizer(agentCtx: Context, selection: ModelSelectionRef): () => void
```

**Co-location (load-bearing).** Registered immediately after every dsh-cc call site of `installModelSelection`, because it needs the `selection` ref from the same closure and must register later-with-prepend to become the outermost `agent/pre-step` listener (the harness notice listener is `{prepend:true}` at agent creation; an inner listener cannot strip what the outer appends). Known call sites today: `packages/ui/tui/src/harness/driver.ts` (`withSelection`), `packages/acp/cc-acp/src/model-control.ts` (`install`). The implementation MUST re-grep `installModelSelection` across the repo and cover every dsh-cc call site; a missed entry point degrades to today's behavior (fail-soft, G5).

**Rule (delegate-first, post-`next()`).** Per-agent closure state: `bootPair` (provider+model of the first non-undefined `selection.assembled` observed) and nothing else. All pair comparisons use `selection.assembled` — the same immutable snapshot the harness's own notice uses — never the mutable `selection.current` (round-1 finding: a `current`/`assembled` race mis-classifies transition notices).

```
const decision = await next()          // inner chain completes, incl. harness's notice append
if (decision.kind === 'reject') return decision
bootPair ??= pair(selection.assembled) // captured once, lazily
if (bootPair === undefined) return decision
const keep = pair(selection.assembled) != bootPair
decision.messages = decision.messages.filter(m => m.source?.kind !== 'model-selection' || keep)
// shallow-copy the messages array; never mutate the harness decision object
```

**Why "selection left the boot default" is the right keep predicate.** The harness emits a notice iff `assembled != header` — which under overlay is every step (phantom) and around real switches (true). The notice's claim ("continues with `<assembled>`") is true exactly when no overlay will be applied to that request. moa applies an overlay iff armed, and (after §5.2) arming is armed iff the selection equals the boot default. Therefore:

- Steady overlay (`assembled == bootPair`): every notice is phantom → dropped; the moa row (§5.3) is the truth channel. ✓
- Switch away (`assembled != bootPair`): notice kept; §5.2 disarms moa at that request (observe sees the new selection pre-overlay), the wire serves the new selection — the kept notice is TRUE. The harness's own one-step snapshot semantics (a switch lands on a later assembly) already stagger the notice onto the step where the wire actually switches. ✓
- Switch back to boot default: notice dropped (phantom — moa re-arms and overlays); the moa row announces the tier + pair. ✓
- No-moa sessions: `assembled == bootPair` and header == assembled → the harness emits nothing → sanitizer inert; a genuine `/model` switch is kept (true). No regression. ✓

This rule is deliberately decoupled from moa's internals (it reads only the selection ref); it is correct for any overlay whose activity is tied to "selection == boot default" and conservative (drops) for anything else.

### 5.2 S2c — fix the arming observation: make "explicit /model > overlay" real (PR-1, prerequisite)

**The bug (round-1 BLOCKER, code-verified).** `decide()` (`router.ts:339-356`) feeds `arming.observeRequestModel` the **stale session request header**, guarded by "skip the observe when `header == lastAppliedPair`". In the armed steady state the header always equals the overlay pair — `buildRequest` logs the post-overlay resolved config (`agent-loop/src/agent.ts:612-633` writes `request/header` after the waterfall), and `applyModelSwitch` writes ONLY the in-memory selection (`driver-pickers.ts:98-119`, no session append). So the guard skips the observe forever, `/model` never disarms moa while overlaid, and the user's explicit choice is silently overridden on the wire. This contradicts `arming.ts`'s own module doc ("this machine always sees the user's live selection (pre-override), never moa's own overlay") — the implementation feeds it a stale header instead of the live pre-override pair.

**The fix.** Delete the header-based observe and its self-feedback guard from `decide()`. In the `agent/request` listener, on EVERY request (all steps — the observe is idempotent), after `await next()` and BEFORE `withTier`:

```
const resolved = await next()                       // harness's inner listener forces selection.assembled here
arming.observeRequestModel(pairOf(resolved))        // pre-overlay pair = live user selection
if (!arming.isArmed() || !validation.ok) return resolved   // ← now load-bearing on transition steps
return withTier(resolved, turnTierFor(payload.turn), payload.signal)
```

The observed pair is the harness-forced `selection.assembled` (`model-selection.ts` request listener, inner to moa) — moa's own overlay is applied strictly AFTER the observe, so it can never feed itself back and the self-feedback guard is structurally unnecessary (restoring arming.ts's documented intent). Steady state: `resolved == bootDefault` → observe is a no-op → stays armed (pin this as a regression test). `/model` away: the next request's `resolved` is the new selection → disarm → no overlay → the wire honors the user. Switch back: `resolved == bootDefault` → re-arm.

**Full request-listener spec** (after this fix and the §5.3 hoist; every clause load-bearing):

1. `if (!core.readSettings().enabled) return next()` — zero-overhead default-off.
2. `if (isSubagentAgent(payload.agent)) return next()` — children own their declared models (`agent-scope.ts`; sticky-turn/arming state must not see child requests).
3. `const resolved = await next()`.
4. `arming.observeRequestModel(pairOf(resolved))`.
5. `if (!arming.isArmed() || !validation.ok) return resolved` — no overlay. This is the transition-step guard: a turn whose classification (§5.3, pre-step) ran while armed but whose request observes a disarming selection serves the user's selection unmodified.
6. `if (turnTier?.turn === payload.turn) return withTier(resolved, turnTier.tier, payload.signal)`; else `return resolved` (classification miss → fail-open).

The moa-escalation retry path in `decide()` keeps its `if (!arming.isArmed()) return undefined` gate (retry turns under a disarmed machine pass through unmodified — §3.4 conformance, unchanged).

### 5.3 S3 — classification hoist + truthful persona variables + row upgrade (PR-2)

**Hoist.** Move the turn classification out of the `agent/request` listener into `router.preStepListener`, after `await next()`, with the harness's own admission predicate VERBATIM (do not paraphrase — an "empty continuation" and an "emptied offered continuation" differ):

```
const decision = await next()
if (decision.kind === 'reject' || signal.aborted) return decision        // no admission
if (decision.messages.length === 0 && (step === 1 || messages.length > 0)) return decision  // no admission
// admitted: commit sticky state ONLY here (a rejected/empty pre-step must not consume the turn)
if (payload.turn !== lastSeenTurn) { lastSeenTurn = payload.turn; turnTier = undefined; tier = await decide(...) }
```

- `decide()` payload adaptation: the pre-step payload `{agent, turn, step, messages, signal}` is a superset of what classification reads. The opening comes from `createOpeningCapture()` (`index.ts:158`), registered BEFORE `router.preStepListener` (`:161`) on the same event — same-event registration order guarantees the map is filled first.
- Sticky-state commits (`lastSeenTurn`, `turnTier` reset) happen ONLY after the admission predicate passes — a rejected/aborted/empty pre-step must not consume the turn number (round-1 finding).
- The pendingRows splice stays BEFORE the classify call inside the same listener: rows queued for this turn land at the next pre-step exactly as today; a row can never manufacture admission (it is appended to an already-admitted decision).
- Subagent guard (`isSubagentAgent(payload.agent)`) applies at pre-step exactly as at request time (round-1 finding: the request listener's spec must retain it — see §5.2 clause 2).
- Retry-turn routing (§3.4 of the moa design) and the moa-escalation provenance skip path move with `decide()` unchanged — they are inputs to classification, not call-site properties.

**Row upgrade (S2b, ships in PR-1).** moa's queued status row becomes `moa: routed → sketch (llmbox_ant/deepseek-v4.1-flash)` — the resolved tier pair. Same `source.kind:'moa'` shape, tier field, and delivery mechanics (queued to next pre-step). This is the model-facing truth channel on overlay turns.

**Persona variables.** moa registers a `system-prompt/assemble` listener (plugin-apply registration, outer relative to the harness's assemble listener registered at agent creation; **pinned by the live-fold composition test, not assumed**):

```ts
const assembled = await next()
if (!armed || subagent(context) || tierForCurrentTurn unknown) return assembled   // fail-open to selection
return { ...assembled, variables: { ...assembled.variables, ...tierRouteVariables(tier) } }
```

- `tierRouteVariables(tier)` is a SHARED PURE helper extracted from `withTier`'s pair/effort computation: reads the effort cache read-only, never calls `resolveEfforts` (no signal available at assemble time), never queues notices (degradation rows stay request-path-only, warn-once there). The persona states `reasoningEffort` exactly when the wire's `withTier` keeps it and omits it when the wire drops it — same helper output, both consumers pinned by test.
- Reachability (source-verified): `system-prompt/assemble` is a scope-filtered waterfall (`dsh-system-prompt/src/index.ts:626`; subject = `args[1].scope`, `dsh-scope/scoped-events.generated.ts:31`); plugin-scope `ctx.on` registration has three in-repo precedents (`browser-use-runtime/src/mcp.ts:211` — which destructures `{ agent }` from the context, `context/session-reference/src/index.ts:127`, `agent-preset-registry/src/invariant.ts:48`). `AssembleContext` is augmented by dsh-agent with `agent?: Agent` (`core/agent/src/runtime-types.ts:19-24`) — the subagent guard reads `context.agent`.

### 5.4 S4 — statusline effective display (PR-2)

Extend the existing moa statusline channel (PR #233: `packages/ui/tui/src/harness/statusline-moa.ts`, fed via `moaRef` at `driver.ts:258`) to carry the effective pair alongside the tier: render `flash ◂ sketch` when an overlay is active, plain selection otherwise. No new data plumbing — moa publishes the pair through the same ref update path it uses for the tier today.

### 5.5 Decision record — what we deliberately do NOT do

- **No harness-repo edits** (read-only directive). The upstream defect — `modelSwitchNotice` compares the selection against the last request header instead of the previous selection — is filed as an upstream issue with a one-line semantic fix. The sanitizer stays even if adopted upstream (defense against any overlay source).
- **No mutation of `ModelSelectionRef.current` from moa.** No public seam from a plugin; it would pollute the user-intent surface; it would trip the arming observe (now correctly fed, a mutated ref would look like a user choice — the original self-feedback trap in a new costume).
- **No overlay-registry service.** The sanitizer needs only `(selection ref, bootPair)`; the persona fix needs moa-local `turnTier`; the statusline reuses the PR #233 channel. A registry would be a second source of truth for a fact the transcript already records. Residual (accepted, §9): a future non-moa overlay gets notice cleanup only if its activity follows "selection == boot default", and no truthful persona — out of scope until a second overlay exists.
- **No new package.** Round-1 revision (originally ratified as a new `@dsh-cc/model-truth` package): the tui already depends on `@dsh-cc/moa`, and `cc-acp` has zero `@dsh-cc` dependencies — hosting in moa via a subpath export (`@dsh-cc/moa/sanitizer`) costs one new dep edge (cc-acp → moa) instead of the full new-package registration (preset row, composition pin, manifest, parity, README trio, size gate). Rejected alternative host `@dsh-cc/model-aliases`: it would force a tui→compat-package dependency for a notice concern and couple sanitization to alias-resolution ownership. Pending user re-ratification (the original decision was "independent package").
- **No suppression of genuine switch notices** — the bootPair rule keeps every notice the harness emits while the selection is off the boot default (all true after §5.2); the only true notices it can drop are the documented transition residuals in §9.

## 6. Pre-registered probes and gates (implementation-blocking)

| Probe | Gate | Method |
|---|---|---|
| P-B ordering | a post-agent-creation `prepend:true` pre-step listener is outermost and sees harness-appended `model-selection` rows in `decision.messages`; moa's assemble listener is outer relative to the harness's | live-fold composition test, same rig pattern as `composition.spec` |
| P-C hoist safety | firings == steps preserved (P3a re-run); hoisted classification picks the same tier as request-time classification on the routing mini-corpus replay; the admission predicate rejects/aborts/empty paths never consume a turn | rig replay + ledger diff |
| P-D end-to-end truth | with moa armed: zero `kind:'model-selection'` rows in a fresh session's transcript; moa row carries the pair; `/model` away → **wire serves the new selection** (arming fixed) → the one kept notice is true; `/model` back to boot → re-arms, phantoms dropped again; steady overlay never disarms (regression pin for §5.2) | live A/B in the moa-debug worktree, transcript-gated |
| P-E lifecycle | within one step: pre-step classify → assemble (persona variables carry the tier pair) → request (wire carries the same pair) | rig lifecycle test (round-1 finding: nesting ≠ lifecycle ordering) |

## 7. Test plan

1. Sanitizer unit: phantom drop in steady overlay; keep-on-switch-away (true); drop-on-switch-back (phantom); effort-only no-op; reject decision untouched; undefined `assembled`/`bootPair` pass-through; the drop shallow-copies messages.
2. Sanitizer wiring: co-located registration is outermost (P-B); a missed entry point is a documented degradation.
3. Arming fix (§5.2): `/model` away under overlay disarms at the next request and the wire serves the new selection (transition-step guard is load-bearing — pin it); switch back re-arms; mid-turn switch takes effect on the next step (per-step observe); steady overlay never disarms (`resolved == bootDefault` no-op pin); sticky-turn unaffected; escalation retry under a disarmed machine passes through; subagent requests never reach the observe.
4. Hoist (§5.3): admission predicate verbatim (reject / aborted / empty-first-step / emptied-continuation cases each never consume a turn); pendingRows ordering; escalation provenance; subagent guard at pre-step; classification parity with the request-time baseline (P-C).
5. Persona (§5.3): variables carry the tier pair when classified; fail-open paths leave the selection; the shared pure helper gives persona and wire identical pair+effort (including the degradation drop); P-E lifecycle.
6. Statusline: effective ◂ tier rendering; PR #233 tests green.
7. Invariant (already true today, now pinned): `assistant/message.source.model` equals the applied overlay pair on every classified turn.

## 8. Delivery

- **PR-1**: §5.2 arming observation fix + §5.1 sanitizer (subpath export, co-located registration at both `installModelSelection` call sites; cc-acp gains the `@dsh-cc/moa` dep) + §5.3 row upgrade. User-visible behavior changes (notices filtered, /model honored under overlay) → `engine.moa` manifest row update + parity regen are MANDATORY in this PR (manifest policy). moa README updated.
- **PR-2**: §5.3 hoist + persona overlay + §5.4 statusline + tests 4–6. The moa design doc §3.2 gets the hoist amendment.
- Upstream issue filed separately; not a delivery dependency.

## 9. Risks and residuals

- R1 The hoist touches P3a and retry-turn routing — PR isolation, P-C pre-registration, §7.4. Fallback if the hoist fails: ship PR-1 only (notices truthful, /model honored); the persona stays wrong on step 1 — documented, not silent.
- R2 Ordering assumptions (sanitizer outermost; moa assemble outer) are empirical — pinned by live-fold tests; a harness reorder turns the pins red rather than silently lying.
- R3 A future dsh-cc entry point calling `installModelSelection` without the sanitizer reintroduces phantoms there — fail-soft; the re-grep is on the implementation checklist.
- R4 Upstream may change the notice semantics — the sanitizer matches `source.kind === 'model-selection'` (stable, module-augmented); an upstream fix lands in the pass-through branch where notices are true.
- Residuals (accepted, each one step or one notice):
  - On a mid-turn `/model`, the step's persona may state the tier pair while the wire serves the new selection (assemble precedes the request-time observe; §5.2 clause 5 catches the wire, not the already-assembled persona).
  - On the moa settings-disable transition, the first true convergence notice is dropped (`assembled == bootPair`); persona and picker status carry the truth.
  - On a resume whose boot default differs from the persisted header, the first true convergence notice is dropped (same rule).
  - First step of a session's first turn may assemble before any classification exists; fail-open turns (classification failed) state the selection.
  - A future non-moa overlay gets notice cleanup only, not a truthful persona (§5.5).

## 10. Deferred

- `/model` picker header showing effective.
- Rewriting (not just dropping) phantoms into a positive "effective model" row — the §5.3 row already provides the truthful statement.
- Upstream adoption of the notice-semantics fix.

## 11. Review ledger

**Round 1 (2026-10-11, v1 → v2).** Seats: critic GO-WITH-CHANGES (1 BLOCKER, 2 MAJOR, 5 MINOR, 2 NIT); codex NO-GO (2 BLOCKER, 5 MAJOR, 1 MINOR); grok interrupted (auth) before any judgment — to be seated fresh on v2. Dispositions (all folded into v2):

- Both seats' BLOCKERs (critic 1; codex 1/2) converged on one unverified assumption: "moa disarms on /model while overlaid". Orchestrator code-verification CONFIRMED the defect is real and pre-existing: the header-based observe + self-feedback guard makes disarm unreachable in the armed steady state (§5.2). Fix: observe the pre-overlay resolved pair, delete the guard. This supersedes v1's "moa disarms independently" justification.
- Critic 2 / codex 1 (switch-back keeps a false notice): fixed by the bootPair keep-predicate (§5.1) — keep iff `assembled != bootPair`.
- Codex 3 (`current` vs `assembled` race): the sanitizer now compares `selection.assembled` only (§5.1).
- Codex 4 (nesting ≠ lifecycle; G1 first-step residual): P-E lifecycle probe added; G1 reworded with the residual scope.
- Codex 5 / critic 3 (admission predicate, subagent guard, fast bail in the request listener): §5.2 full listener spec + §5.3 verbatim predicate + commit-after-admission.
- Codex 6 (PR-1 not independently safe): §5.2 arming fix moved INTO PR-1 as a prerequisite.
- Critic 4 (effort helper side effects): shared pure helper spec, read-only, no queueNotice, degradation parity pinned (§5.3).
- Critic 5 (persona/wire transition window): §9 residual.
- Critic 6 / codex 7 (registry-drop cost): §5.5 residual + narrowed guarantee.
- Critic 7 / codex 8 (package hosting, checklist inconsistency): hosting revised to a `@dsh-cc/moa` subpath export; the eight-gate new-package checklist is deleted; manifest/parity made mandatory in PR-1 (§8).
- Critic 8/9/10 (pseudocode closure state, isArmed wording, missing tests): §5.1 closure-state spec, §5.2 clause 5 wording ("load-bearing" now true), §7 test additions.
