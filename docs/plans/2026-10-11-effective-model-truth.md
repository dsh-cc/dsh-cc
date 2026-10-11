# effective-model-truth — Make the Harness's Model Bookkeeping Match the Wire Under Per-Request Overlays

Status: Design. The defect evidence is live (2026-10-11, session `tui-5f6c2347`, ledger in §2); assemble-dispatch reachability resolved at source level (§5.3); remaining pre-registered probes P-B–P-D (§6); three-lane blind review in progress (ledger §11). User decisions ratified: classification hoist (§5.3) = yes; new package `@dsh-cc/model-truth` = yes (slimmed to the sanitizer installer only — see §5.5 decision record).

## 1. Goal and scope

When moa (or any future per-request model overlay) is active, three user-visible and model-visible surfaces currently lie about which model is serving the session:

1. The harness's `[model changed: …]` notice claims "the session continues with `<selection>`" while the wire runs the overlaid pair — re-emitted at nearly every step (session `tui-5f6c2347`: seq 54/93/130/172/201/230/256/281/308/325/353, one per step of turn 1).
2. The system-prompt identity ("You are a coding agent powered by `<model>`") says the session selection, not the model actually generating.
3. The statusline model segment shows the selection.

This design makes every surface either tell the truth or explicitly distinguish **selection** (user intent, owned by harness `ModelSelectionRef`) from **effective** (the pair that actually serves the request, owned by whoever overlays).

Scope: dsh-cc only. The harness repo is read-only by directive; an upstream proposal is filed separately and is NOT a dependency (§5.5).

## 2. Evidence (live, 2026-10-11, worktree moa-debug)

Source: `~/.dsh/sessions/--…moa-debug--/tui-5f6c2347-…/session.v4.jsonl.zstd`, decompressed and event-typed:

- 12/12 `assistant/message` events carry `message.source.model = llmbox_ant/deepseek-v4.1-flash` (turn 1, steps 1–12). Zero glm-5.3.
- The single `request/header` records `config = {provider: orchestrix, model: llmbox_ant/deepseek-v4.1-flash, reasoningEffort: max}`.
- moa's status row (seq 53): `{"kind":"moa","form":"notice","summary":"moa: routed → sketch","tier":0}` — sketch tier → lane peer `haiku` → the user's `haiku` alias = deepseek-v4.1-flash (`cc-model-aliases/src/resolver.ts:58-64`).
- Harness `model-selection` notices (seq 54 onward): `summary "llmbox_ant/deepseek-v4.1-flash → llmbox_ant/glm-5.3"` — one per step, never converging.

Root cause (code-anchored):

- moa overlays the `agent/request` return value post-`next()` (`packages/interaction/moa/src/router.ts:210 withTier`, applied at `:381`/`:389`). Its listener registers at plugin apply (t0, no prepend) and is therefore OUTER relative to the harness's `installModelSelection` request listener, which registers at agent creation (t1, no prepend) and re-forces `selection.assembled` — the overlay wins on the wire (proven by the header above).
- The harness's notice listener (`deepseek-harness packages/core/agent/src/model-selection.ts:117-126`, registered `{prepend:true}`) compares `selection.assembled` (glm-5.3) with `agent.session.requestHeader()?.config` (flash — the post-overlay wire truth) at `:121`. Under an overlay these never converge, so the notice re-fires every step.
- The harness's assemble listener (`model-selection.ts:82-95`) writes `variables.provider/model` from `selection` — the persona therefore states the selection, not the effective model.

## 3. Concepts

- **selection** — what the user chose (`ModelSelectionRef.current/assembled`; boot-seeded from `agent-default-model`, mutated by `/model`). Unchanged semantics.
- **effective** — the pair that actually served / will serve the request: the post-waterfall resolved config, durably recorded in `request/header` and per-message `assistant/message.source.model`. These records are already correct today and are the truth source; this design makes everything else agree with THEM.

Rule of the design: nothing may rewrite `request/header` or per-message stamps; every other surface must either read the effective truth or label itself as selection.

## 4. Goals / non-goals

Goals:

- G1 The running model is never told a false identity: no injected notice claims a continuation model that will not serve, and the persona variables state the effective pair (PR-2).
- G2 User-visible surfaces distinguish selection from effective.
- G3 Zero harness-repo changes.
- G4 No regression to moa arming semantics (§3.1 truth table, overlay self-feedback guard) or the P3a `firings == steps` contract.
- G5 Fail-soft everywhere: any disabled/absent piece degrades to today's behavior.

