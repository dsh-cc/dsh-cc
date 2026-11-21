# Budget — reservation, settlement and replay

Operational contract for `budget-ledger.mjs` (design §3.3 single-writer
discipline, §5.3 budget semantics). Read this BEFORE the first reservation.

## Rules that are enforced

- **Single writer.** Only the main conversation's process writes
  `budget.json`. Reservations happen strictly BEFORE dispatching a child, so
  read-modify-write is serialized by construction — no lock.
- **Atomic writes.** Every mutation rewrites the whole file (temp + rename);
  the intent log inside `budget.json` is included. There is no byte-append
  anywhere.
- **Admission is exact** (§5.3). `reserve` is granted only if
  `charged + new envelope ≤ budget.tokens`, where
  `charged = settled usage + retained discarded charges + outstanding envelopes`,
  AND `intents + 1 ≤ budget.attempts`, AND the run deadline
  (`createdAt + budget.wallClockMs`) has not passed. Refusal exits 2.
- **Consumption after dispatch is cooperative.** Envelopes are prompt-level
  instructions to children, not mechanical ceilings. No numerical overshoot
  guarantee is claimed.
- **Settlement is opId-keyed and idempotent.** `settle` replaces the
  reservation (or a retained rollback charge, when late evidence arrives)
  with actual usage; the same settlement twice changes nothing.
- **Rollback never refunds** (§3.3/v4). `rollback-unsettled` marks
  outstanding intents `discarded` and RETAINS the envelope as a conservative
  charge (settled at face value, since actual usage is unknowable) until a
  later settlement with real usage replaces it. Charges can neither be lost
  nor double-counted.
- **Resume replay has a fixed order** (§3.3/§5.1): (1) reconcile unsettled
  intents against `result.json` files by sha256 hash first; (2) then roll
  back whatever is still unsettled. Replay is idempotent.

## Commands

All result paths print one line of JSON on stdout. `--help` prints text.

```
node "${CLAUDE_SKILL_DIR}/scripts/budget-ledger.mjs" init --run .math/runs/<run-id>
                                                   # caps from run-manifest.json (strict schema); idempotent; refuses cap change
node "${CLAUDE_SKILL_DIR}/scripts/budget-ledger.mjs" reserve --run <dir> --op-id op-7 --envelope-tokens 25000 \
                                                     [--problem-id p-001] [--attempt-id attempt-003]
node "${CLAUDE_SKILL_DIR}/scripts/budget-ledger.mjs" settle --run <dir> --op-id op-7 \
                                                     --prompt-tokens 9400 --completion-tokens 3100 [--result-hash <sha256>]
node "${CLAUDE_SKILL_DIR}/scripts/budget-ledger.mjs" rollback-unsettled --run <dir>
node "${CLAUDE_SKILL_DIR}/scripts/budget-ledger.mjs" resume --run <dir> --results <dir>   # reconcile by result hash, THEN roll back
node "${CLAUDE_SKILL_DIR}/scripts/budget-ledger.mjs" status --run <dir>
```

Exit codes: `0` ok · `2` blocked/refused (`budget-exceeded`, `attempt-cap-exceeded`, `deadline-exceeded`, `config-invalid`, `ledger-missing`, `unknown-op`).

`status` reports `totals`: `settledTokens`, `outstandingReservedTokens`,
`discardedChargeTokens`, `chargedTokens`, `remainingTokens`, `attemptsUsed`
against `attemptsCap`, plus `deadline` / `afterDeadline`. Default caps (§9.1,
written out): attempts 8, tokens 200000, wall-clock 1800000 ms; the envelope
default for one attempt is 25000 tokens.

## Run skeleton

`init-run.mjs init --runs-root .math/runs --run-id <id> [--manifest <file>]`
creates the §9.1 directory (`run-manifest.json` with defaults materialized,
`problems/`, `population/`, `claims.jsonl`, `budget.json`, `evidence/`,
`report.md`) and refuses to reinitialize an existing run.
