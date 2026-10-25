# Stage workflow

This reference expands plan §7. Read it after
[the workflow skill](../SKILL.md). Read
[the artifact contracts](contracts.md) before you write an artifact, and
[the review rubric](review-rubric.md) before you record a review.

Each stage ends with `record` or `apply`. Ask `status` when you are unsure what
comes next; it reports the earliest invalidated prerequisite, not only the last
milestone.

## 1. Entry and brief

1. Resolve the task from the request and the workspace files. Ask only for
   missing information that changes the output or the permission boundary.
2. Fix question, audience, language, output path, and source scope. For
   language editing, the supplied article can define the question and the
   source scope. If there is no audience, ask.
3. For a new article with no output path, propose `docs/articles/<slug>.md` in
   the same clarification. Do not invent a filename silently.
4. Apply the defaults for the operation. Record every adopted default in
   `brief.defaultsApplied`. Do not infer a required conclusion.
5. Build the brief and run `init`.

Per operation:

| Decision | write | review | edit |
| --- | --- | --- | --- |
| question | from the user | from the user; an unanswered required question becomes a finding, never invented content | derived from the article, recorded in `defaultsApplied` |
| audience | ask if absent | ask if absent | ask if absent |
| requiredQuestions | from the user | from the user | exactly `[{id:"q1", text: question}]` |
| body | created at `bodyPath`; an existing file is replaced only when `replaceExisting` is true | must exist; never replaced | must exist; changed only through applied proposals |
| plan | prescriptive | descriptive | absent; `record` rejects plan and research |
| research | inside the source scope | not required | absent |
| allowBodyChanges | true, gated by `replaceExisting` | false | true, but only through proposals |

Record the effective model identifier through `link` when the host exposes it.
Otherwise record null. Do not infer a provider from an alias. The plugin adds
no model routing.

## 2. Write or substantial revision

1. Run `init`.
2. Research the required questions inside the source scope. In VWA mode, finish
   [the VWA adapter](vwa-adapter.md) preflight first.
3. Write the plan: thesis, questions, sections in writing order. Check question
   coverage, dependency order, and evidence references. Record it.
4. Draft in section order with the normal write tool. Each section gets the
   brief, the whole plan, the actual summaries of earlier sections, its
   evidence, and the relevant objections. Do not paste the plan into the body.
5. After each section, record `context` with an actual summary. If evidence
   changes the thesis, revise the plan and record it again; the old version
   stays in `versions/`.
6. Run `snapshot` on the complete draft.
7. Extract a reverse outline from the body. Do not show the plan in the outline
   extraction prompt. This is prompt separation, not process isolation.
8. In a separate step, compare the reverse outline with the plan and the brief.
   Record structural findings. Every required question with no section is a
   `coverage` finding.
9. Repair major findings before cosmetic editing. A blocked evidence issue can
   send you back to research inside the same source scope.
10. Run at most `repairRounds` structural cycles. One cycle is one applied
    structure proposal plus one complete structure re-review over the changed
    body, with adjacent sections and dependencies included.
11. Run one clarity pass and one concision/style pass. Merge all edits of one
    intent into one proposal. Each proposal states its intent and the protected
    meaning.
12. Run `compare` from the pre-language snapshot to the final candidate, then a
    semantic review. Review every changed prose block and its surrounding
    paragraph. State each mechanical difference as `expected` or `defect` with
    a reason.
13. If drift remains, make one semantic repair, apply it, compare again, and
    re-review the affected meaning.
14. A semantic failure is the single semantic re-review returning
    `issues-found` or `incomplete`. An apply or IO error is not a semantic
    failure. On semantic failure, `restore` to the pre-language snapshot. The
    language passes stay consumed. Keep the rejected proposals as unresolved,
    and never deliver the failed candidate as an accepted edit.
15. `finalize`. In VWA mode, bind and review the exact final body before the
    VWA report and delivery.

A changed plan invalidates structure findings that used the old plan. A changed
body invalidates every body-bound review for completion. Keep the old results
as history; do not reuse them because the edits look small.

For a long article, review in section-sized inputs. Each input carries the
neighboring section summaries, the full plan, and every dependency needed to
judge its claims. Assemble disjoint span coverage for the whole body and add an
explicit cross-section consistency check. Mark coverage `partial` if an input
is truncated or a dependency does not fit. Never claim complete coverage from
summaries alone. If the host gives no context-size estimate, reduce the chunk
or report the limit.

## 3. Review only

1. `init` with `operation: "review"` and `allowBodyChanges: false`.
2. Build a descriptive plan from the current content. Mark it reconstructed in
   the report. It is not the author's approved intention.
3. Run the structure diagnosis and the language diagnosis. Record both.
4. Do not apply proposals. No compare is required while the body bytes stay
   unchanged.
5. Evaluate the article against the brief. Unanswered required questions become
   findings.
6. `finalize` with complete diagnostics and a matching body hash. Open findings
   are valid output. The outcome is `checked-no-major-findings` when no
   current-open major finding exists, and `findings-present` otherwise.
7. A VWA review, if requested, also preserves the body.

## 4. Language editing

1. `init` with `operation: "edit"`. Skip research and prescriptive planning; the
   plan is absent and `planHash` stays null.
2. `snapshot`, then diagnose language. Record the language review.
3. Propose local edits only. Do not reorganize sections, add factual
   assertions, fetch evidence, or strengthen the thesis.
4. If a logical problem blocks a safe edit, record a finding and leave that
   passage unchanged.
5. Follow the same language budget, compare, and semantic checks as Section 2.
   An explicit substantial rewrite request belongs to `article-writing`.

## 5. Stage and counter rules

Completion requires these items:

| Operation | Required for `finalize` |
| --- | --- |
| write | current plan, complete context, complete structure review, complete final semantic review |
| edit | complete language review, compare, complete final semantic review |
| review | complete current structure review and complete current language review; no semantic compare |

A write or edit with no language change still runs a semantic check with equal
before and after hashes. The compare yields no changes, the semantic review
uses an empty range list with coverage complete, and `semanticStatus` is
`no-issue-found` trivially.

After language editing, a write needs a fresh structure review. Earlier
language diagnostics stay historical. The final semantic review must state
whether each edited finding was addressed. A changed plan always needs a fresh
structure review.

A structural cycle consists of one structure proposal and one complete
structure re-review. `apply` reserves the counter before it replaces the body.
An interrupted re-review does not refund it. `restore` never decrements a
counter. Put multiple edits in one proposal. A clarity or concision/style
proposal that is applied consumes one language pass and marks its slot in
`languageIntentsUsed`. A semantic-repair proposal consumes the single semantic
repair allowance. Zero-edit diagnosis consumes nothing.

`run.phase` is the latest completed milestone, not the whole state. Only
`finalize` sets `outcome: completed`. A blocked operation sets
`outcome: blocked` with a stable error code. Successful recovery returns it to
`active`. A cancellation appears as an incomplete report.

## 6. Finalization failures

`finalize` renders an incomplete or blocked report even when its predicates
fail, then returns exit 4 with the report path. Invalid schema, an unsafe path,
a stale input, or an IO failure aborts without replacing an existing report.

Only the scripts update run metadata and the editorial report. A model supplies
artifact objects, not hashes or success labels.
