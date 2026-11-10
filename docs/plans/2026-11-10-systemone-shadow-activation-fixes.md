# Fix Design: SystemOne consumers never dispatch in real sessions (issue #359)

- **Date**: 2026-11-10
- **Status**: implemented — issue #359, PR #360 (open, pending merge)
- **Issue**: #359
- **Affected features**: S1-03 memory-recall (`shadow`/`active`), S1-05 tool-discovery (all modes)
- **Not affected**: S1-04 memory-extraction-gate (wiring verified correct against the root bridge; dispatches at session stop, still pending live verification — no change in this PR)

## 1. Problem

With the three consumer namespaces set to `mode: "shadow"`, zero decision requests are issued in real sessions: the decision-usage ledger is never created. Two independent defects, both reproduced against a live session (details in the issue).

### 1.1 Defect A — memory recall: origin never resolvable, query polluted

`resolveRecallTurn` (`packages/memory/memory/src/recall-query.ts`) derives the decision scope origin by matching the claimed pre-step batch against persisted `user/message` events. **Three layers fail on every real TUI turn:**

1. **Genuine-message predicate is a denylist that lagged behind the injectors.** The claimed batch of a normal turn carries harness-injected messages with source kinds `cc-shell-glue`, `hooks-claude-code`, `moa` (plus `agent-instructions`/`skill-catalog` in first-turn batches) — none in `INJECTED_SOURCE_DENYLIST`. The joined "query" is notice text + user text.
2. **Persistence timing (found in three-seat review; empirically confirmed by transcript seq order).** The harness appends a turn's `user/message` events only in the request phase, **after** the `agent/pre-step` waterfall returns (`deepseek-harness` `agent.ts`: `preStep()` claims, then `step()` persists `decision.messages`). Transcript evidence (live session, turn 3): `turn/start` seq 1569 @ .083 → inbox claims @ .089–.091 → `step/start` seq 1574 @ .351 → `user/message` seq 1576–1580 @ .355–.363 → `request/header` @ .367. So at pre-step time the current turn's user message is **not** in `snapshotEvents()`.
3. **The deferred retry never fires.** The existing docstring's "waiting for a later pre-step" is dead on arrival: later steps of the same turn claim nothing new (the inbox was drained at the first claim — the only `next-step` arrivals are tool-loop notices), so a later pre-step has an empty genuine query and returns before any scan.

Net effect: `resolveRecallTurn` returns `undefined` on every real turn — `shadow` records only `skipped: no-origin` (a logger line, no ledger row), `active` returns early in `RecallCoordinator.run()`. The legacy generative selector keeps working (it never needs an origin), which masks the failure; its query is polluted by the same notice text (pre-existing, also fixed here).

### 1.2 Defect B — tool discovery: runner resolved through an unreachable name

`tool-search` is mounted at the bundle layer (`packages/bundle/cc-tui/cordis.patch.yml`) — the root realm; the cc preset deliberately cannot host that row. `hostRunnerResolver` (`packages/core/tool-search/src/discovery-contract.ts`) reads `host.systemoneDecisions`, an isolate-scoped name published inside the preset's `cc-services` group. From the root realm that lookup fails (the module-augmented property access throws without `inject`; the try/catch swallows it) ⇒ the resolver returns `undefined` on every search ⇒ `unavailable`, lexical path, no request.

`decision-usage` already republishes the service to the root realm as `ccSystemoneDecisions` precisely for out-of-group consumers (the S1-04 wiring pattern); discovery never consults it.

## 2. Fix A design

### 2.1 Genuine-message predicate: structural allowlist

Replace the denylist-based claimed-side filter with a structural predicate:

```ts
/** A claimed message is genuine user input iff its source is absent or `user`. */
function isGenuineUserMessage(message: RecallMessageLike): boolean {
  return message.source === undefined || message.source === null
    || message.source.kind === 'user'
}
```

