---
name: vwa-batch
description: Run an unattended multi-page VWA review batch. Use when the user gives one instruction, a page list, and one task grant and wants the whole loop driven to a ledger without per-page interaction — init a project per page, bind, review, freeze the evaluation, fix and report, commit, push, open the PR, confirm CI, then publish the batch ledger. Do not use for a single-page interactive article review (use vwa-writing) or for wiring the batch runtime itself.
---

# VWA batch

The driver is this agent. There is no resident runner, no daemon, and no batch
tool: the loop below, the files it writes, and the evidence it reads ARE the
feature. Any later session, human, or agent continues a batch by reading the
same files.

Read [the state contract](references/state-contract.md) before writing any batch
file. It carries the manifest, grant-descriptor and state schemas, the
checkpoint evidence table, the invariants and the transition rules. Read
[the batch report template](references/batch-report-template.md) before writing
the end-of-batch document.

Do not change the contract to fit a run. If reality contradicts it, stop and
report the contradiction.

## 1. Start the batch

The batch lives in `.dsh/vwa/batches/<batchId>/`, where `batchId` is
`batch_<yyyymmdd>_<8hex>`.

1. Write `manifest.json` once. It is read-only afterwards. It fixes the page
   list, `target`, `branch`, and the policy: `maxPageAttempts: 2`,
   `disagreementPolicy: "deferred"`, optional `projectBudget`, and
   `skipAuditFallback`.
2. Write `grant-descriptor.json` with capability-face fields only. Derive
   `writePaths` from the page list plus `docs/vwa-reports/` and
   `.dsh/vwa/batches/` — nothing else, and never another path under
   `.dsh/vwa/`. Do not put host-derived fields in it; the host derives those.
3. Ask the user to run:

   ```text
   /permissions grant .dsh/vwa/batches/<batchId>/grant-descriptor.json
   ```

   This is the single user action of the whole batch. Show the page list and
   the derived write paths in your reply so the approval is informed.
4. If no grant is active when the user's next message arrives, abort before
   any page starts. Do not retry the loop, do not narrow the request, do not
   escalate per command.
5. Create `state.json` with every page `pending`, then start the page loop in
   manifest order.

`/permissions grant` is delivered by a separate change (the task-grant chain).
Until that change is present the command does not exist and the batch aborts at
this checkpoint. The contract is stable either way: never work around a missing
grant.

## 2. Run one page

Take the next page with status `pending` or `active`. Run the nine checkpoints
in order. Fixes and the report land in ONE commit — never commit the fix
separately.

1. **projectCreated** — `argument.init` with the page's persisted
   `initRequestId`, `setPointer: false`, and the manifest policy
   (`reviewSettings.disagreementPolicy`, `projectBudget`). Record the returned
   `projectId`. A replay with the same requestId returns the same projectId;
   never write a second `initRequestId` for a page that has one.
2. **graphBound** — bind the page through `argument.update`
   (`op: "bind-artifact"`), keeping exact occurrence text and valid spans.
   Verify the reported occurrences cover the page.
3. **reviewCompleted** — run `argument.review`, wait for the terminal host job,
   then read the current results. The checkpoint passes when every semantic
   stage is current and audit is current, OR the skip-audit predicate is in
   effect for this artifact. In deferred mode a reviewer disagreement does not
   block this checkpoint.
4. **evaluationFrozen** — after the review passes and BEFORE touching the page,
   call `argument.report` with `write: false` for this artifact and record the
   returned `evaluationId`. This freezes the review-time state; skipping it
   makes the as-of re-render impossible for this page.
5. **reportWritten** — fix the page, then call `argument.report` with
   `evaluationId: <frozen id>` and `write: true`. Record `reportHash` of the
   written report file. Do not commit yet.
6. **committed** — one commit carrying the page fix and the report. When the
   review found nothing actionable, `kind: "none"` is allowed and the report
   file alone forms the commit. Record the sha.
7. **pushed** — push the branch, record `pushedSha`.
8. **prOpen** — open or update the PR, record the URL. With `kind: "none"` and
   no commit the page may have no PR: record `noPr: true`.
9. **ciConfirmed** — query CI by the EXACT sha:

   ```sh
   gh api repos/{owner}/{repo}/commits/<pushedSha>/check-runs
   gh run view <id> --json headSha
   ```

   `gh pr checks --commit` does not exist; do not use it. `gh run watch` needs
   an explicit timeout. A timeout is NOT a failure: it increments `ci.ciTimeouts`
   and does not consume a page attempt. Only a definitive CI failure or
   cancellation is a stage failure. With `noPr`, this checkpoint is
   inapplicable and the page may still be done.

After a successful checkpoint, reset that checkpoint's consecutive counter and
write `state.json` atomically (temp file + rename) under `state.lock`.

## 3. Failures and skipping

A checkpoint failure increments `stageFailures[<checkpoint>]` and records the
error code plus a one-line summary in `failureReasons`. When the SAME checkpoint
fails consecutively `policy.maxPageAttempts` times (default 2), set the page to
`skipped`, record why, and continue with the next page. A checkpoint success
resets its consecutive counter. Tool-internal retries of retryable errors are
part of the tool call and never count as attempts.

Skipped and failed pages are never retried automatically. Only an explicit user
reset returns them to `pending`.

## 4. Async review recovery

Persist `{requestId, runId, phase}` per page. On a resumed page, first replay
the SAME requestId and read the resulting running or terminal state. Only when
the previous run is terminal may you issue a continuation with a NEW requestId.
Never start a second request while a run for the page is live.

## 5. Resume after an interruption

Process only pages with status `pending` or `active`. An active page recovers in
this order:

1. replay `initRequestId` to recover `projectId`;
2. apply the async review recovery rule above;
3. recompute EVERY checkpoint boolean from on-disk evidence and overwrite
   state: the init reservation file, the bound revision, the run status,
   `git merge-base --is-ancestor` / `git log` for commits already present, the
   report file hash, `gh pr view`, and check-runs for the pushed sha.

`state.json` is a cache, not the authority. Disk evidence wins every conflict.
Commits and pushes already on the remote are not redone. Hold `state.lock` for
the whole read-reconcile-write step so a second driver cannot interleave.

## 6. Close the batch

When every page is `done`, `skipped`, or `failed`, write
`docs/vwa-reports/batch-<batchId>.md` from
[the template](references/batch-report-template.md): the per-page table, the
pending human adjudication queue, skipped pages with reasons, cost totals and
project budget consumption, and — when the grant expired with pages remaining —
the re-grant command to resume.

The adjudication queue is a derived view: for each project, take the deferred
disagreements the reports surfaced and list projectId, artifactId, findingId,
the two conflicting runIds, and the suggested command with a placeholder:

```text
/vwa adjudicate <projectId> <findingId> <accept|reject> <prevailingRunId> <reason>
```

Batch runs set `setPointer: false`, so the pointer form of the command is
unusable and every suggested line carries its projectId. Only the user
adjudicates; the batch never picks a side.

Present the ledger path and the counts in your final reply.

## 7. Boundaries

- Never claim a passed review, a confirmed CI, or a delivered report that the
  evidence does not show. A pending job, absent check-run, or unread report is
  reported as unknown.
- Never edit another page in one page's commit. Never commit or push outside
  the batch's branch.
- Never adjudicate, sign, repair around a failing major, or widen the grant.
- `docs/vwa-reports/` holds only batch and report outputs; never move VWA
  internal state there.
- Batches share nothing but the repository. Do not read another batch's state
  to infer this one's.