Non-goals: changing `/model` catalog validation; changing `request/header` / per-message stamp semantics; routing policy changes (tier ladder untouched); subagent model handling (fixed separately in PR #235).

## 5. Design

### 5.1 S2 — `@dsh-cc/model-truth`: the model-selection notice sanitizer (PR-1)

New small package `packages/interaction/model-truth` exporting one installer:

```ts
installModelSelectionSanitizer(agentCtx: Context, selection: ModelSelectionRef): () => void
```

**Co-location (load-bearing).** It is registered immediately after every dsh-cc call site of `installModelSelection`, because it needs the `selection` ref from the same closure and must register later-with-prepend to become the outermost `agent/pre-step` listener (the harness notice listener is `{prepend:true}` at agent creation; an inner listener cannot strip what the outer appends). Known call sites today: `packages/ui/tui/src/harness/driver.ts:103`, `packages/acp/cc-acp/src/model-control.ts:63`. The implementation MUST re-grep `installModelSelection` across the repo and cover every dsh-cc call site; a missed entry point degrades to today's behavior (fail-soft, G5).

**Rule (delegate-first, post-`next()`):**

```
const decision = await next()                      // inner chain completes, incl. harness's notice append
if (decision.kind === 'reject') return decision
let last = <pair of selection.current>             // per-agent closure state, provider+model only
const now = pair(selection.current)
const header = agentCtx.session.requestHeader()?.config
for each message in decision.messages:
  if source.kind === 'model-selection':
    if (now changed since last)  keep        // genuine /model switch → harness notice is true
    else if (header pair !== now) drop       // phantom: harness will claim a switch that will not happen
    else keep
last = now
```

Why this is exactly right:

- The harness emits the notice iff `selection != header` (`model-selection.ts:121-123`). Under an overlay the header is the overlay pair, so the notice claims "continues with selection" while the next request will be overlaid again — the precise phantom condition is `selection unchanged AND header != selection`.
- A genuine `/model` switch changes `selection.current` before the next pre-step (the TUI/ACP pickers mutate the ref synchronously on user action), so the change detector passes the notice through. moa disarms independently on the pair change (§3.1 truth table), after which header converges to selection and the harness stops emitting — the sanitizer becomes a no-op. Re-arming (switch back to boot default) reintroduces phantoms, which the sanitizer drops again. Both directions are self-consistent without any coupling to moa.
- **Decoupling**: the rule uses only the `selection` ref and `requestHeader()` — it works for ANY overlay source (current or future), not just moa, and is inert when no overlay exists.

Effort-only selection changes are ignored (pair comparison is provider+model, matching `sameRoute` in `model-selection.ts:38`), so effort-only churn neither drops nor keeps anything the harness would not have emitted anyway.

### 5.2 S2b — moa status row carries the pair (PR-1)

Upgrade moa's queued status row (`router.ts` `queueNotice`) from `moa: routed → sketch` to `moa: routed → sketch (llmbox_ant/deepseek-v4.1-flash)` — the resolved tier pair from `withTier`'s applied route. This gives the model, one step later, a truthful in-context statement of what served the turn. The existing `source.kind:'moa'` shape, tier field, and delivery mechanics (queued to next pre-step, `preStepListener` splice) are unchanged.

### 5.3 S3 — Classification hoist + truthful persona variables (PR-2)

Two coupled changes; the hoist exists to make the persona fix possible on step 1 of a turn.

**Hoist.** Move the turn classification call out of the `agent/request` listener (`router.ts:368` `listener`, the `isNewTurn` branch) into `router.preStepListener` (`:397`), after `await next()`:

- Classify only when the decision is real (`kind !== 'reject'`, non-empty messages — same emptiness guard the harness notice listener uses) and `payload.turn !== lastSeenTurn` (sticky-turn logic unchanged, now keyed on pre-step turn numbers, which are the same numbering).
- `classifyOnce` payload adaptation: pre-step payload carries `{agent, turn, step, messages, signal}` — a superset of what `classifyOnce` reads (turn, signal). The opening comes from `createOpeningCapture()` (`index.ts:158`), which is registered BEFORE `router.preStepListener` (`:161`) on the same event and therefore fills the map first (same-event registration order). Subagent guard (`isSubagentAgent`) applies at pre-step exactly as at request time.
- The `agent/request` listener degenerates to: apply the stored `turnTier` via `withTier`, re-checking `isArmed()` at request time. **The request-time armed re-check is load-bearing**: on a `/model`-switch transition step the classification may already have run at pre-step while armed; the request listener must not overlay a disarmed turn (§6 precedence: explicit user choice > overlay).
- Retry-turn routing (§3.4 of the moa design) and the moa-escalation provenance skip path move with `decide()` unchanged — they are inputs to classification, not call-site properties.
- `queueNotice` timing is unchanged: classify inside pre-step (after the pendingRows splice has already run) → the row lands at the next pre-step, exactly as today.

**Persona variables.** moa registers a `system-prompt/assemble` listener (process-level `ctx.on`, same registration position as its other listeners — plugin apply, hence outer relative to the harness's assemble listener registered at agent creation; **must be pinned by the live-fold composition test, not assumed**):

```ts
const assembled = await next()
if (!armed || subagent || tier-for-current-turn unknown) return assembled   // fail-open to selection
return { ...assembled, variables: { ...assembled.variables, provider, model, reasoningEffort? } }
```

The provider/model/effort triple MUST be computed by the SAME helper `withTier` uses (extract the effort-degradation logic from `router.ts:210-245` into a shared function) so the persona and the wire request can never diverge. Fail-open paths (classification failure, unknown tier, first step before any classification could run) leave the variables at the selection — documented residual, not silent.

**Reachability (source-verified, was probe P-A)**: `system-prompt/assemble` is a scope-filtered waterfall (`dsh-system-prompt/src/index.ts:626` dispatches via `ctx.waterfall(scopeTarget(this, scope), …)`; routing subject = `args[1].scope`, `dsh-scope/scoped-events.generated.ts:31`). Plugin-scope `ctx.on` registration is an established harness pattern with three in-repo precedents (`browser-use-runtime/src/mcp.ts:211` — which also destructures `{ agent }` from the context, `context/session-reference/src/index.ts:127`, `agent-preset-registry/src/invariant.ts:48`). The context carries the assembling agent: `AssembleContext` is augmented by dsh-agent with `agent?: Agent` ("Agent for this assembly; absent on diagnostics", `core/agent/src/runtime-types.ts:19-24`) — so the subagent guard (`isSubagentAgent(context.agent)`) is implementable directly. The residual live probe (now a wiring test pin, not an open question): moa's listener is OUTER relative to the harness's assemble listener (registration order: plugin apply < agent creation), so moa's post-`next()` variable override wins — must be pinned by the live-fold composition test, not assumed.

### 5.4 S4 — statusline effective display (PR-2)

Extend the existing moa statusline channel (PR #233: `packages/ui/tui/src/harness/statusline-moa.ts`, fed via `moaRef` at `driver.ts:258`) to carry the effective pair alongside the tier: render `flash ◂ sketch` (effective ◂ tier) when an overlay is active, plain selection otherwise. No new data plumbing: moa already knows the pair it applied; it publishes through the same ref update path it uses for the tier today.

### 5.5 Decision record — what we deliberately do NOT do

- **No harness-repo edits** (read-only directive). The upstream defect — `modelSwitchNotice` compares the selection against the last request header instead of the previous selection, so any overlay makes it fire forever — is filed as an upstream issue with a one-line semantic fix (compare against the previous *selection*, or latch after first emission). The sanitizer stays even if adopted upstream (defense against any overlay source).
- **No mutation of `ModelSelectionRef.current` from moa.** Three reasons: no public seam from a plugin; it would pollute the user-intent surface `/model` depends on; it would trip the arming machine's `observeRequestModel` self-feedback guard (overlay pair observed as a "user choice" → self-disarm — the exact trap pinned in `harness-runtime-seams-inventory`).
- **No overlay-registry service.** The original sketch had `modelTruth.observe()/effective()` as a runtime registry. Detailed design showed the sanitizer needs only `(selection ref, requestHeader)` (§5.1), the persona fix needs only moa-local `turnTier` (§5.3), and the statusline reuses the PR #233 channel (§5.4) — a service would be a second source of truth for a fact the transcript already records. Dropped; the package keeps only the installer. (Ratified as "independent small package"; the package survives, slimmer.)
- **No suppression of genuine switch notices** — the change-detector rule passes them through by construction (§5.1).

## 6. Pre-registered probes (gates for implementation)

| Probe | Gate | Method |
|---|---|---|
| P-A assemble dispatch | RESOLVED at source level (§5.3): scope-filtered dispatch with `AssembleContext.agent`; plugin-scope registration has three in-repo precedents. Residual live pin folded into P-B's rig | wiring test: moa assemble listener fires for the main agent, receives `context.agent`, is outer relative to harness's assemble listener |
| P-B sanitizer + assemble ordering | a post-agent-creation `prepend:true` pre-step listener is outermost and sees harness-appended `model-selection` rows in `decision.messages`; moa's assemble listener is outer relative to the harness's | live-fold composition test, same rig pattern as `composition.spec` |
| P-C hoist safety | firings == steps preserved (P3a re-run); hoisted classification picks the same tier as request-time classification on the routing mini-corpus replay; reject/empty-decision paths classify on a later step of the same turn, never cross-turn | rig replay + ledger diff |
| P-D end-to-end truth | with moa armed: zero `kind:'model-selection'` rows in a fresh session's transcript; moa row carries the pair; `/model` switch away → disarm → harness notice passes through and is TRUE; switch back → re-arm → phantoms dropped again | live A/B in the moa-debug worktree, transcript-gated |

## 7. Test plan

1. Sanitizer unit: phantom drop / genuine pass / effort-only no-op / reject decision untouched / first-step bootstrap (no header → nothing to drop).
2. Sanitizer wiring: co-located registration is outermost (live-fold pin, P-B); a missed entry point is a documented degradation, not a failure.
3. moa row: pair present; unchanged shape otherwise (`subagent-scope.spec` guards must stay green).
4. Hoist: P3a `firings == steps` re-pinned; sticky-turn; subagent guard at pre-step; reject/empty path; transition-step guard (request-time `isArmed()` re-check) — the `/model`-mid-turn case must NOT be overlaid.
5. Assemble overlay: persona variables carry the tier pair when classified; fail-open paths leave selection; effort helper shared with `withTier` (single implementation, both consumers pinned).
6. Statusline: effective ◂ tier rendering; no regression to PR #233 tests.
7. Invariant (already true today, now pinned): `assistant/message.source.model` equals the applied overlay pair on every classified turn.

## 8. Delivery and registration checklist

- **PR-1** (low risk): `@dsh-cc/model-truth` package (sanitizer installer only) + registration at both `installModelSelection` call sites + moa status-row pair. Manifest/parity untouched unless review demands (no CC-surface change; notice filtering is moa-adjacent behavior — `engine.moa` row gets a wording update, parity regen).
- **PR-2** (architecture-sensitive): classification hoist + persona overlay + statusline effective + §7.4/§7.5/§7.6 tests. Design-doc §3.2 of the moa plan gets the hoist amendment.
- New-package checklist (all eight): preset row in `packages/preset/cc/agent.cordis.yml` → `composition.spec.ts` pin → `docs/claude-code-capabilities.yaml` → `pnpm docs:parity` regen → README trio → `check:size` gate name → harness-package devDeps declared in specs → lockfile timing (edit deps before the final `pnpm install`).
- Upstream issue filed separately (harness `model-selection.ts` notice semantics); not a delivery dependency.

## 9. Risks and residuals

- R1 The hoist touches the P3a contract and retry-turn routing — mitigated by PR isolation, P-C pre-registration, and full §7.4 port of the escalation-provenance tests. If review or probes fail the hoist, the fallback (documented) is: skip §5.3 persona fix, ship S2/S2b only — the model's identity stays wrong on step 1 but no notice lies.
- R2 Ordering assumptions (sanitizer outermost; moa assemble outer) are empirical facts about registration order — pinned by live-fold tests, and any harness change that reorders them turns the pins red rather than silently lying.
- R3 A future dsh-cc entry point that calls `installModelSelection` without the sanitizer reintroduces phantoms there — fail-soft, and the grep step in §5.1 is part of the implementation checklist.
- R4 Upstream may change the notice text/kind — the sanitizer matches `source.kind === 'model-selection'` (stable, module-augmented), not prose; a semantic upstream change lands in the pass-through branch where notices are true.
- Residual (accepted): on fail-open turns (classification failed) the persona still states the selection; the first step of the very first turn of a session may assemble before any classification exists.

## 10. Deferred

- `/model` picker header showing effective (S4 minimal cut covers statusline only).
- Generalizing the sanitizer to rewrite (not just drop) phantoms into a positive "effective model" row — S2b's moa row already provides the truthful statement; a second row per step would be noise.
- Upstream adoption of the notice-semantics fix (then delete the drop rule, keep the package as a no-op shell or retire it).

## 11. Review ledger

(To be filled per round: seat, verdict, findings, fold status.)
