# Feature E: validated experience and scoped recall

- Status: proposed.
- Parent: [Harness experiments](2026-10-19-harness-experiments.md).
- Package: `packages/evaluation/harness-experience` (`@dsh-cc/harness-experience`, private).
- Depends on: [A](2026-10-19-harness-feature-a-contracts.md), [C](2026-10-19-harness-feature-c-evaluation.md), [D](2026-10-19-harness-feature-d-optimization.md).

## 1. Problem and solution

A generic memory sentence loses the context, exact configuration change, supporting runs, and counterexamples that made a lesson useful. A repeated correction can be valuable but remain unvalidated. Automatically injecting all such lessons risks moving a model-specific workaround into unrelated tasks.

Keep a dedicated, versioned experience registry. Separate proposed hypotheses from validated lessons. Require a passing independent confirmation decision and an explicit promotion command. Recall is an opt-in, deterministic selection of compatible validated records, not a background write into user memory.

## 2. Record and lifecycle

```ts
interface ExperienceRevision {
  schemaVersion: 1; lessonId: string; revision: number;
  previousRevisionDigest: Digest | null;
  status: 'proposed' | 'validated' | 'deprecated';
  createdAt: string;
  scope: {
    projectId: string; domain: string; taskAdapterDigest: Digest;
    solverRouteDigest: Digest; reviewerRouteDigest: Digest;
    surfaceDigest: Digest; baselineSnapshotDigest: Digest;
    runtimeImageDigest: string; policyDigest: Digest;
  };
  cue: string; lesson: string; limitations: string;
  baselineDigest: Digest; candidateDigest: Digest;
  patchDigest: Digest;
  evidenceRuns: string[]; decisionDigest: Digest | null;
  counterexamples: { runId: string; findingRefs: string[]; summary: string }[];
  supersedes: string[];
  origin: { kind: 'experiment' | 'learn-finding'; reference: string };
  actor: string; reason: string;
}
```

Strings cue/lesson/limitations/reason are nonempty and at most 4000 UTF-16 units; actor is a controller-supplied local operator label of at most 512 units, not a claimed verified identity. IDs and digests follow A. `evidenceRuns` and `supersedes` are sorted, unique, maximum 1000; counterexamples are sorted by runId, maximum 1000. Full run data and complete baseline/candidate trees remain in A's content store; the registry references them rather than summarizing away the evidence.

Lifecycle: new records are `proposed`; `proposed → validated` requires promotion; either active state can become `deprecated`; deprecation is terminal. Revising a validated lesson's cue, lesson, patch, or scope creates a new proposed lessonId rather than preserving its validation. A metadata-only counterexample addition creates a new revision with the same status unless it triggers automatic deprecation below. Superseding creates a new independently validated lesson and explicitly deprecates the old record; no silent replacement.

Store registry revisions at `<store>/experience/<projectId>/<lessonId>/<revision>.json` and HEAD at the lesson directory. `projectId` is the SHA-256 hex of the canonical repository identity (normalized remote URL without credentials; if absent, canonical real workspace root), prefixed `prj_`. The controller computes it, not the model. A workspace moved without a remote becomes a new project. No cross-project recall or global export/install exists in v1.

Registry writes use A's canonical serialization, immutable blobs, exclusive project writer lock, and atomic HEAD. Revisions increment by one using `expectedRevision`; a stale writer gets `REVISION_CONFLICT`. Verify all referenced blobs before publishing a new HEAD. Registry events record promotion, recall, and deprecation. Never amend an old decision or receipt.

## 3. Promotion and deprecation rules

`promote(lessonId, expectedRevision, decisionDigest)` performs these checks in one locked transaction:

1. Record is proposed and every referenced run/snapshot exists and verifies.
2. C's decision is `eligible-for-promotion`, uses a sealed holdout experiment, and references exactly this baseline and candidate.
3. All confirmation samples have enforced isolation and known solver accounting; the record's scope is copied from their effective configuration, not supplied by the proposer.
4. No counterexample in the record contains an unresolved new blocker or regression under the same scope.
5. Text is operator-reviewed: command requires an explicit `--reviewed` flag, prints the text and evidence in `show`, and stores the actor label. This is a local command intent check, not a second runtime permission prompt.

Only then append validated revision. A manual flag cannot bypass a failed decision. Promotion does not install a skill, modify memory, or enable recall. Development-only, upstream external-research, incomplete, unverified, and unknown-cost evidence remain proposed.

`deprecate` requires `--reason` and expectedRevision. Automatically deprecate a validated record only when a newly imported, verified C decision for the exact same scope and patch reports a new blocker or task regression; attach that decision as a counterexample. Unknown or missing data sets a recall exclusion reason `EVIDENCE_UNAVAILABLE` without pretending the lesson was disproved. Changed model versions make a lesson ineligible under the new scope, not globally deprecated.

