---
name: writing-workflow
description: Shared run protocol for the public writing skills in this plugin (article-writing, article-review, language-editing). The public writing skills read this skill and its references; it is not a separate user task.
user-invocable: false
disable-model-invocation: true
---

# Writing workflow

This skill is the shared protocol for `article-writing`, `article-review`, and
`language-editing`. Each public skill reads this file and the references it
needs from its own installed directory. Use these paths:

| Resource | Path from the public skill directory |
| --- | --- |
| Stage workflow | `../writing-workflow/references/workflow.md` |
| Artifact schemas | `../writing-workflow/references/contracts.md` |
| Review rubric | `../writing-workflow/references/review-rubric.md` |
| VWA adapter | `../writing-workflow/references/vwa-adapter.md` |
| Profiles | `../writing-workflow/profiles/<id>.json` |
| Examples | `../writing-workflow/examples/zh.md` and `en.md` |
| Script | `../writing-workflow/scripts/writing.mjs` |

Resolve these paths from the installed skill directory. Do not use a
repository-relative path. Do not require a checkout.

The scripts validate structure, identity, and preservation. They do not prove
that a judgment is correct. Structural and semantic findings stay model
judgments. State that limit in the editorial report.

## 1. Run directory

For a body at `docs/articles/cxl.md`, the default companion directory is
`docs/articles/cxl.writing/`. Remove only the last extension of the body name
and append `.writing`. An explicit companion path overrides the default. Use
the default for any body with more than one run: the concurrent-run check
cannot see runs under different companion directories.

Each invocation creates `runs/<runId>/` under the companion directory:

```text
brief.json
run.json
plan.json
research.json
context.json
versions/<sha256>.json
snapshots/<sha256>.md
reviews/<uuid>.json
proposals/<uuid>.json
checks/<uuid>.json
applications/<uuid>.json
lock
editorial-report.md
```

Every path in `run.json` is a workspace-relative POSIX path. A missing stage
has no placeholder file. Keep the body at the requested body path; do not
create a second authoritative body. Never put editorial state in `.dsh/vwa` or
the VWA receipt directory.

## 2. Commands

One entry point serves all commands:

```sh
node <installed-skill>/scripts/writing.mjs <command> --workspace <root> --input <json-file>
```

`<root>` is the workspace realpath. `<json-file>` is a caller-supplied file in
that workspace with one strict JSON object. The script prints one JSON object
on stdout: `{"ok":true,"result":...}` or
`{"ok":false,"code","message","details"}`. Read `code`, not only the exit
status.

| Command | Input object keys | Effect |
| --- | --- | --- |
| `init` | `brief`, `replaceExisting` | Validate the brief, create the run, snapshot an existing body |
| `snapshot` | `runPath` | Store a content-addressed snapshot; return its hash and prose-block offsets |
| `record` | `runPath`, `artifact`, `expectedBodyHash`, `expectedPlanHash` | Validate and persist one model-produced artifact |
| `apply` | `runPath`, `proposalId`, `expectedBodyHash` | Replace the body with the proposal candidate |
| `compare` | `runPath`, `beforeHash`, `afterHash` | Write the mechanical check and return its ID |
| `restore` | `runPath`, `snapshotHash`, `expectedBodyHash` | Return the body to the accepted baseline |
| `status` | `runPath` | Recompute hashes and report the next required stage; no writes |
| `link` | `runPath`, `model`, `usage`, `vwa` | Persist host metadata into `run.json`; no network |
| `finalize` | `runPath`, `expectedBodyHash`, `cancelled` | Check completion and render `editorial-report.md` |

Example `init` input file:

```json
{
  "replaceExisting": false,
  "brief": {
    "schemaVersion": 1,
    "kind": "brief",
    "runId": "0b2f07c8-8d64-4a51-9f5f-4a0f6e0f1c2d",
    "operation": "write",
    "question": "Why did the port close?",
    "audience": "Regional logistics managers",
    "language": "en",
    "bodyPath": "docs/articles/port.md",
    "companionPath": "docs/articles/port.writing",
    "profile": "technical",
    "targetLength": null,
    "requiredQuestions": [{ "id": "q1", "text": "Why did the port close?" }],
    "sourceScope": { "localPaths": ["docs/sources"], "webAllowed": false, "description": "Provided reports" },
    "evidenceMode": "ordinary",
    "allowBodyChanges": true,
    "repairRounds": 1,
    "protectedTerms": [],
    "styleOverrides": [],
    "defaultsApplied": ["profile: technical (technical explanation)"]
  }
}
```

Then: `node <skill>/scripts/writing.mjs init --workspace "$PWD" --input .writing-init.json`.

Artifacts go in through `record`. Omit `bodyHash`, `planHash`, `beforeHash`,
and `afterHash`; the script injects them after it validates the expected
hashes. Submit a full `Brief` only through `init`. Never write `run.json`,
hashes, or report files by hand.

`expectedBodyHash` and `expectedPlanHash` are `string|null`. Null means "no
body or plan is expected here". Null is not a wildcard.

## 3. Stage order

The contract in [the stage workflow](references/workflow.md) fixes the order:
brief, research, plan, draft, snapshot, structure diagnosis, structural
repair, language passes, compare, semantic review, finalize. Read it before the
first `record`. Read [the artifact contracts](references/contracts.md) before
you write an artifact. Read [the review rubric](references/review-rubric.md)
before you record a review.

## 4. Counters and budgets

| Limit | Rule |
| --- | --- |
| Structural rounds | `repairRounds`, default 1, range 0..3. One applied structure proposal plus one complete structure re-review is one round. |
| Language passes | At most one clarity pass and one concision/style pass. Concision and style share a single slot. |
| Semantic repair | One repair and recheck after the language passes. |
| Apply | `apply` reserves its counter before it replaces the body. An interrupted re-review does not refund it. |
| Restore | `restore` never decrements any counter. |
| Unapplied proposal | Consumes nothing. |
| VWA budget | Existing project limits. Editorial limits add no VWA budget. |

A limit needs a new user instruction to increase. Never loop "until it is
good". When a limit is reached, keep the unresolved findings, stop, and report
them.

## 5. Failure, cancellation, and resume

- On interruption, keep snapshots, reviews, and proposals. Resume with
  `status`, compare the current hashes, and restart at the earliest invalidated
  stage. Do not regenerate an accepted stage only because a new session
  started.
- A changed question, audience, language, evidence mode, or edit permission
  needs a new run. A changed length or style rule also needs a new run. The new
  run may read the old snapshots as inputs.
- A stale body or plan returns `STALE_BODY` or `STALE_PLAN` (exit 3). Preserve
  the external change. Do not overwrite it with an old candidate.
- A held lock returns `LOCKED` (exit 3) with the lock path. The scripts never
  delete a lock from a dead process. Check that no writer remains, then remove
  it.
- When blocked or cancelled, report the body path, the completed checks, the
  unresolved issues, and the next action. `finalize` with `cancelled: true`
  records a cancelled, incomplete report and exits 0.
- Never invent a completed stage, a hash, or a pass label to finish a task.

## 6. Honest limits

- Mechanical equality does not establish semantic equality. A clean compare is
  a file-identity result only.
- The semantic reviewer is a model. Its verdict is a judgment, not a proof.
- Version 1 supports one cooperative writer. A concurrent check reduces races.
  It cannot prevent an external writer from changing the file between the final
  check and the rename.
- The editorial report is local derived data. An agent can edit these files.
  They are not tamper-proof receipts.
