# SystemOne decision runtime, budget and metering

Status: implemented (#351); amended 2026-11-10 — decision routes unified on the gauge alias (PR pending). Feature ID: S1-02. Priority: P0.

Source baseline: `31fb29eb77148e92ca8da365adcbf4994622a31d`. Depends on [S1-01](2026-11-02-systemone-01-contract-validation.md), other features can be developed in parallel against test fakes of this interface. Entry point: [overview](2026-11-02-systemone-00-overview.md).

## Formal design

- mode: auto (session-adopted; no formal-design screening clause in the
  project rules at this revision; adoption snippet at
  `<skill>/references/agents-snippet.md`).
- decision: **enabled**
- triggerIds: FD-T2 (429 retries re-reserve; a permit never serves two
  attempts), FD-T3 (crash recovery decides whether an unpaired reserve
  keeps its full amount — dedup and persistence order in the JSONL
  ledger), FD-T4 (the quota.lock file is cross-crash resource ownership
  only a human clears), FD-L2 (reserve = settled + in-flight conservation
  with unknown retained as an upper bound).
- backends: `["tla", "lean"]`, modelDirs: `{"tla":
  "specs/tla/decision-runtime-quota", "lean":
  "specs/lean/decision-quota-accounting"}`.
- rationale: the shared runtime every other feature calls; its properties
  (single-invocation settlement, no free quota across crash, torn-tail
  freeze, lock-guarded check-then-append) decide implementation
  atomicity. Model results are recorded in the model directories; one
  implementer-relevant conclusion from the TLA+ model: the transaction
  lock must cover every ledger append (reserve, dispatch and settle rows
  alike) and the freeze must be computed inside that lock.

## Problem

Today [`systemoneDecide`](../../packages/llm-tuning/systemone/src/client.ts) returns usage but has no unified feature attribution, budget admission or lifecycle record. MOA and permissions each record their own business outcome; [`foldCost`](../../packages/session/command-cost/src/cost.ts) instead aggregates generative-model cost from request/header and assistant/message. New decision calls that follow this scattered approach cannot compute the true cost including fallbacks, failures and retries.

This feature provides an injectable native decision executor that serves new features uniformly. SystemOne usage must never be recorded as generative assistant/message records, and assistant/message must never be passed off as the SystemOne meter. v1 does not migrate existing permission/MOA legacy calls; the new MOA v2 mode uses this runtime. Legacy calls remain explicitly labelled "not in the decision ledger", and no claim of a complete total is allowed.

## Architecture and files

A pure executor plus a host adapter plugin. Letting the client read settings/fs directly would couple a pure transport module to the runtime; letting each feature do its own accounting makes unified retry and concurrency impossible.

| File | Responsibility |
|---|---|
| New `packages/llm-tuning/systemone/src/decision.ts` | Types below and `createDecisionRunner(deps)`, no Cordis/fs dependency |
| New `decision-hash.ts` in the same directory | canonical JSON, full SHA-256, input estimation |
| Modify `client.ts` in the same directory | optional attempt observer, optional maxRetries; defaults keep legacy behaviour |
| New `packages/observability/decision-usage` package | optional `ctx.systemoneDecisions` service, settings, routing, ledger and admission adapter |
| New `src/{index,settings,ledger,quota,route}.ts` in that package | mount, settings, JSONL, durable quota, alias/pin route resolution respectively |
| Modify `packages/session/command-cost/src/{index,cost}.ts` | load the decision ledger asynchronously, show its cost and unpriced/unknown usage separately |
| Modify `packages/preset/cc` and the compose files of related bundles | mount the service; the service itself never triggers a request |
| Modify packages/observability/sidecar-io | hoist the session-directory encodeSegment helper into sidecar-io as a new export (the S1-02 ledger path uses it; the existing copies in config-snapshot and vwa-evidence remain until their own migrations) |

New package runtime dependencies declare `@dsh-cc/systemone`, `@dsh-cc/model-aliases`, `@dsh-cc/settings-ns`, `@dsh-cc/settings-provider`, `@dsh-cc/sidecar-io` and the harness/cordis packages actually used, with `workspace:^` for workspace packages. Update the workspace lock, tsconfig paths/project references and published exports in sync; deep imports of sibling `src` that are not declared as dependencies are forbidden.

## Public interface

The following is the only shared contract in this design set. New features obtain a `DecisionRunner` through the optional service; a missing service is equivalent to unavailable/unconfigured. Features use the fixed identifiers from the overview and must not contain paths or user text. `DecisionFeature` is the closed kebab-case union for this design set (used by both the request and the permit input):

```ts
type DecisionFeature =
  | 'memory-recall' | 'memory-extraction' | 'tool-discovery'
  | 'skill-recommendation' | 'support-triage' | 'audit-shortlist'
  | 'moa-context-routing' | 'moa-acceptance' | 'summary-gate'
  | 'reducer-gate';
```

```ts
interface DecisionScope {
  projectKey: string;
  sessionId: string;
  agentId: string;
  originSeq: number;
}
interface DecisionRequest {
  feature: DecisionFeature;
  mode: 'shadow' | 'active';
  routeAlias: string;
  questionVersion: string;
  policyVersion: string;
  scope: DecisionScope;
  state: unknown;
  questions: Record<string, SystemOneQuestion>;
  timeoutMs: number;
  maxInputTokens: number;
  signal: AbortSignal;
}
type DecisionRun =
  | { status: 'answered'; answers: Record<string, SystemOneAnswer>;
      model: string; usage: SystemOneUsage; decisionId: string; inputHash: string }
  | { status: 'unavailable'; reason: 'unconfigured' | 'budget' | 'timeout'
      | 'cancelled' | 'malformed' | 'error'; decisionId: string };
interface DecisionRouteIdentity {
  provider: string; model: string; revision: string;
  perRequestTokens: number; perQuestionTokens: number;
  maxQuestions: number; maxOutputTokens: number;
}
interface DecisionRunner {
  identifyRoute(alias: string, scope: DecisionScope): DecisionRouteIdentity | undefined;
  run(request: DecisionRequest, options?: {
    budgetPermit?: DecisionBudgetPermitProvider;
  }): Promise<DecisionRun>;
}
interface BoundDecisionRunner extends DecisionRunner {
  scope(originSeq?: number): DecisionScope;
}
interface DecisionBudgetPermitProvider {
  reserve(input: {
    decisionId: string; scope: DecisionScope; feature: DecisionFeature; attempt: number;
    inputTokens: number; outputTokens: number; signal: AbortSignal;
  }): Promise<DecisionBudgetPermit | undefined>;
}
interface DecisionBudgetPermit {
  settle(outcome:
    | { kind: 'actual'; usage: SystemOneUsage }
    | { kind: 'unknown' }
    | { kind: 'not-dispatched' }
  ): Promise<void>;
}
```

`model-version-mismatch` and `accounting-overrun` are ledger reasonCodes, not DecisionRun reasons: both surface as `unavailable` with the reasonCode recorded in the row.

The deps of `createDecisionRunner(deps)` are `validateScope(scope)`, `resolveRoute(alias,scope)`, `reserveGlobal` (same provider shape), `append(row)`, `now()`, `uuid()` and `fetchImpl`. All are supplied by the constructor; tests need no real settings, files or models. Any dependency exception is folded into unavailable and must not escape into the agent waterfall.

The host service exposes `forAgent(agent: Agent): BoundDecisionRunner`; BoundDecisionRunner adds `scope(originSeq?: number): DecisionScope` on top of the pure interface above. Every business wrapper first obtains a binder from the real exec/invocation/capture Agent, then calls scope; when the argument is omitted it captures `Number(agent.session.seq)` synchronously and must never use the event-array length. Tests may inject a pure DecisionRunner and a fixed scope directly.

The service allocates a process-wide UUID agentId per Agent object via a WeakMap, pins projectKey to `projectKeyOf(path.resolve(agent.session.header.cwd))`, and takes sessionId from the current host session.id. When cwd is missing or seq is not a safe non-negative integer, return unavailable/unconfigured; never guess `process.cwd`. Memory's directory-isolation root keeps using its own existing resolver; a memoryDir hash must not be used as the quota project key.

Each bound runner's deps add `validateScope(scope): boolean`, which re-checks project/session/agent against the bound Agent before route resolution, before reserve, and before returning answered. originSeq must lie in `[0,Number(agent.session.seq)]`. Agent dispose permanently invalidates the binder. A caller forging another projectKey/sessionId/agentId, or an old Agent whose session/cwd has switched, is rejected before reserve; if the change happens after dispatch, settle as usual but do not return answered. The pure library does not consult a global agent registry; the host binder supplies this dependency.

Route resolution yields `{provider,model,actualModelId?,baseURL,apiKey?,revision,perRequestTokens,perQuestionTokens,maxOutputTokens,maxQuestions}`. The lane alias IS the route: only concrete `protocol=systemone` alias routes with non-empty provider and model are usable — no chat fallback, no parent-request-header fill, no peer fallback, and no capability table duplicating the alias's provider/model. Connection facts (baseURL, optional apiKey) come from the `llm-pi-ai` provider record read through the provenance-preserving trusted view (user/flag/policy layers only), never the merged cascade — a repo-carried provider record can never supply a decision endpoint. The optional per-alias pin row (below) may pin `revision`, `actual-model-id` and the bounds; absent fields default: per-request/per-question tokens from the measured per-model window registry (unknown model ids fall back to 1024 — budget-degrade rather than silent gateway truncation), max-output-tokens 32768, max-questions 32, revision = the resolved wire model id. A backend swap behind an unchanged wire model id does NOT rotate inputHash — an explicit `revision` pin (or an alias retarget) is the mandatory rotation knob. `actual-model-id` absent disables version pinning (the envelope is still fully validated and the echoed model recorded; the answer is never rejected on identity) — the pin is operator hardening against a swapped backend silently poisoning answers adopted into memory; a present pin is enforced exactly as before. identifyRoute returns only the same resolution result, without secrets (no API key, baseURL, or actualModelId); run re-resolves before dispatch, and callers must compare identity consistency across the await, discarding the business result if it changed.

## Settings and route declaration

New namespace `systemone-decisions`, reading only trusted user/managed/explicit --settings sources and ignoring project/local; apply the settings-cascade trusted-source behaviour for auto-mode. All raw fields are kebab-case; internal interfaces are camelCase.

| Field | Default | Constraint and effect |
|---|---|---|
| `max-attempts-per-session` | 100 | Non-negative safe integer; 0 rejects all new requests |
| `max-input-tokens-per-session` | 1000000 | Non-negative safe integer, settled after reservation |
| `max-output-tokens-per-session` | 100000 | Same, tokens count even if provider output is free |
| `max-retries` | 0 | Integer 0..2, retries 429 only |
| `routes` | `{}` | Optional per-alias pin rows, keys folded lowercase: each row may carry `revision` (default: the resolved wire model id), `actual-model-id` (absent = version pinning disabled; present: non-empty, at most 256 characters, the only permitted response model), `per-request-tokens` / `per-question-tokens` (default: the measured per-model window registry, unknown ids 1024), `max-output-tokens` (default 32768), `max-questions` (default 32). Every field optional; a present-but-invalid value invalidates only that alias's route, never its siblings. A leftover non-empty legacy `capabilities` table fails the whole section closed |
| `ledger-max-bytes` | 10485760 | Integer, minimum 1048576; on reaching the limit, stop new decisions without deleting records still inside the quota window |

A durably not-dispatched attempt does not consume the attempt quota: it stays in the ledger but is released in full (the S1-07 released row), and max-attempts-per-session counts only attempts that reserved and were not durably refunded. A pin row is `{ revision?, actual-model-id?, per-request-tokens?, per-question-tokens?, max-output-tokens?, max-questions? }` (kebab-case keys, all optional). The section parses tri-state: absent keeps ship defaults with alias-derived routes usable; present-but-invalid (bad quota key, non-object `routes`, leftover non-empty `capabilities`) fails the whole section closed — no route is usable, zero dispatches.

Mounting the service does not enable any business. Each feature's mode defaults to off, and off constructs no request. Changing settings does not reset quota already spent; lowering a limit below what has been consumed rejects all subsequent requests. The quota scope is `(projectKey,sessionId)`, covering every agent and feature of that session; different projects do not share, and parent/child session IDs with different values are metered separately.

Route bounds are a deployment contract and must not be replaced by a caller's estimated budget. The registry defaults encode the measured per-model windows (a model that silently truncates at 1024 must never receive more than that); a deployment gateway that differs overrides the pin row per alias. The reserve path must be understood when sizing: each attempt reserves `per-request-tokens` in and `max-output-tokens` out against the session quota, and an unknown-settled attempt (timeout after fetch) retains the full reservation — three such attempts at the 32768 output default exhaust the default 100000 output quota, so deployments seeing freeze-after-timeouts should lower `max-output-tokens`. Defaults reduce overrun likelihood; they guarantee nothing — an actual-usage overrun is detected post-hoc (`accounting-overrun`, settle actual, durable freeze), outside the Lean accounting theorem's conditional scope. Notably, an unpinned backend swap reporting differently-scaled usage can surface as `accounting-overrun` + freeze: when diagnosing a freeze, check the pin first.

## Execution state machine and budget order

Every run generates a UUID decisionId and never reuses the ID of a failed request. The timeout is the total limit from the run entry point, covering lock waiting, permit, network and retry waits; it is not restarted per attempt.

1. Check signal, request structure, route and pin row. Cancellation returns cancelled; missing service/route returns unconfigured; an invalid payload returns malformed.
2. Serialize the complete state/questions as canonical JSON. Estimate state + all questions + envelope + margin with the existing estimator, and also check each state+question individually; the limit is the smaller of the caller's maxInputTokens and the corresponding route window. An over-limit estimate is neither truncated nor sent — return unavailable/budget. Estimation is dispatch filtering, not a billing upper bound; business must batch by complete objects.
3. Compute the full inputHash: SHA-256(canonical `{provider,model,routeRevision,state,questions,questionVersion,policyVersion}`). Never write the API key into the hash or the records.
4. Each attempt first reserves one attempt, perRequestTokens of input and maxOutputTokens of output from the global provider; it then requests the same token upper bounds from the optional business provider. On any rejection, settle the other not-yet-dispatched permits as not-dispatched and return budget.
5. Persist the dispatch record before the fetch call. If the write fails, dispatch must not happen and the permit for this attempt is returned as not-dispatched. Then execute one native request.
6. After the HTTP response, validate usage independently. If usage is valid, settle as actual even when the answer's semantic fields are malformed; if usage is invalid, or on timeout or unknown network state, settle as unknown and keep the full token reservation. Entering fetch counts as an attempt, 429 included; never assume failure is free.
7. Return answered only when full S1-01 validation succeeds, the optional version pin matches (the response model exactly equals the pinned actual-model-id WHEN the route pins one; an unpinned route accepts any echoed model and records it), actual usage does not exceed the route upper bound, and settle succeeded. The configured wire model may be a gateway deployment name and must not substitute for a pin. A pinned mismatch settles at actual usage, records the ledger reasonCode `model-version-mismatch`, and returns `unavailable` (no freeze); the usage-bounds check runs whenever the pin is absent or matches. Otherwise unavailable. Caller cancellation does not refund an already-dispatched request.
8. A 429 may proceed to the next attempt under the existing delay rules, but must re-reserve first; the same permit must not serve multiple attempts. Success, malformed, 401/403 and other HTTP errors are never retried. At most `1+max-retries` attempts, and retry waits remain bounded by the existing 3000ms total wait budget and the run's total timeout.

The client gains an optional `attemptObserver` with two methods: `beforeDispatch({attempt,signal}) => Promise<boolean>` and `afterDispatch({attempt,usage?:SystemOneUsage}) => Promise<void>`. false/an exception keeps the request out of fetch; an observer exception converts to error. The runner maps before/after onto the above permit lifecycle. Cancellation before dispatch is settled by the runner's finally. Legacy behaviour is unchanged when no observer is passed.

after must run after the response body is read and before answer validation, and on an exceptional exit finally must supplement it once with unknown usage. Each permit maintains `settlementInvoked` and `settlementSucceeded` separately, setting invoked=true before entering the settle callback. When one settle throws, finally must neither call unknown on it again nor overwrite other permits already settled. Only permits never invoked are settled with the known actual or unknown; a provider whose callback fails keeps its last durable reserve, has its budget frozen, and makes this run return error. Releasing a not-dispatched permit follows the same single-invocation rule. Tests must inject both cut points separately: business settle failure, and business settled successfully while global settle fails.

## Durable quota and concurrency

The directory is `<dshHome>/decision-usage/<projectKey>/<encodedSessionId>/`; projectKey comes from the host cwd and the session ID uses the encodeSegment helper hoisted into sidecar-io — never concatenate user-input paths. The directory holds `usage.jsonl` and the short-lived transaction lock `quota.lock`.

reserve, settle and recovery all run inside the same short transaction lock: acquire with `open('wx',0600)`, wait at most 100ms, retrying every 20ms; failure counts as budget and the lock wait is always bounded by the run's remaining total timeout, with no lock stealing. The lock protects only reading the ledger, checking limits and appending records — never held across network waits. **Every** append is inside that transaction, the dispatch record at step 5 included, and the freeze state is read and computed inside the same lock: a settle failure that freezes the quota must not interleave with another request that has already passed its limit check. Splitting these into separate lock acquisitions reopens exactly that race. A freeze is persisted as a ledger row (fixed reason code) inside the same transaction that computed it; recovery reads the freeze from the ledger, and if persisting the freeze row itself fails, the process keeps the lock file in place instead of releasing it (the quota-lock-unavailable path): new calls stop immediately, diagnostics show the fixed code, and a human clears it after confirming no process holds the lock; the retained reservation stays in the ledger and recovery treats the ambiguous tail as torn-or-frozen and freezes. Clearing the lock after a freeze-persist failure must durably establish the freeze first: the clear tooling appends the freeze row (or a torn-tail freeze marker) before removing the lock file, so the post-clear ledger is never indistinguishable from an ordinary unpaired reservation. v1 deletes no existing lock automatically; a lock left by a crashed process only stops new calls, diagnostics show the fixed `quota-lock-unavailable`, and a human clears it after confirming no process holds the lock. This way the existing VWA torn-lock reclaim logic is not reused and no live-lock misdeletion is introduced.

Appending a reserve/dispatch/settle JSONL line must `fsync` successfully before the transaction completes. The reserve leaseId is decisionId+attempt; settle is idempotent — repeating the same terminal state charges nothing more, and a conflicting terminal state freezes the quota. Permit acquisition order is fixed global→business, settlement the reverse order, never holding two file locks at once.

On recovery, an unpaired reserve keeps occupying its full amount; only a durable not-dispatched entry may be refunded. When a torn tail line makes the ledger incomplete, freeze that session's quota and return budget; never silently skip it and continue sending requests. Read-only reports may display complete lines and mark the ledger corrupt. If a pinned actual-model-id does not match the response version, apply no result and record the fixed reason code `model-version-mismatch`, without refunding (no freeze); an unpinned route never rejects on model identity but still runs the usage-bounds check. If usage exceeds the reserved upper bound, record the actual values plus `accounting-overrun`, freeze subsequent requests for that session, and treat the current result as unusable for business actions.

## Ledger, privacy and reporting

Each schemaVersion=1 record contains eventId, decisionId, attempt, phase (reserve/dispatch/settle/outcome), time, scope, feature, mode, provider, requestedModel, actualModel, routeRevision, questionVersion, policyVersion, inputHash, reserved/actual tokens, latencyMs and fixed outcome/reasonCode. actualModel is null while an attempt has no response yet. Recording API keys, baseURL query strings, state, questions body text, paths, raw error bodies or model answers is forbidden.

A business may store separately its own authoritative object ID and fixed decision labels, but must not double-count usage. The ledger is not a semantic cache and does not replay decisions; a cache hit should be marked by the business as a local event with zero attempts. In-memory caches cannot be shared automatically across processes.

`/cost` gains a separate `SystemOne decisions` section, matching prices against the existing modelTable by actualModel/provider; input and output are converted separately, without hardcoding free output for all services. Unknown usage shows "reserved upper bound, unconfirmed"; a model with no configured price shows unpriced, not $0. The generative-model section keeps its original algorithm; the total distinguishes a confirmed subtotal from an incomplete one and never fabricates an exact total cost. The usage ledger dedups by eventId; all attempts of one decision count, and the business outcome is not charged again.

## Failure table and example

| Situation | Budget result | Business result |
|---|---|---|
| Feature off | No run, no ledger, no cost | Original behaviour |
| Route unresolvable (alias not concrete / not a systemone route / pin row invalid / provider record unavailable) | No reserve | unconfigured |
| Global admission passes, VWA admission fails | global not-dispatched refunded | budget |
| Timeout after fetch | Both permits unknown, fully retained | timeout |
| Invalid answer, but usage is 900/20 | actual settle 900/20 | malformed |
| Insufficient budget on retry after 429 | Dispatched charged, not-dispatched not charged | budget |
| Ledger write fails | No new fetch started; dispatched ones keep their reservation | error |
| Caller abort | Refunded before dispatch, not after | cancelled |

Example: route input bound 16000, output bound 2000, global remaining input 20000. A and B each request once concurrently, and only one can reserve. After A ends at actual=1000/20 the difference is returned; B's rejected request is not restarted automatically — the next business trigger decides whether to call again. Unlimited retries at the task level are not allowed.

## Independent implementation tasks and tests

- [ ] Create the pure runner and fake providers; first verify forged scope gives zero reserve/zero fetch, a mismatched returned model version is charged but not acted on, two concurrent requests cannot over-reserve, and a rejecting optional provider yields no fetch.
- [ ] Create the fsync-capable durable ledger/quota module. Test crash at three cut points: after reserve, after dispatch, and mid-line in settle; no restart may hand out free quota.
- [ ] Additive, compatible change to the client observer and maxRetries. Test 429→429→success as three reserve/settle pairs; the new runner defaults to one attempt, legacy to at most three.
- [ ] Mount the optional service and trusted settings; an unresolvable alias means no request; make explicit that project/local cannot raise quota or change pin rows or bounds.
- [ ] Merge ledger reads into `/cost`. Test duplicate eventId, unpriced model, unknown usage, a valid 0-token response, and multiple actualModels.
- [ ] VWA fake-provider tests for reserve rejection, settle idempotency and sharing the locally generated review budget, without enabling S1-07/08.

Create `systemone/tests/decision.spec.ts`, the new package's `tests/{quota,ledger,service}.spec.ts`, and command-cost `tests/decision-cost.spec.ts`, then run:

```sh
pnpm exec vitest run packages/llm-tuning/systemone/tests
pnpm exec vitest run packages/observability/decision-usage/tests
pnpm exec vitest run packages/session/command-cost/tests
pnpm check:spec-deps
pnpm check:inject
pnpm typecheck
```

The acceptance bar is all state-machine tests exiting 0, no dispatch beyond quota, zero double settlement, and no network in off mode. Real deployment compares the ledger against provider usage with one success and one controlled timeout; simulated tests may not be used to claim real cost accuracy. Implementation adds the bilingual README, capability manifest, parity generation and plugin attribution in configuration snapshots.

## Rollback

Turn off all new feature modes first, then remove the service mount. Keep the read-only ledger and `/cost` parsing so historical cost stays auditable; rollback must not delete quota already consumed. v1 does not automatically repair a corrupt ledger and does not extend the permission legacy's fault-tolerance policy.

## Amendment (2026-11-10): decision routes unified on the gauge alias

The `capabilities` table duplicated the gauge alias's route config (provider/model) and required byte-exact twin configuration or every decision silently failed closed as `unconfigured`. This amendment, made after #351 landed and before any release shipped the table, derives decision routes from the lane alias alone:

- The alias (resolved through `@dsh-cc/model-aliases`, default `DECISION_LANE_ALIAS = 'gauge'`, consumer `route-alias` settings removed) is the only route source. Pin rows are optional hardening.
- Trust model, three layers: the alias map is read from the full cascade (a project layer can only select among user-configured provider keys — it cannot mint an endpoint, because connection facts come from the `llm-pi-ai` record via the provenance-preserving trusted view, user/flag/policy layers only, no fallback); `systemone-decisions` quota/pins/bounds remain trusted-source only. The deleted table's "cannot enable a model the user did not list" guarantee is gone by design; containment is endpoint provenance plus trusted quota caps. (The gauge permission lane still reads the merged `llm-pi-ai` view — a preexisting, separately-tracked weakness not fixed here.)
- A leftover non-empty legacy `capabilities` table fails the whole namespace closed so dogfood configs fail loud instead of silently unpinning.

Review provenance: three-seat blind review (internal critic + two external lanes) — r1 full brief (NO-GO / GWC / GWC), r2 delta (GO / GWC / GWC), r3 micro-confirmation (GO / GWC with one residual adopted verbatim: no merged-read fallback when the settings service lacks `trustedSection` — fail closed). All findings folded; the adjudication ledger lives with the PR.

Formal-design screening (no re-run): `specs/tla/decision-runtime-quota` and `specs/lean/decision-quota-accounting` encode no capability/route/actualModel concept (grep-verified), so the amended route resolution does not touch the modeled state machines. The screening records three points: (a) the runner's changed acceptance predicate (optional version pin) is not encoded in either model; (b) the Lean precondition "actual settle valid iff usage ≤ reserved" remains a conditional assumption of the model — config defaults reduce overrun likelihood without establishing it, and overrun handling (post-hoc detection, actual charging, durable freeze) sits outside the theorem's conditional scope and is unchanged; (c) route resolution stays a stateless pure function (the S1-01 screening class). All three seats concurred with no re-run.
