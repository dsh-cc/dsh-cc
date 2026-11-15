# Design: vwa-render-commit-probes

Sibling of `specs/tla/vwa-render-commit`. `Model.tla` here is a byte-identical copy of the main
model; this directory exists so the six deliberately-failing probe cases do not pollute the main
model's aggregate verdict.

Behavioral source: `docs/plans/2026-11-15-vwa-autonomous-render-pipeline.md` §4.2, §4.3, §4.5,
§7.1, §7.2, §10.1.

## Screening

- mode: auto · decision: enabled · backends: `["tla"]`
- triggerIds: FD-T3 (crash recovery ordering of deliverable / intent / HEAD), FD-T2 (retried or
  replayed bind, unrelated transaction between crash and retry), FD-T1 (author edit vs runtime bind
  on shared artifact state).
- Lean excluded: no authorization/eligibility composition with a stated behavioural consequence and
  no arithmetic bound. No obligation is downgraded — none exists.
- modelDirs: `["specs/tla/vwa-render-commit-probes"]` · modelDir: same.
- userDirective: session request "如果有必要，使用formal-design建模或修改存量模型，从而确保设计没有缺陷".

## Probe ↔ wrong design

| Case | Constant | Wrong design modeled | Invariant that catches it |
|---|---|---|---|
| strict-non-atomic | `NonAtomicWrite` | stage 10 writes in place instead of temp+fsync+rename, so a crash leaves a partial file | `NoTornOutput` |
| strict-misclassify-stale | `MisclassifyStale` | §7.2 collapses the stale branch into `input-changed` (the v2 defect all three r2 seats found) | `ProvisionalIsStale` |
| strict-span-overlap | `AllowOverlap` | bind accepts an occurrence intersecting a stripped marker range | `SpanSafety` |
| strict-overwrite-foreign | `OverwriteForeign` | first bind clobbers a pre-existing user file without `overwrite: true` | `NoLostUserFile` |
| strict-adopt-without-render | `AdoptWithoutRender` | HEAD adopts a content hash that does not describe the staged bytes, then clears its bookkeeping so the corruption is silent | `AgreementWhenQuiescent` |
| strict-skip-intent | `SkipIntent` | publication without the §7.1 render intent, so a crashed roll-forward has no recoverable provenance and misreads as drift | `ProvisionalIsStale` |

`convention` (core) is the correct design and is `verified` here as well, so this directory is
self-describing: green core, red probes.

## Expected verdicts

`convention` verified; each `strict-*` case a counterexample on the invariant named above. A probe
that comes back `verified` means the probe became unreachable and must be repaired (this happened
twice during authoring — see the main model's `implementation.md`, defects 2 and 3).

## Bounds

`MaxRev = 3`, two requests, two draft versions, two render identities — identical to the main model.
