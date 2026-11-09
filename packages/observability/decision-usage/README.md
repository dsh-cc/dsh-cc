# @dsh-cc/decision-usage

English | [中文](README.zh.md)

SystemOne decision runtime host adapter — the optional `ctx.systemoneDecisions` service implementing the SystemOne S1-02 decision-runtime-metering design (feature S1-02) 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L1-L7〕. It wires the pure `createDecisionRunner` (`@dsh-cc/systemone`) to real host dependencies: trusted settings, capability route resolution, a durable JSONL usage ledger, and the lock-guarded session quota. Mounting the service triggers no request and enables no business; a missing service is equivalent to unavailable/unconfigured.

## Settings

One trusted namespace, `systemone-decisions` (schema registered via `registerNamespaceSafe`; the settings cascade reassembles it from user/managed/explicit sources only — project/local can never raise quota or change capability bounds). Raw fields are kebab-case: `max-attempts-per-session` (default 100), `max-input-tokens-per-session` (1,000,000), `max-output-tokens-per-session` (100,000), `max-retries` (0, range 0..2), `capabilities` (rows), `ledger-max-bytes` (10,485,760, minimum 1,048,576).

Each capability row is `{provider, model, revision, actual-model-id, per-request-tokens, per-question-tokens, max-output-tokens, max-questions}`, all required, all bounds positive safe integers. A route is usable only when an alias resolves to a concrete `protocol: 'systemone'` route AND exactly one row matches `(provider, model)` — zero rows or duplicate matches resolve to unconfigured, never to a guessed value. `identifyRoute` returns the keyless identity — no apiKey, baseURL or actual-model-id 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L129-L129〕.

## Ledger layout and quota

Per quota scope `(projectKey, sessionId)`: `<dshHome>/decision-usage/<projectKey>/<encodeSegment(sessionId)>/` holding `usage.jsonl` and the transaction lock `quota.lock`. Every schemaVersion=1 row carries identifiers, versions and token counts only — never API keys, baseURLs, state/question bodies, paths or answers 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L179-L179〕. `reserve`/`dispatch`/`settle`/`outcome` phases; leaseId is `decisionId + attempt` 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L173-L173〕.

Every append runs inside the same short transaction: acquire (`open('wx', 0600)`, retry every 20ms up to 100ms, no lock stealing, no stale reclaim in v1) → read ledger → check limits → append with fsync → release 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L171-L171〕. Freeze state is read and computed inside that lock and persisted as a `reasonCode` row inside the same transaction; if persisting a freeze row fails, the lock file stays in place and a human clears it. Recovery keeps an unpaired reserve at its full amount, refunds only a durable `not-dispatched`, and freezes the session quota on a torn tail (`torn-tail`) or conflicting settle (`quota-frozen`); `accounting-overrun` freezes the session for subsequent requests, `model-version-mismatch` charges without acting. `max-attempts-per-session` counts only attempts that reserved and were not durably refunded; input/output limits are settled-after-reservation semantics; `ledger-max-bytes` stops new decisions without deleting records.

Note: the quota-written reserve row is accounting-canonical (its `provider`/`model`/`revision`/`mode` fields are empty by contract — the reserve input carries none of them); route attribution lives on the runner-written `dispatch`/`outcome` rows of the same lease.

## Reading the ledger (for /cost and reports)

```ts
import { decisionUsageDir, usageFilePath, readDecisionLedger, projectDecisionLedger } from '@dsh-cc/decision-usage'

const dir = decisionUsageDir(dshHome, projectKey, sessionId)
const report = await readDecisionLedger(usageFilePath(dir)) // { rows, tornTail, corruptLines, bytes }
const usage = projectDecisionLedger(report.rows)            // attemptsUsed, retained*, per-lease actuals
```

The reader skips blank lines but reports a torn tail and every non-conforming line instead of silently skipping; read-only consumers may show complete rows and mark the ledger corrupt. The projection applies recovery accounting: actual → actual usage, unknown/unsettled → full reservation, durable not-dispatched → zero, plus per-lease provider/requestedModel/actualModel attribution and the freeze state 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L173-L179〕. Dedup/attribution are the projection's job; the raw row stream is in `report.rows`.

## Composition

Optional cordis plugin (`apply`): registers the settings namespace and provides `ctx.systemoneDecisions` with `forAgent(agent): BoundDecisionRunner`. The binder pins a process-wide UUID per Agent via a `WeakMap` 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L125-L125〕, the project key from `projectKeyOf(path.resolve(header.cwd))`, the session id from the live `agent.session.id`, and validates scope against the live agent before route resolution, before every reserve, and before answered; dispose invalidates permanently. The service is mounted by presets, not by business features.

Design evidence: the quota transaction protocol mirrors the verified model in `specs/tla/decision-runtime-quota` (check-then-append under one lock, freeze computed inside it, crash at any cut point yields no free quota).