- The harness contract ("user messages carry any producer's kind"; every injector declares its own kind) makes `user` the only genuine kind — an allowlist cannot lag behind new injectors.
- `source: {}` (present source, absent kind) is **not** genuine — the strict form r1 reviewers asked for (all three seats flagged the looser `kind === undefined` cell as asymmetric).
- `source` absent keeps the historical reading (harness messages without a source are user input).
- The query is the genuine texts joined (`\n`) with one shared block-normalization helper (non-empty text blocks only), replacing the current space-join.

This predicate feeds **both** `resolveRecallTurn` and the legacy branch's query construction (recall.ts inlines the old denylist filter today; both call sites move to one shared helper exported from `recall-query.ts`). Net legacy behavior change: the recall query becomes the user text only, instead of user text + notice text — strictly closer to the documented intent ("recall builds its query ONLY from real user input").

`INJECTED_SOURCE_DENYLIST` stays exported and is **completed** with the observed injected kinds (`cc-shell-glue`, `hooks-claude-code`, `moa`, `agent-instructions`, `runtime-context`, `skill-catalog`) as the injected-kind **inventory** — it is no longer operative for memory recall (the allowlist is), but both text tripwires (`progress-rebuild/tests/denylists.spec.ts`, `completion-gate/tests/denylist.spec.ts`) pin its membership and the export is public API. Its doc comment is rewritten accordingly ("inventory, not the genuine test"). The persisted-side `isGenuineSource` becomes dead (no more user/message scanning) and is removed.

**Sibling denylists (turn-rules `matcher.ts`, advisor-watchdog `delta.ts`) are explicitly out of scope** — severed to a follow-up issue per r1 review: completing them changes advisor review scope and rule-matching inputs without a confirmed defect, and needs its own behavioral tests. The `delta.ts` "ALL THREE copies" comment is updated to name the two remaining operative copies.

### 2.2 Origin: the turn's `turn/start` seq (replaces text matching entirely)

`resolveRecallTurn` stops matching claimed text against persisted user events — that derivation is structurally dead (§1.1 layers 2–3). Instead:

```ts
const origin = /* seq of the newest persisted `turn/start` event, scanned newest-first */
return { query, originSeq: origin }
```

Why `turn/start` is the right anchor (each property verified against the live transcript):

- **Per-turn unique and stable**: exactly one `turn/start` per turn (live session: 4 events for 4 turns); its seq never moves for the rest of the turn. This satisfies the design's own invariant "never `session.seq` — it moves with every appended event" (the reason that invariant exists is dispatch-key stability).
- **Already persisted at pre-step time**: `turn/start` is appended when the turn opens, before the first claim/pre-step (seq 1569 @ .083 vs step 1 @ .351) — the timing gap that kills user-message matching does not apply.
- **Satisfies every consumer of `originSeq`**:
  - dispatch-key dedupe `(memoryDir, sessionId, originSeq, queryHash, manifestHash, recentToolsHash, route identity)` — one stable origin per turn; a queued message claimed in a later step of the same turn dispatches under its own `queryHash`;
  - decision-usage scope validation — `Number.isSafeInteger(originSeq) && originSeq >= 0 && originSeq <= currentSeq` (`service.ts` `validateScope`); a persisted past seq only grows the watermark, so the check holds for the whole turn;
  - freshness re-checks (generation/scopeKey/idle, `recall-coordinator.ts` `isCurrent`) — stable by construction. **Same-turn repeated-input semantics (r2 adjudication, intentional):** two genuine claims with byte-identical decision inputs (same query text, manifest, recentTools, route) within one turn share the completed key and the second is suppressed — that is REQ-8's pay-once-per-key purpose, not a regression: the suppressed call would be a duplicate of an already-paid wire request. An A→B→A steer sequence re-dispatches whenever any key input changed (different tools used → different `recentToolsHash`); only a fully identical replay is deduped.
