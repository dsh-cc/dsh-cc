# @dsh-cc/plugin-dsh-cc-math

English | [中文](README.zh.md)

Official dsh-cc plugin for mathematical research. It adds one optional skill,
`math-research`, that turns a natural-language proposition into a Lean 4
statement with a graded fidelity record, searches for a proof under a fixed
budget against Mathlib premise retrieval, and runs discovery loops that only
accept results passing an independent evaluator.

The proof checker is the Lean kernel. Nothing else in this plugin certifies a
proof.

## Status

This is the M0 skeleton: manifest, skill, references, and the evaluation-package
wiring. The `.mjs` runtime scripts (environment provisioning, index build,
retrieval, Lean checking, claim and budget ledgers) land in later waves.

`math-research` gates each milestone on file presence. The M1, M2, and M3
sections of the skill activate only when the scripts they name exist under the
installed skill's `scripts/` directory. An installed skeleton therefore reports
a missing capability instead of claiming a check it cannot run.

## Prerequisites

- Node `^22.19` or `>=24`. Node 24 is recommended: premise retrieval and the
  experience store use `node:sqlite` with FTS5. The scripts feature-detect FTS5
  at start and fail closed with a version diagnostic instead of degrading
  silently.
- Lean 4 with pinned Mathlib. The plugin provisions both once into
  `.math/env/` inside the workspace; the pinned Mathlib revision selects the
  Lean version through its own `lean-toolchain` file. Provisioning is the only
  networked step, it reuses a valid receipt, and nothing is written to your home
  directory.
- Optional: Python `>=3.10` with `sympy` for computational checks. Without it
  `computation_verified` is `not-applicable`, never `pass`.

## Install

```text
/plugin marketplace add dsh-cc/dsh-cc
/plugin install dsh-cc-math@dsh-cc
```

Restart dsh after install. `/skills` then lists `math-research`.

## Quick start

Formalize a stated theorem:

```text
Use math-research to formalize "the sum of the first n odd numbers is n squared"
in Lean 4 and check the statement elaborates. Record the fidelity grade before
any proof attempt.
```

Retrieve premises before inventing them:

```text
Use math-research to search Mathlib for lemmas about the sum of the first n odd
numbers, restricted to the imports of my current proof file.
```

Search for a proof under a budget:

```text
Use math-research to search for a proof with 8 attempts and a 200000-token cap,
and show the diagnostics from each failed attempt.
```

Ordinary mathematical prose is not this skill's job. Neither is asserting a
result that no checker verified.

## What a run produces

Everything lives under `.math/` in your project directory, and `.math/` is
git-ignored. `MATH_HOME` may relocate it to another path; the scripts
feature-detect writability at start and fail closed rather than writing to a
fallback location.

`.math/runs/<run-id>/` holds `run-manifest.json` (all configuration, strict
schema), `problems/<problem-id>/` with the statement, proof, binding, fidelity
and search artifacts, `claims.jsonl` (chain-hashed), `budget.json`,
`evidence/` with receipts, and `report.md`.

Separately, `packages/evaluation/math-eval` carries structure-only evaluation
tooling: the run-manifest schema, the ablation matrix, the metrics report shape,
and fixture/gold-set structure checks. It makes no model calls and is never
boot-mounted as a plugin.

## Limits

- Only the Lean kernel decides proof correctness. No model judgement, and no
  score from this plugin, certifies a proof.
- Statement fidelity is graded, not assumed. Two of its three checks are model
  judgements, so a false accept is possible; it is measured and reported, and
  the `anchored` grade applies only where a trusted reference formalization
  exists.
- Computational checks run inside the session are advisory: without network
  isolation a failure is never used as counterexample evidence or as
  `computation_verified: fail`. Authoritative failures need an isolated runner.
- Token spend after dispatch is cooperatively bounded. Admission control is
  exact and tested; a child that ignores its envelope can overspend it.
- Proof search is attempt-level. There is no tactic-level interactive state, no
  Lean IDE, and no MCP server.
- Novelty reporting is advisory and carries no mathematical novelty claim.
- Version 1 supports one writer of shared state: the main conversation.
  Delegated children write only their own attempt directory.

## Resources

The package includes the
[skill](skills/math-research/SKILL.md) and its references:
[formalize](skills/math-research/references/formalize.md),
[prove](skills/math-research/references/prove.md),
[discover](skills/math-research/references/discover.md),
[evidence](skills/math-research/references/evidence.md), and
[budget](skills/math-research/references/budget.md). Relative resources resolve
from the installed skill directory; a repository checkout is not necessary.

The system design is
[docs/plans/2026-11-21-mathematical-research-harness.md](../../../docs/plans/2026-11-21-mathematical-research-harness.md)
in the dsh-cc repository.
