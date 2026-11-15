# Design: vwa-adjudication-durability-probes

Sibling of `specs/tla/vwa-adjudication-durability` (byte-identical `Model.tla`).

## Screening

- mode: auto · decision: enabled · backends: `["tla"]`
- triggerIds: FD-T2 (append-only review records change whether a human decision still applies),
  FD-T1 (human adjudication and the review process act independently on shared state).
- Lean excluded: no arithmetic bound or conservation (the cohort is a set, not a counter), no
  permission composition.
- modelDirs/modelDir: `specs/tla/vwa-adjudication-durability-probes`
- userDirective: session request "如果有必要，使用formal-design建模或修改存量模型".

## Probe ↔ wrong design

| Case | Constant | Wrong design modeled | Invariant that catches it |
|---|---|---|---|
| strict-content-digest | `LegacyContentDigest` | liveness pinned to the identity of the two named records (which never change), so a fresh judgment cannot expire the human decision — the "decision never dies" failure | `SemanticsPinned` |
| strict-random-id | `RandomId` | a fresh dispute id minted on every evaluation, so a re-evaluation loses the match and the dispute re-opens although nothing changed — the current `review-current.ts:66-73` bug | `SemanticsPinned` |

`convention` (core, correct design) is `verified` here as well.

## Expected verdicts

`convention` verified; both `strict-*` cases counterexamples. A probe returning `verified` means it
became unreachable (see the main model's `implementation.md`, R1–R4).

## Bounds

`MaxRuns = 3`, two dispute identities, two verdicts, two decision kinds.
