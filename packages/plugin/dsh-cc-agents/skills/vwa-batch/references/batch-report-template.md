# Batch report template

Write to `docs/vwa-reports/batch-<batchId>.md`. Replace every `<...>`
placeholder. Omit a section only when it is genuinely empty — never because a
value was unknown; unknown renders as `unknown` with the reason.

```markdown
# VWA batch <batchId>

- target: <target from the manifest>
- branch: <branch>
- pages: <total> (<done> done, <deferred-pending>, <skipped>, <failed>)
- started: <timestamp> — finished: <timestamp>

## Pages

| Page | Project | Status | Verdict | Cost (calls / in / out tokens) | Commit | PR |
| --- | --- | --- | --- | --- | --- | --- |
| docs/page-a.md | prj_... | done | eligible | 12 / 34000 / 2100 | <sha> | <url> |
| docs/page-b.md | prj_... | done | deferred-pending | ... | <sha> | <url> |
| docs/page-c.md | prj_... | skipped | skipped | ... | — | — |

Verdict is `eligible`, `deferred-pending`, `not-eligible (stage <name>)`, or
`skipped`.

## Pending human adjudication

Aggregated from every page's deferred disagreements. One entry per finding:

### <projectId> / <artifactId> / <findingId>

- conflicting runs: `<runA>` and `<runB>`
- target / rule: `<targetId>` / `<ruleId>`
- the two verdicts: `<verdictA>` / `<verdictB>`
- suggested command (fill the prevailing run and the reason):

```text
/vwa adjudicate <projectId> <findingId> <accept|reject> <prevailingRunId> <reason>
```

Only the user adjudicates. Reject removes the finding (eligibility may flip to
true); accept keeps its major force (eligibility stays false). After the
adjudication, an as-of re-render of that page's report reflects it.

Write `None.` when no page has a deferred disagreement.

## Skipped pages

| Page | Checkpoint that failed | Attempts | Last error |
| --- | --- | --- | --- |
| docs/page-c.md | reviewCompleted | 2 | `<CODE>` — <one-line summary> |

Write `None.` when nothing was skipped. CI timeouts are not failures; list them
separately when they occurred: `<page>: <n> timeouts`.

## Costs

| Scope | Calls | Input tokens | Output tokens | Cycles |
| --- | --- | --- | --- | --- |
| <projectId> | ... | ... | ... | ... |
| **total** | ... | ... | ... | ... |

Project budget: `<maxCalls / maxInputTokens / maxOutputTokens from the
manifest>` — consumed `<calls / tokens>`. Write `unlimited` when the manifest
set no project budget, and `PROJECT_BUDGET_EXHAUSTED at <page>` when a page
stopped on budget.

## Resume

Write this section only when pages remain and the grant is no longer active:

The grant for this batch has expired. Run this again to continue the remaining
pages (<n> pending): the driver replays the same `initRequestId` per page and
recomputes every checkpoint from disk.

```text
/permissions grant .dsh/vwa/batches/<batchId>/grant-descriptor.json
```

If the brief or branch changed, or the page list must change, start a new batch
instead — the manifest is written once.
```
