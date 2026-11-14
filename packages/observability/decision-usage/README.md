# @dsh-cc/decision-usage

English | [中文](README.zh.md)

SystemOne decision runtime host adapter — the optional `ctx.systemoneDecisions` service implementing the SystemOne S1-02 decision-runtime-metering design (feature S1-02). It wires the pure `createDecisionRunner` (`@dsh-cc/systemone`) to real host dependencies: trusted settings, alias-keyed route resolution (the lane alias IS the route; an optional per-alias pin row can only narrow it), a durable JSONL usage ledger, and the lock-guarded session quota. Mounting the service triggers no request and enables no business; a missing service is equivalent to unavailable/unconfigured.

## Settings

One trusted namespace, `systemone-decisions` (schema registered via `registerNamespaceSafe`; the settings cascade reassembles it from user/managed/explicit sources only — project/local can never raise quota, widen bounds or supply connection facts). Raw fields are kebab-case: `max-attempts-per-session` (default 100), `max-input-tokens-per-session` (1,000,000), `max-output-tokens-per-session` (100,000), `max-retries` (0, range 0..2), `routes` (per-alias pin rows, default `{}`), `ledger-max-bytes` (10,485,760, minimum 1,048,576).

`routes.<alias>` is an optional pin row: EVERY field is optional, and an absent field means "use the default". `revision` (default = the resolved wire model id — set it explicitly to change the recorded revision when the backend rotates); `actual-model-id` (optional version pin, non-empty and at most 256 chars; absent = no version check); `per-request-tokens` / `per-question-tokens` (default = the measured per-model window from `@dsh-cc/systemone/model-windows`, keyed by the normalized model id — `llmbox_systemone/bjev` → 16384 — and 1024 for an unmeasured model); `max-output-tokens` (32768); `max-questions` (32). A PRESENT field that is `null`, empty, zero, negative or not a safe integer makes THAT alias unusable and never touches a sibling alias. Alias keys are folded to lowercase (`routes.Gauge` pins `gauge`); a fold collision is last-wins with one warning.

A route is usable only when the alias resolves to a concrete `protocol: 'systemone'` route with a non-empty provider and model — there is no capability table, no exact `(provider, model)` match, no parent-header fill and no peer fallback; a miss, a wrong protocol or an invalid present field resolves to unconfigured, never to a guessed value. `identifyRoute` returns the keyless identity — no apiKey, baseURL or actual-model-id.

The defaults size the per-attempt RESERVATION; they guarantee nothing. Each attempt reserves `per-request-tokens` and `max-output-tokens` against the session quota, an answered attempt settles to actual usage, and an unknown-settled attempt RETAINS its reservation — so a backend whose accounting moves (for example an unpinned backend swap) surfaces as `accounting-overrun` plus a durable freeze, the documented fail-safe direction.

Migration: the retired `capabilities` table fails the whole section closed whenever it carries rows (an empty `capabilities: []` is tolerated as inert). Move the extras into `routes.<alias>` and drop `provider`/`model` — the alias supplies both.

Trust model, three layers: `systemone-decisions` is a trusted namespace (user/managed/explicit-flag only); the alias map comes from the full cascade (documented residual — a project layer can only select among user-configured provider keys, never mint an endpoint); and the decision lane reads provider connection facts from the cascade's trusted-only view of `llm-pi-ai` (`trustedSection('llm-pi-ai')`, duck-typed). A settings provider without that API leaves the provider record unresolvable, so no route resolves — the merged read is provenance-lossy and would honour a repo-carried endpoint or credential reference. The gauge permission lane keeps its merged read (preexisting weakness, tracked separately).

## Ledger layout and quota

Per quota scope `(projectKey, sessionId)`: `<dshHome>/decision-usage/<projectKey>/<encodeSegment(sessionId)>/` holding `usage.jsonl` and the transaction lock `quota.lock`. Every schemaVersion=1 row carries identifiers, versions and token counts only — never API keys, baseURLs, state/question bodies, paths or answers. `reserve`/`dispatch`/`settle`/`outcome` phases; leaseId is `decisionId + attempt`.

Every append runs inside the same short transaction: acquire (`open('wx', 0600)`, retry every 20ms up to 100ms, no lock stealing, no stale reclaim in v1) → read ledger → check limits → append with fsync → release. Freeze state is read and computed inside that lock and persisted as a `reasonCode` row inside the same transaction; if persisting a freeze row fails, the lock file stays in place and a human clears it. Recovery keeps an unpaired reserve at its full amount, refunds only a durable `not-dispatched`, and freezes the session quota on a torn tail (`torn-tail`) or conflicting settle (`quota-frozen`); `accounting-overrun` freezes the session for subsequent requests, `model-version-mismatch` charges without acting. `max-attempts-per-session` counts only attempts that reserved and were not durably refunded; input/output limits are settled-after-reservation semantics; `ledger-max-bytes` stops new decisions without deleting records.

Note: the quota-written reserve row is accounting-canonical (its `provider`/`model`/`revision`/`mode` fields are empty by contract — the reserve input carries none of them); route attribution lives on the runner-written `dispatch`/`outcome` rows of the same lease.

## Reading the ledger (for /cost and reports)

```ts
import { decisionUsageDir, usageFilePath, readDecisionLedger, projectDecisionLedger } from '@dsh-cc/decision-usage'

const dir = decisionUsageDir(dshHome, projectKey, sessionId)
const report = await readDecisionLedger(usageFilePath(dir)) // { rows, tornTail, corruptLines, bytes }
const usage = projectDecisionLedger(report.rows)            // attemptsUsed, retained*, per-lease actuals
```

The reader skips blank lines but reports a torn tail and every non-conforming line instead of silently skipping; read-only consumers may show complete rows and mark the ledger corrupt. The projection applies recovery accounting: actual → actual usage, unknown/unsettled → full reservation, durable not-dispatched → zero, plus per-lease provider/requestedModel/actualModel attribution and the freeze state. Dedup/attribution are the projection's job; the raw row stream is in `report.rows`.

## Composition

Optional cordis plugin (`apply`): registers the settings namespace and provides `ctx.systemoneDecisions` with `forAgent(agent): BoundDecisionRunner`. The binder pins a process-wide UUID per Agent via a `WeakMap`, the project key from `projectKeyOf(path.resolve(header.cwd))`, the session id from the live `agent.session.id`, and validates scope against the live agent before route resolution, before every reserve, and before answered; dispose invalidates permanently. The service is mounted by presets, not by business features.

Design evidence: the quota transaction protocol mirrors the verified model in `specs/tla/decision-runtime-quota` (check-then-append under one lock, freeze computed inside it, crash at any cut point yields no free quota).
