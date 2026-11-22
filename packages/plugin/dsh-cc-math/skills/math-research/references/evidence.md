# Evidence — verification records, receipts, claims and close-out

How L2 verdicts, L1 tiers and claims become durable evidence (design §4.1,
§4.4, §6.3, §9). Three correctness kinds stay separate: `computation_verified`
(pass | fail | not-applicable), `formal_proof_valid` (the kernel's answer
only), `statement_faithful` (graded; M1 fills the gate).

## L2: lean-run.mjs (proof binding, §4.4)

```
node "${CLAUDE_SKILL_DIR}/scripts/lean-run.mjs" --problem <dir> --env <env-dir> --statement-check
node "${CLAUDE_SKILL_DIR}/scripts/lean-run.mjs" --problem <dir> --env <env-dir> [--attempt-id a-003] [--timeout-ms 300000] [--expect-hashes hashes.json]
```

- `--statement-check` elaborates `statement.lean` (its `:= sorry` is
  tolerated HERE ONLY) and records the elaborated type of
  `statementDeclName` into `binding.json` (`statementTypeText`). Proof mode
  requires that record and never imports the sorry-ed declaration.
- Proof mode builds `proof.lean` in the attempt's OWN build directory
  (`attempts/<id>/build/`) with its own wrapper-lakefile copy pointing at the
  shared immutable env (per-attempt isolation, §4.2).
- Binding: `proofDeclName` exists as a theorem; the two recorded elaborated
  propositions are definitionally equal (Inspector.lean, term-level
  `isDefEq`); the scoped axiom audit admits only
  `{propext, Classical.choice, Quot.sound}`.
- Failure classes (status `failed`, exit 1): `lean-error` (any error),
  `sorry` (sorry-bearing diagnostic — message code first, substring on
  `"declaration uses 'sorry'"` as fallback), `unparseable` (raw preserved
  verbatim), `binding`, `axiom-violation`, `timeout`, `io`, `hash-mismatch`.
  Other warnings do NOT fail.
- Report JSON on stdout: `{ status, diagnostics[], binding, axioms[],
  hashes }`. `hashes` = sha256 of statement.lean + proof.lean + binding.json +
  env receipt digest; `--expect-hashes` re-checks and any change invalidates
  (exit 1, `hash-mismatch`). Exit `2` = blocked (config/env receipt errors).

## L1: sympy-run.mjs tiers (§4.4)

`--script checker.py [--work-root <dir>] [--timeout-ms 60000]` runs the
generated checker with a fresh temp cwd under `.math/`, wall+CPU limits.
`isolation: full` (MATH_EVAL_ISOLATION=full, or CI Linux netns marker) makes a
fail authoritative; `partial` (in-session) makes it advisory-only and may
never serve as counterexample evidence — a partial run claiming `fail` is a
ledger error. No Python ≥3.10+sympy → `not-applicable`, never pass/fail.
Exit 3 on timeout/spawn error.

## Claims: claim-ledger.mjs (§6.3 M0 core)

```
node "${CLAUDE_SKILL_DIR}/scripts/claim-ledger.mjs" open --run <dir> --claim-id c-1
node "${CLAUDE_SKILL_DIR}/scripts/claim-ledger.mjs" transition --run <dir> --claim-id c-1 --to proven-of-formal-statement \
                                                        --records records.json [--statement-faithful model-assessed]
node "${CLAUDE_SKILL_DIR}/scripts/claim-ledger.mjs" verify|status --run <dir>
```

- States (M0, explicit enumeration — unknown states exit 2): `open`,
  `proven`, `proven-of-formal-statement`, `falsified`, `superseded`,
  `fidelity-failed` (terminal: the last two).
- Legal edges: `open→proven` (l2-pass + fidelity anchored|human-confirmed +
  no outstanding full-isolation counterexample) · `open→proven-of-formal-statement`
  (l2-pass + model-assessed) · `open→falsified` (full-tier counterexample, or
  lean-negation) · `proven-of-formal-statement→proven` (fidelity upgrade +
  guard) · `proven|proven-of-formal-statement|falsified→superseded`
  (fidelity-correction) · non-terminal `→fidelity-failed` (dispute;
  `allowHumanFidelity: true` additionally requires an adverse human-ruling
  record).
- Records are TYPED: `{kind ∈ l2-pass|fidelity|counterexample|
  fidelity-correction|dispute|human-ruling|lean-negation, verdict,
  bindingHashes?, isolation?, mechanism?, evidence?}` — produced by the
  verifier scripts, never by assertion. `evidence: [{path, sha256}]` is
  re-hashed at append time (path exists + sha256 matches; exits 2 otherwise).
- Chain hash: `sha256(canonicalJson(entry sans hash) + "\n" + prevHash)` over
  fixed-order canonical bytes; `verify` detects ANY field edit (exit 2).
  Appends rewrite the whole file atomically.
- ILLEGAL transitions exit 2. There is no weaker path to `proven` than the
  table; `experiment-supported`/`revalidation-pending` arrive with M3.

Evidence layout: `evidence/<claimId>/<kind>/…` + `RECEIPT.json` (all file
sha256s, generating command, timestamp, §9.4). `report.md` cites claims with
their receipt verification results. Novelty is advisory only, never a gate.

## Environment receipts (§3.2, §4.2)

`mathlib-env.mjs status|provision|verify --dest .math/env/<env-id> [--pin …]`;
`env-id = <mathlibRev>-<platform>`. A valid receipt is reused as-is; an
INVALID receipt is a hard error (`receipt-invalid`), never a silent rebuild —
remove the directory to reprovision. `verify` re-checks digests offline.
`mathlib-index.mjs build --env <env-dir>` is idempotent per receipt digest;
`mathlib-search.mjs --query … [--imports file.lean]` retrieves within the
transitive import closure of that file (exit 0 with `[]` on no matches;
exit 2 with the raw error on FTS5 syntax errors).

**Filling `scripts/mathlib-pin.json` before first provisioning** (an offline
agent cannot know these bytes; the fields exist and provisioning is
`config-invalid` until they are filled):

1. `mathlib.sha256` — sha256 of the GitHub source tarball
   `https://github.com/<repo>/archive/refs/tags/<rev>.tar.gz`
   (`curl -sL <url> | shasum -a 256`).
2. `expectedLean` — content of mathlib's `lean-toolchain` at that rev
   (mismatch at provision time is `config-invalid`).
3. `leanToolchain: {toolchain, platforms: {<platform>: {archiveUrl, sha256}}}`
   — the matching Lean release archive per platform (same pin discipline as
   formal-design's `lean-toolchain.json`).

## Memory close-out (§7.1, M1 procedure referenced here for evidence flow)

At run end, durable conclusions go to `memory_save`, one fact per topic file:
theorems/counterexamples → type `reference` (name slug
`math-<problem-id>-<claim-kind>`), run/ledger state → type `project`
(`math-run-<run-id>`); description names the claim id and the receipt-verified
evidence path. Facts are recorded only for claims whose `claim-ledger verify`
passes.
