# Feature C: explicit verification batches and reusable receipts

- Status: proposed; depends on A and B. See the [implementation order](2026-10-27-guarded-execution.md).
- Owner: existing `packages/interaction/post-edit-verify`; public batch/receipt API exported from that package.

## 1. Problem and compatibility

The current runner executes every matching edit; its debounce marks a burst but skips nothing. A multi-file change can run the same check many times, and a later model call may run it again. Introduce a bounded edit batch with a required flush and an explicit verification tool. Preserve ordinary post-edit behavior outside a batch, raw user-only rule loading, first-match selection per file, timeout bounds, and recovery hints. Do not intercept arbitrary Bash calls, rewrite their output, or treat shell command equality as proof that an old result is valid.

V1 guarantees reuse only within the same session and task, under a narrow state contract (unchanged epoch, input, environment and schema fingerprints within a bounded TTL). It does not provide a general content cache for external processes, remote dependencies or arbitrary worktree mutations. A passed check is historical evidence for specific inputs, never a completion certificate.

## 2. Public batch tool

Register optional `edit_batch` when `cc-post-edit-verify.batch-enabled:true` and B's dependencies are available. Input is `{v:1, edits:[{id, tool:'edit'|'write', arguments}], verifyRuleIds:string[]}`. There are 1–16 edits and 1–16 unique rule IDs; use B's literal argument and canonical size limits. IDs are local node IDs under B's syntax. No nested batch, parallel branches, shell step, remote tool or argument substitution is permitted. Preflight validates every edit and all rule IDs before executing anything.

Each configured rule gains optional `id` matching `^[a-z][a-z0-9_-]{0,31}$`, unique among rules. Existing rules without IDs work unchanged in legacy mode but cannot be named in a batch. The initial batch implementation requires stable IDs rather than synthesizing them from index or command text. The rule identity hash covers `id`, `glob`, `command`, `timeoutMs`, `reuse`, the exact `inputs` list, and a verification-contract version tag pinning the status semantics of this document. A changed rule invalidates all matching receipts.

The batch takes a mutex keyed by real session cwd; a second batch from any session sharing that cwd returns `BUSY`. The key is the cwd itself, not Git root, so separate worktrees do not block each other. Resolve realpaths and fail if unavailable. The mutex is a concurrency guard within this process; it is not an OS lock excluding external writers.

State machine: `preflight → editing → flushing → completed|stopped`. At most one live batch per workspace key. An edit is dispatched through `tools.execute`, preserving policies, cancellation, contexts, root IDs and receipts as in B. It is never applied by direct filesystem writes. The post-edit listener checks a trusted AsyncLocalStorage batch context created only by `edit_batch`, not model arguments. While that context is active, matching successful edits enqueue their first matched rule instead of running its command. Failed edits enqueue nothing and stop further edits. Never defer verification just because a burst timestamp suggests that more edits might arrive.

The user-specified rule IDs MUST include every matched rule from preflight known paths; if an actual edited path yields a new unmatched rule, stop edits and include it in the flush rather than silently skipping it. A selected ID whose glob matched no edit is allowed as an explicit additional check. Deduplicate rules by ID; execute in their authored settings order, not edit order. There is no setting to skip the required end-of-batch flush.

On first edit failure, still flush all rules queued by successful earlier edits if cancellation has not occurred. Return partial edit/verify status; do not roll back. On cancellation or batch deadline, stop dispatching, drain active work, record pending rules as `not-run`, and return/retain a visible unverified state. Do not start shell checks after cancellation. Use a finally block to release ownership; exceptions cannot leave the workspace permanently batched. Time limit is 120000 ms total, including native approvals, clamped per check by existing runner limits and passed to the native dispatch.

The batch transport's canonical output is `{v:1, batchId, status:'completed'|'stopped', stopReason:null|'edit-failed'|'cancelled'|'deadline', edits:[{id, state:'succeeded'|'failed'|'skipped', receiptId:null|string}], checks:[{ruleId, status, receiptId:null|string, reused:boolean, reuseMissReason:null|string}], unverified:boolean}`. `unverified` is true whenever any edit failed or is uncertain, any check is not `passed`, or the batch stopped before its flush completed; a passing check never clears it. Cancellation and deadline are represented by the stopped status and per-entry states, never by an exception through the tool transport.

## 3. Verification execution and status

