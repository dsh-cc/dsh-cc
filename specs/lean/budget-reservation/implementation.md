# budget-reservation — implementation record

Acceptance record for the shipped worked example, keyed to the approved proof
digest. This file is outside the proof input digest by design (design section 9,
step 7); routine observations live here, not in `design.md`.

## Run lineage

| Step | Identity |
| --- | --- |
| Proof run | `5a1ea17d-f8a4-437d-a0f6-df83fb5423f4`, verdict `verified` |
| Proof input digest | `52a53a3f169d1dae70c7193fef220168a0c397ec1e576f0067a7d4a44a21457e` (sha256 of `evidence.json`: `ac9753740ba93b27d1a2c1b1c3c6d07c270256b54411632dd06a531880b0c8f4`) |
| Conformance run | `ea1303c4-3134-433b-932c-d052ecf34a46`, verdict `passed`, 228/228 cases matched |
| Conformance execution digest | `12ded2bd9b6a2cb9d7ed602170289afcfcc36aa4d9ad1ca62412837fac5fb542` |
| Proof audit | `--stage proof`: `valid`, `fresh: true`, `proofVerdict: verified` |
| Acceptance audit | `--stage acceptance`: `valid`, `fresh: true`, `conformanceVerdict: passed`, `acceptanceReady: true` |
| Toolchain | `leanprover/lean4:v4.35.0`, content digest `a679a8da92410e33f4e32369da43d2f4552ac1fc8fb434aec9c4ee942d482624` |
| Node | v22.23.2 (strips erasable TypeScript for the `.ts` implementation import) 〔src:ws:specs/lean/budget-reservation-code-anchors.md#L163-L192〕 |

Axiom basis (from the inspector report): `budget-bound` uses `propext`,
`Quot.sound`; `adds-amount`, `rejection-preserves-state` and `zero-request` use
`propext`. All within `allowedAxioms`.

## Observed implementation symbols

- `packages/plugin/dsh-cc-agents/tests/fixtures/formal-design-lean/project/packages/example/src/budget.ts`
  exports `reserve(request): Reservation`. `decode` enforces
  `^(0|[1-9][0-9]*)$` and converts to `BigInt`; JSON numbers are rejected as
  `invalid-amount` (no silent coercion). Branches: shape/field-count →
  `invalid-amount`, `reserved > budget` → `invalid-state`,
  `amount > budget - reserved` → `insufficient-budget`, else
  `{ ok: (reserved + amount).toString() }`.
- `specs/lean/budget-reservation/conformance/adapter.mjs` imports that module by
  ESM resolution relative to itself; it holds no second copy of the algorithm
  and emits protocol-only stdout.
- Model symbols: `Formal.reserve` (guard) and `Formal.reserveState` (documented
  API contract, keeps the prior reservation on rejection).

## Results

Commands run from the repository root against the provisioned pinned root:

```text
lean-preflight.mjs        -> exit 0, status ready
lean-check.mjs            -> exit 0, status verified (4/4 properties)
lean-check-conformance.mjs-> exit 0, status passed (228/228)
lean-check-evidence --stage proof      -> exit 0, valid / fresh
lean-check-evidence --stage acceptance -> exit 0, valid / acceptanceReady true
```

Regression suites (real toolchain):

```text
pnpm exec vitest run packages/plugin/dsh-cc-agents/tests/formal-design-lean-integration.spec.ts \
  packages/plugin/dsh-cc-agents/tests/formal-design-lean-conformance.spec.ts
-> 2 files passed, 11 tests passed
```

## Known-bad mutant

The mutant omitting the `reserved > budget` guard is intentionally not
committed with the model. It stays at
`tests/fixtures/formal-design-lean/mutants/budget-omits-guard.ts` and the
conformance suite demonstrates it failing on `invalid-prior-state`
(`insufficient-budget` instead of `invalid-state`).

## Deviations

None from the approved worked-example semantics. Generated `evidence.json`,
`current-run.json` and `conformance-evidence.json` are machine-local run state
and are gitignored exactly like the existing TLC evidence; `conformance-evidence.json`
was added to the root `.gitignore` per design section 4.

Citation anchors live at `specs/lean/budget-reservation-code-anchors.md`, next
to (not inside) the model directory: the fixed model layout admits no extra
top-level entries, so the markdown citation target sits one level up.
〔src:ws:specs/lean/budget-reservation-code-anchors.md#L1-L7〕
