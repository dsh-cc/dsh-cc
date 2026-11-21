# Prove — search loop, repair rounds and scaffolding

Operational contract for `search-state.mjs` (design §5.1 state schema, §5.2
repair rounds, §5.4 scaffolding, §3.3 resume order). Read this before the
first `add-attempt`; read [budget.md](budget.md) before the first reservation.

## State file

`problems/<problem-id>/search.json`, schemaVersion 1, one writer (the main
conversation), every mutation a whole-file atomic rewrite:

```json
{ "schemaVersion": 1, "runId": "…", "problemId": "p-001", "lineage": [],
  "status": "running",
  "goals":    [{ "id": "g-001", "parent": null, "statementShape": "…",
                 "state": "open|in-progress|closed|abandoned", "closedBy": null }],
  "attempts": [{ "id": "attempt-001", "goalId": "g-001", "repairRoundsUsed": 0,
                 "dir": "attempts/attempt-001/", "opId": "op-7",
                 "status": "pending|running|passed|failed|discarded",
                 "inputHash": "<sha256|null>", "resultHash": "<sha256|null>" }],
  "scaffolds":[{ "goalId": "g-001", "childProblemId": "p-002", "depth": 1,
                 "connectingImplication": "…", "state": "open|child-proven|integrated|dead",
                 "scaffoldOf": "p-001" }],
  "scheduler": { "nextAttemptId": 2, "branchPolicy": "serial-2-then-parallel" } }
```

`lineage` is the ancestor-problem chain (root first, this problem excluded). It
is what makes depth counting and cycle rejection decidable: a scaffold's depth
is `lineage.length + 1`, and a child problem on the lineage is a cycle.

`status` has two kinds of value. `solved` and `unsolved-with-progress` are
derived from the goal graph on every mutation (all goals closed → `solved`;
all goals closed-or-abandoned → `unsolved-with-progress`). `budget-exhausted`
and `fidelity-failed` are decisions recorded with `set-status` and are never
overwritten by derivation.

## One attempt, in order

```
budget-ledger.mjs reserve --run <run> --op-id op-7 --envelope-tokens 25000 \
                          --problem-id p-001 --attempt-id attempt-001
search-state.mjs add-attempt --search <search.json> --goal-id g-001 --op-id op-7 \
                          --inputs <prompt-inputs.json>
   # … dispatch the attempt (serial for the first 2, parallel afterwards) …
search-state.mjs record-result --search <search.json> --attempt-id attempt-001 \
                          --result attempts/attempt-001/result.json
budget-ledger.mjs settle --run <run> --op-id op-7 --prompt-tokens … --completion-tokens …
```

The reservation comes first and carries the opId, because the write-ahead
intent is what makes a crash recoverable (§3.3). A child never reserves and
never writes shared state; it writes `attempts/<id>/` and returns.

`result.json` (per attempt) is the typed record:

```json
{ "attemptId": "attempt-001", "status": "passed|failed",
  "diagnostics": { "…lean-run report…" },
  "usage": { "promptTokens": 9400, "completionTokens": 3100 },
  "closedGoals": ["g-001"],
  "inputHash": "<sha256 of the prompt inputs this result answers>",
  "verification": [{ "kind": "l2-pass", "verdict": "pass",
                     "bindingHashes": { "combined": "<sha256>" } }] }
```

**Closure rule.** A goal closes only when `status` is `passed` *and*
`verification` carries `{kind:"l2-pass", verdict:"pass", bindingHashes}` — the
typed record `lean-run.mjs` produces after a full L2 check with proof binding.
A result whose only evidence is a diagnostics report is refused (exit 2) and
closes nothing. If a result claims `passed` without that record, the whole
result is refused: there is no "probably fine" path.

## Repair rounds (§5.2)

At most **2** repair rounds per attempt. A repair round is a new prompt with
the full diagnostics JSON + current `proof.lean` + the statement type; it
consumes that attempt's token envelope and does **not** mint a new attempt id
(so it does not consume the attempts axis). The third `add-repair` exits 2 with
`repair-cap-exceeded`: escalate to a new attempt, a scaffold, or a stop.

## Scaffolding (§5.4)

Retrieval first (reformulate the query, extend the import set). If the goal
stays stuck, degrade it into a subgoal **with a required connecting
implication** — a subgoal without one is not a scaffold, it is scope creep.

```
scaffold-open     --goal-id g-001 --child-problem-id p-002 --connecting-implication "<prop>"
scaffold-advance  --goal-id g-001 --child-problem-id p-002 --to child-proven --records <records.json>
scaffold-advance  --goal-id g-001 --child-problem-id p-002 --to integrated
scaffold-advance  --goal-id g-001 --child-problem-id p-002 --to dead --cause <cause>
```

| edge | requires |
| --- | --- |
| `open → child-proven` | the child's own `{kind:"l2-pass", verdict:"pass"}` record (its claim is recorded independently) |
| `child-proven → integrated` | the parent goal is already `closed` by its own checked proof |
| `open → dead` | any one of the six causes |
| `child-proven → dead` | `implication-undischarged` or `parent-abandoned` |

Death causes, enumerated and exhaustive: `child-falsified`,
`child-fidelity-failed`, `child-unsolved-with-progress`,
`child-budget-exhausted`, `implication-undischarged`, `parent-abandoned`.
Any child terminal other than a proven claim marks the scaffold `dead`; the
parent goal stays open and the other branches continue.

Depth counts nodes with a cap of **3**. Attempting the fourth level does not
create a scaffold: it terminates that branch — the goal becomes `abandoned` —
and the problem keeps its other goals and stays running. Cycles are rejected
through `lineage`/`scaffoldOf`, so a child may never be this problem or one of
its ancestors.

## Resume (§3.3/§5.1 fixed order)

```
search-state.mjs resume --search <search.json> [--results <dir>]
budget-ledger.mjs resume --run <run> --results <dir>
```

1. **Reconcile first.** Every in-flight attempt is matched against a
   `result.json` (in its own `attempts/<id>/`, or anywhere under `--results`).
   The record is adopted only when its `attemptId` matches, its `inputHash`
   matches the recorded dispatch hash, and the file's sha256 equals the recorded
   `resultHash` when one exists. A malformed, foreign or byte-changed result
   discards the attempt and reopens its goal.
2. **Re-verify adopted results.** An attempt whose recorded `resultHash` no
   longer matches the file on disk is a tampered attempt: discarded, goal
   reopened.
3. **Only then roll back** whatever is still unsettled: those attempts become
   `discarded`, and their `opIds` are reported so the charge side can run.

The charge side is `budget-ledger.mjs` (never refunds). `search-state.mjs` does
not touch `budget.json` — two writers on one file is exactly what §3.3 forbids.

## Stop conditions

- Every attempt for a goal failed and no scaffold is live → the goal is stuck;
  scaffold (if depth < 3) or abandon it explicitly.
- The reservation is refused (`budget-exceeded`, `attempt-cap-exceeded`,
  `deadline-exceeded`) → record the stop with `set-status --status
  budget-exhausted`; never dispatch unpaid work.
- `fidelity-failed` on the statement → stop proving; nothing downstream of an
  unfaithful statement is worth checking.
