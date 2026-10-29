# VWA batch state contract

Schema version 1. This file is the authority for the batch files. The driver is
the agent; nothing here runs by itself. A future session, a human, or another
agent resumes a batch by reading these files and recomputing state from disk.

The contract is stable whether or not `/permissions grant` exists yet. A batch
with no grant aborts at the grant checkpoint; it does not reinterpret the
contract.

## Directory

`.dsh/vwa/batches/<batchId>/`, with `batchId = batch_<yyyymmdd>_<8hex>`:

| File | Written | Mutability |
| --- | --- | --- |
| `manifest.json` | once at batch start | read-only afterwards |
| `grant-descriptor.json` | once at batch start, before the grant request | read-only afterwards |
| `state.json` | per milestone | atomic rewrite (temp file + rename) |
| `state.lock` | held during any state read-reconcile-write | single writer |

Batches share nothing. The lock serializes same-batch drivers only.

## manifest.json

```json
{
  "schemaVersion": 1,
  "batchId": "batch_20261028_1a2b3c4d",
  "target": "<what the batch is for, one line>",
  "branch": "<batch branch>",
  "pages": [{ "page": "docs/page-a.md" }],
  "policy": {
    "maxPageAttempts": 2,
    "disagreementPolicy": "deferred",
    "projectBudget": { "maxCalls": 0, "maxInputTokens": 0, "maxOutputTokens": 0 },
    "skipAuditFallback": false
  },
  "grantDescriptorFile": "grant-descriptor.json"
}
```

- `maxPageAttempts` defaults to 2.
- `disagreementPolicy` is `"deferred"` for batches; a disagreement never blocks
  a page, only the human adjudication queue.
- `projectBudget` is optional; omit it for unlimited and omit its individual
  keys rather than filling them with `0`.
- `skipAuditFallback` records whether a page may skip the audit stage when
  feasibility cannot afford it. Even when true, prefer narrowing targets or
  batched continuations first; a skip is a declaration with consequences, not a
  convenience.
- `grantDescriptorFile` is relative to the batch directory.

## grant-descriptor.json

Capability-face fields only — exactly what the user approves. Host-derived
fields (`grantId`, `root`, `branch`, `goalId`, `expires`, `createdBy`, `ts`)
must not appear here; the host derives them at grant time.

```json
{
  "rules": ["Bash(git add)", "Bash(git commit)", "Bash(git push)"],
  "tools": ["argument.*"],
  "writePaths": ["docs/page-a.md", "docs/vwa-reports/", ".dsh/vwa/batches/"],
  "sandboxEscalation": true,
  "modeCeiling": "workspace-write",
  "contentScope": "tracked-md-only"
}
```

- `rules` use bare-prefix rule syntax with a token boundary. List exactly the
  commands the loop runs — `git add`, `git commit`, `git push`, the `gh` reads
  and PR creation it needs. `git push` is matched structurally against the
  batch branch; it is not a bare prefix.
- `tools` accepts `prefix.*` and exact names. `argument.*` covers init, update,
  review and report; add `evidence.*` only when the pages register sources.
- `writePaths` are root-relative normalized prefixes, derived from the manifest
  page list plus `docs/vwa-reports/` and `.dsh/vwa/batches/`. Nothing else.
  Nothing under `.dsh/vwa/**` except `.dsh/vwa/batches/**` may ever appear here;
  adjudications, signatures, revisions, review-runs, review-cycles and
  evaluations are mutable only through the VWA tools.
- `modeCeiling` defaults to `workspace-write`. `danger-full-access` must be
  declared here and is highlighted in the approval view.
- `contentScope` defaults conditionally to `tracked-md-only` when
  `sandboxEscalation` is true and `rules` contain `git commit`/`git push`
  prefixes; otherwise `any`. An explicit `any` in that case is opt-in and is
  highlighted in the approval view.

## state.json

```json
{
  "schemaVersion": 1,
  "batchId": "batch_20261028_1a2b3c4d",
  "updatedAt": "2026-10-28T10:00:00.000Z",
  "pages": [
    {
      "page": "docs/page-a.md",
      "projectId": "prj_...",
      "status": "pending",
      "initRequestId": "<uuid>",
      "stageFailures": {
        "projectCreated": 0, "graphBound": 0, "reviewCompleted": 0,
        "evaluationFrozen": 0, "reportWritten": 0, "committed": 0,
        "pushed": 0, "prOpen": 0, "ciConfirmed": 0
      },
      "review": {
        "requests": [{ "requestId": "<uuid>", "runId": "run_...", "phase": "fresh" }],
        "lastRunId": null,
        "skipAudit": false
      },
      "evaluationId": null,
      "reportHash": null,
      "commit": { "kind": "none", "sha": null },
      "pushedSha": null,
      "pr": { "url": null, "noPr": false },
      "ci": { "runId": null, "headSha": null, "url": null, "ciTimeouts": 0 },
      "failureReasons": [],
      "costs": { "calls": 0, "inputTokens": 0, "outputTokens": 0, "cycles": 0 }
    }
  ]
}
```

- `status` ∈ `pending | active | done | skipped | failed`. Only `pending` and
  `active` pages are processed on a resume.