- **Fail-closed**: no `turn/start` in the snapshot (exotic pre-turn steps, broken logs) → `undefined` → no request this round, same as today's contract.
- **No text attribution at all**: the r1 finding classes "identity vs text matching" and "repeated prompt attributed to an older event" are eliminated by construction — a repeated prompt in a new turn gets the new turn's origin.

Unchanged: origin is still a persisted session-log seq; `undefined` still means "no request this round" in both modes; the query is still only genuine user text.

### 2.3 Alternatives considered (r1 review)

- **Denylist completion only**: fixes query pollution, cannot fix layers 2–3 (origin still unresolvable at pre-step). Rejected.
- **Per-genuine-message text candidates against persisted events** (v1 design): still dead on layer 2 — the current turn's user event does not exist at pre-step time, and later claims are notice-only. Rejected on codex #1 / grok #1 (cross-seat).
- **Pending-subject handoff** (keep the claimed subject, resolve when the `user/message` append lands — codex's suggested remedy): requires new pending state with cancellation/cleanup across the pre-step → persistence seam — a lifecycle obligation (and per codex, an FD-T1 re-screen trigger). `turn/start` achieves the same dispatch with zero retained state. Rejected as strictly more complex for no additional guarantee.
- **Message-id / object-identity matching**: same timing problem as text matching (the persisted row appears only after the waterfall). Rejected.
- **`session.seq` as origin**: forbidden by the S1-03 design (moves every event → a new dispatch key per step → repeated requests within one turn). Rejected.

## 3. Fix B design

`DiscoveryHostFace` gains an optional duck-typed guarded getter and the bridge name:

```ts
export interface DiscoveryHostFace {
  readonly systemoneDecisions?: { forAgent(actor: DiscoveryActor): DiscoveryRunner }
  readonly ccSystemoneDecisions?: { forAgent(actor: DiscoveryActor): DiscoveryRunner }
  /** Optional guarded service getter (structurally cordis `ctx.get`). */
  get?(name: string): unknown
}
```

`hostRunnerResolver` tries, **each step individually guarded** (per-step try/catch; a throw, an `undefined` result, or wrong-shape value degrades to the next step, never aborts resolution — r1 reviewers' remedy), with a duck-check `typeof service?.forAgent === 'function'`:

1. `host.get?.('systemoneDecisions')` — the isolated name; resolves for in-group mounts with **own-tree ownership** (r1 codex #4: a second preset tree can overwrite the root bridge while each tree keeps its isolated instance — isolated-first keeps in-group consumers on their own tree).
2. `host.get?.('ccSystemoneDecisions')` — the root-realm bridge; the real deployment shape (bundle-layer mount). From the root realm step 1 resolves `undefined` — the isolate key has no implementation in the root store (`cordis` `reflect.ts` `_getImpl`: `key = ctx[isolate][name]; impl = key && store[key]; if (!impl) return`) — so resolution falls through here; the throwing-get shape is covered by tests regardless (r2 codex #5).
3. Property fallbacks (`host.systemoneDecisions`, then `host.ccSystemoneDecisions`) — the current behavior, kept for structural hosts without a `get` seam.

In a single preset tree the bridge and the isolated name are the same instance (the bridge is a republish of the group's service); only the multi-tree case diverges, and the order above picks own-tree first. The wiring in `index.ts` is unchanged (`host: ctx as unknown as DiscoveryHostFace` — cordis `ctx.get` satisfies the duck type; `reflect.ts` confirms `get()` bypasses the property-inject requirement while respecting realms).

Out of scope: `discovery-runtime`'s `identifyRoute`/`scope()` calls operate on the bound runner and were never broken.

## 4. Formal-design screening

**Verdict: not-needed (re-affirmed after the v2 redesign).** Recorded rationale:

- Fix A v2 is a **pure derivation function change with no retained state**: query construction (allowlist predicate) + origin selection (newest `turn/start` seq). The verified model `specs/tla/memory-recall-dispatch` treats ticket arrival as nondeterministic (`Arrive(k)`) and `originSeq` as an opaque key component; the modeled protocol (REQ-1..REQ-9: key/generation/inject-commit/failure table) is untouched. Codex's r1 re-screen trigger ("a persistence handoff may introduce lifecycle obligations") does not apply: v2 has no pending state, no subscription, no waiting — the r1 concern was precisely what motivated rejecting the handoff design (§2.3).
- Fix B changes which service name a resolver reads — pure wiring; no protocol, state machine, or accounting change. The S1-05 coalescing protocol (`specs/tla/decision-gate-coalescing`, per the #353 screening) is untouched.
- No FD-T1..T4 trigger: no new actors, no ordering-sensitive shared state, no retry/timeout semantics change, no ownership/persistence change.

## 5. Tests (TDD — red first)

Fix A (`packages/memory/memory/tests/`):

- `recall-turn.spec.ts` (new, unit), all fixtures using the **real event ordering** (r1 codex #2 / grok #4: `turn/start` present, the turn's `user/message` NOT yet in the log):
  - the real-session batch shape (kinds `cc-shell-glue`/`hooks-claude-code`/`user`/`cc-shell-glue`/`moa`) resolves `{ query: <user text>, originSeq: <turn/start seq> }`;
  - the turn's user event absent from the snapshot (pre-persistence) still resolves (the v2 headline);
  - multi-genuine batch: query is the join; repeated identical text in a later turn resolves the LATER turn/start (no stale attribution);
  - same-turn repeated identical input and an A→B→A steer sequence with changed `recentTools` (r2 codex NEW): identical replay is suppressed by the completed key (pinned as intentional); a changed-tools replay dispatches;
  - multi-block normalization: multiple text blocks interleaved with empty and non-text blocks — the exact joined query asserted on the legacy, shadow and active paths (r2 codex NEW);
  - `source: {}` is not genuine; unknown injected kinds are excluded (the structural-vs-denylist discriminator);
  - injected-only batch → `undefined`; no `turn/start` in the log → `undefined`; empty-text-block user message → `undefined`;
  - the denylist inventory contains the six new kinds.
- `recall-decision-lifecycle.spec.ts` (**migrate** every existing fixture, not just extend — r2 grok #3): a `turnStart` helper replaces the `userEvent`-as-origin seeding in every dispatch case; shadow mode with the real ordering records a comparison (not `skipped: no-origin`); active mode dispatches; the legacy selector's query is the user text only.
- Doc comments rewritten in the same PR (r2 critic NEW-1 / grok NEW-1): `recall-query.ts` module docstring and `RecallTurn.originSeq` doc (origin is the turn's `turn/start` seq; the "wait for a later pre-step" retry comment is dead and removed); `recall-coordinator.ts` `run()` retry comment and `RecallTicket.originSeq` doc; `recall.ts` "legacy branch, unchanged" header claims; `specs/tla/memory-recall-dispatch/implementation.md` mechanism-mapping line for `resolveRecallTurn` (true-up only — that file is outside `inputDigest`, the verified run stays valid).

Fix B (`packages/core/tool-search/tests/`):

- contract/runtime spec on `hostRunnerResolver` directly (r1 grok #4: it is untested today): bridge-only via `get` resolves (the production shape); isolated-only via `get` resolves; property fallback preserved; a `get` that returns `undefined` for the isolated name falls through to the bridge (r2 codex #5); a `get` that throws for one name degrades to the next; a wrong-shaped bridge value (no `forAgent`) is skipped to the next step; distinct isolated/bridge instances resolve own-tree first.
- `discovery-integration.spec.ts` (extend): a real-cordis host where only the bridge name is provided at the root (the deployment shape) — a search reaches the runner (`runner.run()` observed, not just a non-fallback outcome).

Cross-package pins (already exist, must stay green): `progress-rebuild/tests/denylists.spec.ts`, `completion-gate/tests/denylist.spec.ts` — the completion-gate spec's header comment is updated to name the two remaining **operative** denylist copies (r2 critic NEW-2).

## 6. Gates

Memory + tool-search package tests; **completion-gate package tests** (the tripwire reads `recall-query.ts` text); progress-rebuild tests; `tsc -b`; static gates incl. `check:size`; capability-manifest adjudication (r2 seat divergence, resolved): **no manifest change** — the manifest's ToolSearch entry already documents the S1-05 semantic discovery layer and the memory entry already documents recall; this fix restores the code to the documented surface (no new setting, no export, no parity claim changes). `check:capabilities`/`check:parity` are run to confirm no drift, and this adjudication is recorded here rather than silently skipped (the explicit-exception option codex's r2 remedy allowed).

## 7. Residuals

- S1-04 extraction: verify after a session ends; if dead too, a separate issue.
- The claimed-batch genuine predicate assumes every injector declares a source kind with `kind !== 'user'`. A hypothetical future injector that appends source-less user messages would pollute both the old and new predicate equally — not a regression, but the residual is documented here.
- Sibling denylist completion (turn-rules, advisor-watchdog): follow-up issue.
- The Fix B integration test simulates the bridge shape without a true two-realm isolate simulation; the cross-realm throw path is covered by the per-step guard unit tests (a throwing `get` double), and the residual is accepted.

## 8. Review provenance (r1 + r2)

**r1** (three blind seats on v1): internal critic GO-WITH-CHANGES (8 findings), codex NO-GO (6), grok GO-WITH-CHANGES (7). Cross-seat same-point findings (top confidence, all folded): origin-persistence timing (codex #1 / grok #1, transcript-confirmed — drove the §2.2 redesign); predicate symmetry `kind === undefined` cell (critic #1 / codex #3 / grok #3); test fixtures pre-seeding the wrong event ordering (codex #2 / grok #4); sibling completion without tests (critic #2 / grok #6 — severed). Also folded: per-step guarded resolution with shape checks (critic #4 / grok #5), isolated-first ordering for multi-tree ownership (codex #4), alternatives section (critic #5 / grok #2), formal-design re-screen after redesign (codex — resolved by §2.3/§4), capabilities-manifest check (codex #6 — §6). Not folded as design changes: critic #6 (stale-attribution edge — eliminated by construction in v2), grok #7 (wording: `runtime-context` is a post-waterfall kind, kept in the inventory only).

**r2** (delta round, three seats on v2): critic **GO** (all 11 folds OK; NEW-1..4 = docstring/spec-header/TLA-verification/dedupe-cost hygiene — folded into §5 and §4); grok **GO-WITH-CHANGES** (fold #3 upgraded to a fixture **migration**; NEW = stale docstrings — folded); codex **NO-GO** — findings adjudicated:
- NEW-1 (same-turn repeated-input key aliasing): **adjudicated intentional** (§2.2) — suppression only fires on byte-identical decision inputs within a turn where the second wire call is a duplicate spend (REQ-8); the A→B→A-with-changed-tools case dispatches. Tests added (§5). This is the explicit per-turn-suppression approval codex's own remedy allowed.
- #5 (root-realm `get` returns `undefined`, not a throw): verified against cordis `reflect.ts` `_getImpl` — design text corrected (§3); both fallthrough shapes tested.
- #9 (capabilities manifest): seat divergence (grok: OK; codex: PROBLEM) — adjudicated no-change with recorded reasoning (§6), the explicit-exception option.
- NEW-2 (multi-block normalization coverage): restored (§5).

## 9. Residuals (carried)

(See §7; unchanged from v2 plus the r2 notes: critic NEW-4 — the `run()` local-key check does not consult `completed` before a re-scan, an accepted avoidable cost with no second request; critic NEW-3 — the TLA `implementation.md` mapping-line true-up is in §5, the model itself treats `originSeq` as opaque.)
