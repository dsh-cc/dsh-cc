# Artifact contracts

The script validators are the source of truth. This file is a summary for
reading and writing artifacts; it is not a schema definition. When this file
and the scripts disagree, the scripts win.

| Artifact | Validator |
| --- | --- |
| Brief, run, plan, research, context | `../scripts/contracts.lib.mjs` |
| Review, proposal, check, application, profile | `../scripts/check-profile.lib.mjs` |
| Shared field readers and limits | `../scripts/schema.lib.mjs` |

`record` takes one artifact and rejects unknown properties, unknown
`schemaVersion` values, and any model-supplied hash. Validate before any
mutation. Write JSON with LF, two-space indentation, and a final newline.

Common rules:

- UTF-8 without Unicode normalization. Hash the exact bytes with SHA-256 as
  lowercase hexadecimal.
- Model spans are half-open UTF-16 code-unit offsets in the decoded body. A span
  boundary inside a surrogate pair is invalid input.
- IDs are UUID v4, except section IDs (`s[1-9][0-9]*`), question IDs
  (`q[1-9][0-9]*`), and IDs returned by VWA.
- Every path in a run is a workspace-relative POSIX path. Absolute paths, NUL,
  `..` segments, and realpaths outside the workspace are invalid.
- Nullable fields must be present and explicitly null.

## 1. Brief

`schemaVersion`, `kind:"brief"`, `runId`, `operation` (`write|review|edit`),
`question`, `audience`, `language` (`zh|en`), `bodyPath`, `companionPath`,
`profile` (`technical|research|opinion|technical-ste`), `targetLength`
(`null` or `{min,max}` with `0 < min <= max`), `requiredQuestions`
(`[{id,text}]`, at least `q1`), `sourceScope`
(`{localPaths,webAllowed,description}`), `evidenceMode` (`ordinary|vwa`),
`allowBodyChanges`, `repairRounds` (0..3, default 1), `protectedTerms`,
`styleOverrides`, `defaultsApplied`.

`brief.json` is immutable after `init`. A later change returns `STALE_BRIEF`
(exit 3); start a new run instead.

## 2. Run

`schemaVersion`, `kind:"run"`, `runId`, `briefHash`, `phase`, `outcome`,
`bodyHash`, `planHash`, `replaceExisting`, `structuralRound`, `languagePass`,
`languageIntentsUsed`, `semanticRepairUsed`, `acceptedBodyHash`,
`appliedProposals`, `artifactPaths`, `vwa`, `usage`, `createdAt`, `updatedAt`,
`model`.

`phase` is one of `initialized`, `researched`, `planned`, `drafted`,
`diagnosed`, `structurally-revised`, `language-revised`, `checked`,
`finalized`. `outcome` is `active`, `blocked`, `cancelled`, or `completed`.
Timestamps are ISO 8601 UTC.

`acceptedBodyHash` is the latest body snapshot that passed every check required
at its stage. During language editing it is the pre-language snapshot.
`appliedProposals` mirrors the records under `applications/`. `vwa` holds only
values returned by VWA tools, written through `link`.

## 3. Plan, research, and context

`plan.json`: `schemaVersion`, `kind:"plan"`, `runId`, `descriptive`, `thesis`,
`questions`, `sections`. `sections` is nonempty. For write, `questions` equals
the brief question set and every required question appears in a section. For
review, the plan is descriptive and uncovered questions become `coverage`
findings.

A section has `id`, `title`, `questionIds`, `purpose` (`background`,
`definition`, `evidence`, `inference`, `objection`, `recommendation`,
`conclusion`), `claim`, `premises`, `assumptions`, `evidenceRefs`,
`dependsOn`, `readerTakeaway`, and `lengthWeight` (1..100). An entry in
`dependsOn` names an earlier section only. The listed order is the writing
order. Empty `evidenceRefs` never imply support.

`research.json`: `schemaVersion`, `kind:"research"`, `runId`, `questions`
(`[{id,answer,evidenceRefs,gaps}]`), `sources`
(`[{id,path,hash,origin,retrievedAt,limitations}]`), `searches`
(`[{query,scope,outcome,sourceIds}]`). `origin` is `local` or `web`. `outcome`
is `found`, `not-found`, or `error`. Record only searches that happened. Local
source IDs match `src[1-9][0-9]*`.

`context.json`: `schemaVersion`, `kind:"context"`, `runId`, `planHash`,
`sections` (`[{sectionId,actualSummary,establishedClaims,openQuestions}]`).
A summary is a navigation aid, never evidence.

## 4. Review

`schemaVersion`, `kind:"review"`, `id`, `runId`, `stage`
(`structure|language|semantics`), `bodyHash`, `beforeHash`, `planHash`,
`coverage` (`complete|partial`), `coverageRanges`, `crossSectionConsistency`,
`reverseOutline`, `findings`.

| Field | structure | language | semantics |
| --- | --- | --- | --- |
| `beforeHash` | null | null | the pre-language snapshot hash |
| `planHash` | required | required | null for edit |
| `reverseOutline` | one entry per prose block | empty allowed | empty allowed |
| `coverageRanges` | every prose block | every prose block | every edited block and its neighbors |

A finding has `id`, `category`, `severity`, `start`, `end`, `quote`,
`explanation`, `suggestedAction`, `protectedMeaning`, `status`
(`open|rejected`), and `resolution`. `addressed` and `unresolved` are derived
labels; never store them.

## 5. Proposal and check

`proposal.json`: `schemaVersion`, `kind:"proposal"`, `id`, `runId`,
`bodyHash`, `findingIds`, `intent`
(`structure|clarity|concision|style|semantic-repair`), `edits`
(`[{start,end,before,after,reason}]`). Edits are nonoverlapping and match the
base snapshot exactly. An empty `after` deletes. An insertion uses
`start == end` with an empty `before`. Proposals must cite open findings of the
matching stage; only a `semantic-repair` proposal may have an empty
`findingIds` list.

`check.json`: `schemaVersion`, `kind:"check"`, `id`, `runId`, `beforeHash`,
`afterHash`, `mechanicalStatus` (`clean|changed`), `semanticStatus`
(`not-run|no-issue-found|issues-found|incomplete`), `changes`, and
`semanticReviewId`. A change has `type`
(`number|quotation|citation|link|code|term`), `before`, `after`, `disposition`
(`pending|expected|defect`), and `reason`. Name a reason for every non-pending
disposition. To add a semantic result to an existing mechanical check, record a
new check with a new ID and the same hashes.

## 6. Profiles

A profile is a plugin resource, not a run artifact. It has no `kind` field and
is never recorded into a run. Fields: `schemaVersion`, `id`, `description`,
`applicableLanguages`, `rules` (`[{id,instruction,rationale,severity}]`), and
`protectedTerms`. `severity` is `advisory` or `required`.

`compare` loads the profile named by the brief from the installed profiles
directory. It unions the profile terms with the brief terms before it counts
term occurrences. An explicit user rule overrides a profile preference.

## 7. Exit codes

| Exit | Code | Meaning |
| --- | --- | --- |
| 0 | — | success |
| 2 | `INVALID_INPUT`, `PATH_OUTSIDE_WORKSPACE` | bad input, schema, or path |
| 3 | `STALE_BODY`, `STALE_PLAN`, `STALE_BRIEF`, `LOCKED` | stale input or a concurrent writer |
| 4 | `PERMISSION_REQUIRED`, `PREREQUISITE_MISSING`, `REVIEW_INCOMPLETE`, `BUDGET_EXHAUSTED` | an unmet stage or a spent budget |
| 5 | `IO_ERROR` | filesystem failure |