Existing legacy auto-verify continues through its trusted user-configured ShellExecutor seam; the new explicit verification tool MUST execute the configured command through native `bash` and the full tool policy pipeline. It does not call ShellExecutor directly under model authority. Export one shared verification adapter that turns canonical native exit/timeout facts into status. If native schema facts are unsupported, explicit mode returns unsupported and executes nothing. Legacy configuration is not silently migrated to a different permission posture.

Register `verify_rule({v:1, ruleId, batchId?:string, reuseReceiptId?:string})`. Names resolve only against the raw user-layer settings. Model arguments cannot contain commands, environment changes, cwd overrides or looser timeouts. Current session cwd is fixed. The tool normally executes a fresh check. Supplying reuseReceiptId requests Section 4 validation; if validation fails, execute fresh and return `reuseMissReason`. It never silently returns stale output. A batch owner invokes the same service API during its flush. Model-authored batch IDs confer no ownership; reuse authority is exclusively the Section 4 window validation.

Return canonical `{v, ruleId, batchId:null|string, status, receiptId:null|string, reused:boolean, reuseMissReason:null|string, exitCode:null|number, durationMs:number, contentPreview:string}`. Status is exactly `passed | failed | timed-out | cancelled | not-run | infrastructure-error | unsupported`. Passed requires actual exit zero, not timed out or signalled, and final successful native dispatch. Failure is nonzero exit; infrastructure-error means no trustworthy check outcome. Every status except passed leaves the batch unverified. A failed check may be repeated explicitly; no automatic retries. Bound previews using the existing first-line/tail policy, fixing its oversized-single-line case to respect a strict UTF-8 byte cap. Receipt records retain status even when presentation is concise.

## 4. Conservative receipt reuse

Configured rules MAY opt in with `reuse:'batch'` (default `off`) and `inputs:string[]`. Inputs are exact cwd-relative regular-file paths, not globs; max 256 paths, max 64 MiB total bytes. Require at least one input and no duplicates. Include configuration, lockfiles and test data if relevant. Reject absolute paths, `..`, symlink components, non-regular files, case-colliding aliases and paths outside cwd. New/missing files invalidate; a rule unable to declare complete inputs cannot opt in. `reuse:'batch'` is an explicit user assertion that these files plus frozen execution context fully determine the check. Tools cannot set this assertion.

The receipt key is SHA-256 of `{ruleHash, realCwd, inputPathsAndContentHashes, environmentHash, mutationEpoch, hostToolSchemaHash}` using B canonical JSON. `batchId` is no longer part of the key because reuse is window-scoped, not batch-scoped (below). The environment hash covers the plugin-process environment in memory plus the recorded effective shell executable and platform identity of the native bash dispatch; the ledger holds only the digest, never environment values. Checks that intentionally depend on changing remote services, clocks or undeclared files remain reuse off. Snapshot input bytes before and after check; any difference prevents a reusable receipt even if the check passed. A file watcher is only an invalidation hint and never substitutes for rehashing.

Maintain a per-real-cwd mutation epoch. The epoch is keyed by the executing session's resolved real cwd: every dispatched tool whose registered name is not `read` increments that cwd's epoch exactly once, at dispatch, before its body runs — this single dispatch-time rule already covers the batch's own edits — implemented through global `tools/execute` (dispatch) and `tools/result` (settle) listeners that also maintain the per-cwd active-tool count used by reuse validation. A `verify_rule` dispatch that executes a fresh check increments the epoch before the command runs; a `verify_rule` dispatch on the reuse-validation path performs no shell execution and does not increment, and the epoch comparison for reuse excludes any increment contributed by the current verifying transport itself, so validation never invalidates the receipt it is validating. Legacy auto-verify commands run through the ShellExecutor seam also increment their session cwd's epoch before running. Absolute-path writes outside the session cwd cannot be tracked in v1 and are a stated limitation (reuse inputs outside the cwd are already rejected). This per-real-cwd epoch is the single workspace clock for this feature set: D consumes it through this package's public export, and the D0 host boundary surfaces this same value as `workspaceEpoch`.

Before reuse, confirm: same session and same task, same rule/config/environment/schema hashes, same epoch, full input rehash matches, prior status passed, receipt age at most 60 seconds by monotonic time, and no other active tool in the workspace except the current verify_rule transport and its owning batch. Rehash once more immediately before returning the reused receipt. Any uncertainty executes fresh. Reuse never crosses session, task, process restart, worktree or settings-change boundary. Batch closure no longer invalidates receipts; a settings change does. Non-passed checks are not reusable.

