# Implementation record: decision-quota-accounting (Lean face)

Effective project rules at modeling time: the root AGENTS.md carries **no**
formal-design screening clause — screening is session-adopted (user request
2026-11-02; full-program scope confirmed via ask_user_question). Adoption
snippet: `<skill>/references/agents-snippet.md`. No formal review dispatched.

## Final proof run

- runId: `a1ea28a7-0d52-48f5-87ef-1b0e4eb05711`
- inputDigest: `78b35e8763be8c74ffa9dc3f94581a36576c3fdcc169711e6957b17d95cd851c`
- toolchain: leanprover/lean4 v4.35.0 (darwin-arm64, archive SHA-256
  c0c6f34f...63177c2, content digest a679a8da...482624, provisioned under the
  system temp directory), runner `@dsh-cc/plugin-dsh-cc-agents`
  0.9.3-rc.4.
- All six properties **verified**: conservation
  (`retainedTotal_le_reservedTotal`), unknown/unsettled upper bounds,
  not-dispatched refunds, actual bills exactly the usage, settlement never
  raises the retained amount.
- `lean-check-evidence --stage proof`: valid and fresh, proofVerdict
  `verified` (runId and inputDigest as above). Conformance is
  **not-run** by design: S1-02 is not implemented, so there is no production
  module to bind the adapter to; `acceptanceReady` is accordingly false
  (proof-only result, never implementation acceptance).

## Findings from the proof work (modeling notes)

- The conservation theorem required the ledger totals to be stated with
  `List.sum` (the foldl formulation defeats the `omega`/calc bridge between
  the goal and the induction hypothesis).
- The overrun path (usage above the reserved upper bound) is deliberately
  outside the theorem: the design routes it to the accounting-error
  freeze. The projection clamps to the reservation so conservation stays
  a theorem of the ledger's non-error states.
- Provisions blocker note: `lean-provision --dest /tmp/...` fails on macOS
  because the fingerprint's realpath of a relative symlink inside the
  archive resolves through /tmp → /private/tmp and escapes the given
  root; provisioning under `/private/tmp` directly works. This is a
  machine-path artifact, not a toolchain issue.

## Not verified (explicitly out of scope)

- Implementation conformance (no production module exists yet — the corpus
  is empty and the adapter is a documented placeholder).
- The TLA+ interleaving properties (crash recovery, lock, double
  settlement) — those live in `specs/tla/decision-runtime-quota` (M1).
- Pricing, `/cost` rendering and the settings cascade.

## Conformance stage (acceptance)

- Status: **passed** — `lean-check-evidence --stage acceptance` reports
  `acceptanceReady: true`. Proof `7d12244d-11f7-485d-b5c9-2d9b85d44f52` plus the conformance
  run form the acceptance pair.
- Corpus: `conformance/cases.jsonl` (14 cases, every case
  declaring the properties it covers); every case matched under
  `canonical-json` comparison.
- Binding: `packages/observability/decision-usage` does not exist yet, so conformance binds a model-local fixture implementation in the plugin test fixtures; the adapter must be re-pointed at the production `quota.ts` projection when S1-02 lands.
- The fixture is a reference implementation, never a second copy of a
  production algorithm: when the production module exists the adapter is
  re-pointed and the fixture deleted.
