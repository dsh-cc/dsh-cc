# VWA adapter

This reference covers evidence mode. Ordinary mode does not need VWA and does
not need the `dsh-cc-agents` plugin. Evidence mode also does not need that
plugin: this adapter carries its own current tool workflow. Evidence mode needs
the VWA runtime.

The baseline implementation stays in `dsh-cc-agents`: see the
[vwa-writing skill](https://github.com/dsh-cc/dsh-cc/blob/main/packages/plugin/dsh-cc-agents/skills/vwa-writing/SKILL.md)
and its
[tool contract](https://github.com/dsh-cc/dsh-cc/blob/main/packages/plugin/dsh-cc-agents/skills/vwa-writing/references/tool-contract.md).
Do not import source files from that plugin, and do not copy its internal state.
VWA remains the only owner of evidence grades, argument assessments, bindings,
and delivery receipts.

## 1. Tool discovery

Before the first evidence-dependent step, discover these tools in the live
catalog:

- `evidence.register`
- `evidence.search_log`
- `argument.update`
- `argument.review`
- `argument.report`

Use the search tool first if the host hides tools until discovery. Do not infer
tool access from settings. Do not infer it from an earlier session. Use the
live schemas as the authority for every field; the shapes below describe the
workflow only.

If a tool is missing, report the blocker and stop the evidence step. Do not
fall back to ordinary mode without a user decision.

## 2. Standalone prerequisites

Check these conditions without changing any setting:

1. The host build has the VWA delivery tools. A plugin installation does not
   add them.
2. `$DSH_HOME/settings.json` has `vwa-argument.semantic-enabled` set to `true`.
   The default directory is `~/.dsh`.
3. `vwa-evidence.enabled` is `true` when automatic delivery checks are wanted.
4. The session uses the VWA preset.
5. The workspace has an initialized VWA project with a current `projectId` and
   author revision.

The user changes settings, switches the preset, and initializes the project.
Give every missing step in one message. Do not run user-only preset or VWA
commands through a shell tool, and do not write project pointers, snapshots, or
receipts by hand. Never disable a runtime check to make setup pass.

Project review limits are frozen at initialization. An editorial budget never
replaces them, and editorial `repairRounds` grants no VWA budget.

## 3. Registers, searches, and the argument graph

1. Read the actual source. Register metadata and exact excerpts with
   `evidence.register`. Keep editions, locations, original wording, and
   context. Never label a copied model answer as an external source.
2. Record the searches that happened with `evidence.search_log`. A missing
   search is not a completed search.
3. Set the research contract, claims, evidence groups, and arguments through
   `argument.update`. Separate facts, source reports, interpretations, causes,
   intentions, and evaluations. Record scope, premises, warrants, assumptions,
   counterevidence, and limits.
4. Use only identifiers and revisions that a tool returned.
5. Write your own `research.json` as an index of the same work. It is never a
   replacement evidence ledger.
6. Copy an external local source into an approved workspace path before you
   register it.

## 4. Calls, revisions, and replays

Every call carries `projectId`, `expectedRevision`, a fresh UUID v4
`requestId`, and `input`. Reuse the revision from the latest successful author
mutation. Scheduling a review does not change the author revision.

```json
{
  "projectId": "<current projectId>",
  "expectedRevision": 7,
  "requestId": "<new UUID v4>",
  "input": { "stage": "all", "artifactId": "<bound artifactId>" }
}
```

Replay rules:

- Replay a request only with its original `requestId` and the exact same
  payload. That returns the recorded result without a second effect.
- A changed request needs a new UUID v4. Never reuse an old ID for different
  content.
- On `REVISION_CONFLICT`, read the current project metadata, reconcile, and
  then send a new request with a new `requestId`. Do not repeat a stale
  mutation.

## 5. Editorial order in evidence mode

Run the editorial workflow before the final VWA binding. If an earlier VWA
review informs structural repair, record its result as a planning input. That
input is not an editorial repair cycle, and it does not consume the final
review.

The workflow allows one `argument.review` of the final body, plus that cycle's
existing continue semantics. If the VWA repair cycle was spent before the final
body existed, editorial `finalize` may still complete. The report's VWA line
then says that no VWA review covers the final body. The run never switches to
ordinary mode.

1. Bind the exact final body with `argument.update`, op `bind-artifact`. Preserve
   exact occurrence text and valid spans.
2. Call `argument.review` with `input.stage: "all"` and the returned
   `artifactId`. Wait for the host job to settle.
3. A started, pending, failed, or incomplete job is not a passed review.
   Continuations follow the existing continue semantics and share that cycle's
   frozen budget.
4. After the job settles, generate the report:

   ```json
   {
     "projectId": "<current projectId>",
     "artifactId": "<bound artifactId>",
     "format": "markdown",
     "write": true
   }
   ```

5. Copy the returned identifiers into `run.json` with the `link` command:
   `projectId`, `authorRevision`, `artifactId`, `runId`, `taskId`, and
   `reportPath`. Only returned values are valid here.

## 6. Cycle policy

| Situation | Action |
| --- | --- |
| Body changed after a review | Bind again and review again before any final claim |
| First review informs a structural repair | Treat it as planning input; it is not a repair cycle |
| One repair and one re-review | Allowed, inside the frozen budget |
| Budget exhausted | Report the spent budget and the unresolved findings |
| Review still running | Wait. Do not claim a reviewed delivery |
| VWA unavailable | Block the evidence step. Do not switch modes. |

Never raise a frozen limit, erase a finding, or start extra cycles to obtain a
pass. Stop on `BUDGET_EXHAUSTED`. `NOTHING_TO_CONTINUE` means every task has a
record; read the current results.

## 7. Report and delivery

Present the exact body path and the returned VWA report path through the host
presentation mechanism. Present `editorial-report.md` as an additional file.

Only a host-confirmed result may be called delivered-reviewed. A report, a
candidate status, or a passed model call alone is not a delivery. If
presentation is unavailable, give the paths and say that delivery is not
confirmed.

Keep the two statuses separate:

- Editorial outcome: `checked-no-major-findings`, `findings-present`,
  `incomplete`, or `blocked`.
- VWA status: pending, incomplete, exhausted, unavailable, or the runtime's
  current label.

An ordinary-mode report always says `VWA evidence review: not performed`. An
editorial pass never sets a VWA grade. Only the user signs a receipt or
adjudicates a finding.