This cannot exclude an uncooperative external writer changing a file after validation, just as a fresh check cannot guarantee permanent validity. State that limitation in the receipt. Do not advertise global exactly-current-worktree guarantees or skip native arbitrary Bash requests based on these receipts. For D's controller, an unknown/external workspace invalidation always discards the graph.

Persist verification receipts as a separate in-repo session event `verification/receipt-v1` (declared through `SessionEventMap` augmentation exactly like B's `tool/continuation-dispatch`, with its own closed payload — never an unknown-key extension of B's event) containing rule ID/hash, batch ID or null for standalone checks, input fingerprint, environment digest, epoch, status and origin receipt on reuse. Standalone checks without a dispatched edit child receive their own receipt identity in this event. Reuse creates a new reference receipt pointing to the original execution; accounting records zero new physical tool execution and zero model bypass. Do not fabricate a new shell execution time. In-memory receipts disappear on disposal; transcript receipts remain historical and cannot reactivate reuse. Legacy checks emit historical status records where supported but do not become eligible for reuse.

## 5. Composition and settings

Extend `RulesSettings` with `batchEnabled:false`. Extend rule schema with optional ID, `reuse:'off'|'batch'` default off and exact input list. Validate in both raw reader and namespace schema; malformed configuration retains the existing fail-soft disabled settings behavior and logs one bounded warning for the new feature. Keep recovery-hint settings independent. A rule cannot declare reuse batch without an ID and inputs. No project-scope commands or reuse contracts are loaded.

Tool result compression may shorten previews but MUST preserve canonical status and verification receipt identity. Batch deferral occurs only for accepted successful edits (`result.isError === false` and accepted post-policy outcome). Preserve additionalContexts, do not combine content and value in a PostToolDecision. Actual final tool failure must cancel queued success admission for that edit. Use the final `tools/result` observation to confirm the queue entry before flush; post-execute only prepares it. This avoids counting an edit that later normalization/cancellation turns into failure.

If a final edit result fails after its filesystem effect, mark mutation as possible, keep earlier successful edits and flush their checks if permitted; never claim the failed edit was verified. The edit_batch aggregate is stopped/unverified whenever any edit is failed or uncertain, even if every flushed check passes. A passed rule result cannot overwrite that aggregate status. Batch closure does not invalidate reuse; settings changes do. Explicit tools are absent when disabled; legacy auto-verification remains configured exactly as before. Removing this feature needs only disabling batch-enabled; no receipt migration is necessary.

## 6. Files, tests and acceptance

Modify existing `src/{index,settings,rules,wiring,runner,compose}.ts`; add `src/{batch,verification-tool,verification-service,fingerprint,receipts,mutation-epoch}.ts`. Export public batch service/receipt types for D, never import these source files directly. Do not change recovery text or rule glob matching. Add tool schema/presentation tests, settings round-trip tests and package references to A/B.

| Scenario | Required result |
| --- | --- |
| Three edits matching one rule | One end-of-batch command, three native edit receipts |
| Same edits outside batch | Three legacy commands, unchanged behavior |
| Two rules, repeated matches | Each selected rule once, authored order |
| Invalid last edit/rule ID | Zero edit/check effects |
| Second edit fails | Third skipped; first edit's queued checks flushed if not cancelled |
| Cancel during edit/check | Active work drained, remaining checks not-run, batch unverified |
| Same receipt reused within the same task window | No shell dispatch; reference to original execution |
| File/config/env/epoch changes, timeout, expiry | Fresh check; explicit miss reason |
| Another session, task or expired window requests reuse | Fresh check, never cached success |
| Inputs change during check or uncertain external change | No reusable receipt |
| A late post-policy failure | No success queue admission for failed edit |
| Huge single output line | Preview stays within byte cap without invalid UTF-8 |
| Compression + recovery hint | Canonical status and context order survive |
| Two sessions share cwd / two worktrees | BUSY for first pair, independent for second |

Run post-edit-verify, B, core/tools, context-crusher composition and settings tests. Integration tests use a temporary Git worktree and cooperative fake/native commands. A paid model is not required for correctness acceptance. E1 measures whether batching actually saves task cost and wall time.