- `stageFailures` has exactly nine keys, one per checkpoint, in checkpoint
  order.
- `review.requests` is the async history. `phase` ∈ `fresh | continue | poll`.
  `lastRunId` is the most recent run for the page. `skipAudit` records whether
  this page declared a skip.
- `commit.kind` ∈ `none | fix-and-report | report-only`. `none` is legitimate
  when the review found nothing actionable: the report file alone is the commit.
- `pr.noPr` marks a page that legitimately needs no PR (`kind: "none"`, no
  commit).
- `ci.ciTimeouts` is a separate counter, max 3. It never increments
  `stageFailures`.
- `costs` accumulates the page's review and report spend; `cycles` counts
  review cycles opened for the page.

Write `state.json` atomically: serialize to a temp file in the same directory,
then rename. Never truncate in place — a crash mid-write must leave the previous
state readable. Hold `state.lock` across the whole read-reconcile-write, not
just the write.

## Checkpoints

In order, per page. The page fix and its report land in ONE commit.

| # | Checkpoint | Passes when | On-disk evidence for a resume |
| --- | --- | --- | --- |
| 1 | `projectCreated` | `argument.init` returned a projectId | `.dsh/vwa/inits/<initRequestId>.json` and `.dsh/vwa/<projectId>/HEAD.json` |
| 2 | `graphBound` | bind-artifact succeeded, occurrences verified | the bound revision under `.dsh/vwa/<projectId>/revisions/` |
| 3 | `reviewCompleted` | every semantic stage current AND (audit pass OR the skip-audit predicate in effect); deferred disagreements do not block | the run records and the delivery state of the project |
| 4 | `evaluationFrozen` | `argument.report` with `write:false` returned an `evaluationId` | `.dsh/vwa/<projectId>/evaluations/<evaluationId>` |
| 5 | `reportWritten` | the as-of re-render returned a path and `reportHash` matches the file on disk | the report file itself |
| 6 | `committed` | one commit contains the fix and the report, or `kind: "none"` with the report alone | `git merge-base --is-ancestor` / `git log` against the recorded sha |
| 7 | `pushed` | `pushedSha` is on the remote | `git log` and the remote ref |
| 8 | `prOpen` | a PR URL is recorded, or `noPr` is legitimate | `gh pr view` |
| 9 | `ciConfirmed` | the check-runs for the EXACT `pushedSha` are successful, or `noPr` makes it inapplicable | `gh api repos/{owner}/{repo}/commits/<pushedSha>/check-runs`; `gh run view <id> --json headSha` |

Checkpoint 3 uses the same effective skip predicate the report and the
continuation planner use: the most recent admission for the artifact bound to
the current artifact hash and entity version declared `skipAudit`, and no
complete audit for that hash exists after it. A later complete audit or a later
non-skip admission flips it back.

Checkpoint 9 queries by exact sha. `gh pr checks --commit` does not exist. When
watching, pass an explicit timeout.

## Failure semantics

- A failing checkpoint increments `stageFailures[<checkpoint>]` and appends the
  error code plus a one-line summary to `failureReasons`.
- The same checkpoint failing CONSECUTIVELY `policy.maxPageAttempts` times
  (default 2) sets `status: "skipped"` for the page; the batch continues with
  the next page.
- A checkpoint success resets that checkpoint's consecutive counter to 0.
  Counters are per checkpoint, never global.
- Tool-internal retries of retryable errors are part of the tool call and never
  count as attempts.
- A `gh run watch` timeout increments `ci.ciTimeouts` only. Three timeouts on a
  page are treated as a failure of `ciConfirmed`. Timeouts never consume page
  attempts.
- `skipped` and `failed` are terminal for the batch. Only an explicit user reset
  returns a page to `pending`.

## Resume

After a restart:

1. Process only pages with status `pending` or `active`.
2. For an `active` page, recover in order:
   - replay `initRequestId` — the reservation makes this safe and returns the
     same projectId; never invent a second one;
   - apply async review recovery: replay the SAME requestId, read
     running/terminal state, and only continue with a NEW requestId once the
     previous run is terminal. Never overlap a live run;
   - recompute EVERY checkpoint boolean from the evidence table above and
     overwrite state; `state.json` is a cache, not the authority, and disk
     evidence wins every conflict.
3. Commits and pushes already on the remote are not redone.

## Invariants

1. `manifest.json` is written once. If the page list or policy must change, the
   batch is over: start a new `batchId`.
2. Exactly one `initRequestId` per page, persisted before the first init call.
3. One commit per page carries the fix and the report — never two.
4. No page is `done` while a checkpoint is unproven by disk evidence.
5. `state.json` never contradicts disk evidence; on conflict the state is
   rewritten from disk.
6. `writePaths` never include anything under `.dsh/vwa/**` except
   `.dsh/vwa/batches/**`.
7. No grant ⇒ no page work. The batch aborts before checkpoint 1.
8. The batch never adjudicates, signs, or picks a prevailing run.
9. Only `pending` and `active` pages are processed; `skipped`/`failed` wait for
   an explicit reset.
10. A deferred disagreement blocks nothing in the batch, and always blocks
    `eligibleForReviewed`. It surfaces in the ledger, not in the page verdict.