A route with `revision:null` cannot support a validated lesson persisting across experiments in v1. It may support a proposed experience and an explicitly bounded task refinement, but cross-task validated promotion returns `IDENTITY_MISMATCH` detail `UNPINNED_PROVIDER_REVISION`. This conservative limit avoids treating a mutable model name as a stable identity. The report must disclose the restriction; do not invent a revision.

## 4. Deterministic recall

`selectExperiences(query)` accepts `{projectId, domain, snapshotDigest, taskAdapterDigest, surfaceDigest, policyDigest, maxEntries, maxBytes, explicitLessonIds}`. Defaults are 3 entries and 16384 UTF-8 bytes total; bounds are 0–10 entries and 0–65536 bytes. Zero disables recall. Caller supplies explicit lesson IDs; automatic semantic discovery and embedding search are deferred.

For each explicit ID, resolve its HEAD and require validated status, exact project/domain/adapter/surface/policy/image/solver/reviewer identity, and the same baseline snapshot digest. Reject missing evidence, deprecation, or incompatible scope with a stable reason in the recall report. Sort eligible IDs lexicographically. Include whole entries in order until the next would exceed either cap; mark the remaining entries `BUDGET_EXCLUDED`. Never truncate a lesson's evidence qualifiers to fit. The returned bundle contains lesson text, limitations, digest, patch digest, and references; it does not apply the patch.

Two recalled lessons may propose overlapping file changes. In v1 they are advisory inputs to D only. D must produce one new candidate, probe it, and pass C before the combined patch can be promoted. Do not merge or execute experience patches during recall. F likewise treats recalled lessons as advisory input. This avoids claiming that separately validated changes remain valid when combined.

Record the exact selected revision digests in A's experiment plan and snapshot input files. A subsequent registry revision does not mutate a running experiment; a new experiment may select the newer revision. Explicit recall of an incompatible lesson is rejected, not silently broadened.

## 5. `/learn` integration and commands

Do not change the syntax, default behavior, managed blocks, or writeback of the existing `/learn` command. Add a separate CLI import command:

- `harness-experience import-learn --finding <json> --project <root> --snapshot <digest>`: validate a `session-forensics` finding and its session anchors; create a proposed record with origin `learn-finding`. Its baseline and candidate both reference the supplied verified snapshot, and its patch is the canonical empty overlay. The controller derives scope from that snapshot and the finding's declared domain/adapter; missing scope fields reject the import. Such a record cannot be promoted. D must create a new experiment-origin proposed record for its concrete patch, referencing the imported lesson as an input, before C confirmation can support promotion. Importing twice with the same finding digest is idempotent.
- `harness-experience propose --experiment <id> --candidate <id> --text <json>`: create a proposed record from a completed development experiment.
- `harness-experience show --lesson <id>`: display scope, complete text, evidence, counterexamples and current state.
- `harness-experience promote --lesson <id> --expected-revision <n> --decision <digest> --reviewed`: perform the transaction above.
- `harness-experience deprecate --lesson <id> --expected-revision <n> --reason <text>`.
- `harness-experience export --lesson <id> --out <new-directory>`: write a reviewable manifest, exact overlay files, baseline hashes, and evidence report. Refuse a nonempty directory or paths inside tracked skill/config roots. It never executes `git apply`, writes to `MEMORY.md`, or changes an installed plugin.

Adopt C's exit codes. Adding a TUI preview or an in-product recall toggle is out of scope. Standard memory/consolidation MUST NOT scan this registry.

## 6. Acceptance and TDD sequence

| Case | Required outcome |
| --- | --- |
| Repeated `/learn` finding without execution experiment | Proposed only; existing memory untouched |
| Passing development candidate without holdout decision | Promotion rejected |
| Forged decision, missing evidence, changed candidate | Promotion rejected |
| Explicit reviewed flag with failed decision | Still rejected |
| Valid confirmation under pinned model revision | Validated revision; no installation |
| Null provider revision | Proposed allowed; cross-task validation rejected |
| Different project, model, image, policy, baseline, or domain | Recall excluded with specific reason |
| Compatible entry exceeds byte cap | Whole entry omitted; no qualifier truncation |
| Two overlapping lesson patches | Advisory only; no automatic merge |
| Counterexample adds an exact-scope blocker | Append counterexample and deprecated revision atomically |
| Concurrent promotion or deprecation | Expected-revision conflict; no lost update |
| Corrupt blob or missing evidence on recall | Entry excluded; experiment does not substitute a summary |

Validate the registry, transitions, selection order, and export with deterministic fixtures. A live model is unnecessary for E's correctness tests. The release note must state that this registry stores qualified experimental evidence, not proven universal rules.
