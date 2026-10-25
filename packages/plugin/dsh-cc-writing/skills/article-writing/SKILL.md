---
name: article-writing
description: Write or substantially revise a Markdown article in Chinese or English with an explicit argument plan, structural diagnosis, and meaning-preserving revision. Use for a new article, a structural rewrite, or an argument outline; Chinese triggers include 写文章、文章结构、论证提纲. Use article-review to inspect an article without changes, and language-editing for copy editing. Do not use for translation or DOCX/PDF work.
---

# Article writing

Write or restructure an article through an inspectable run.

1. Read `../writing-workflow/SKILL.md` from this skill directory. It defines the
   run directory, the nine script commands, the counters, and the resume rules.
2. Read `../writing-workflow/references/workflow.md` before the first stage.
3. Read `../writing-workflow/references/contracts.md` before you write an
   artifact, and `../writing-workflow/references/review-rubric.md` before you
   record a review.
4. Use `../writing-workflow/profiles/<id>.json` and
   `../writing-workflow/examples/` for the profile rules and the edit style.
5. Read `../writing-workflow/references/vwa-adapter.md` only for evidence mode.

Resolve every path from this skill directory, not from a repository root.

## 1. Fix the brief

Ask only for information that changes the output or the permission boundary.
Resolve these five decisions before drafting: question, audience, language,
output path, and source scope.

- With no audience, ask.
- With no output path, propose `docs/articles/<slug>.md` in the same
  clarification. Never invent a filename silently.
- With no language, ask. Do not guess from the request language.

Then apply these defaults and record each adopted default in
`brief.defaultsApplied`:

| Field | Value for this skill |
| --- | --- |
| operation | `write` |
| evidenceMode | `ordinary`; never downgrade an explicit VWA request | 〔src:ws:docs/plans/2026-10-25-writing-harness-plugin.md#L135-L135〕
| profile | `technical` for a technical explanation, `research` for a literature review, `opinion` for an argumentative essay; ask if ambiguous |
| targetLength | null | 〔src:ws:docs/plans/2026-10-25-writing-harness-plugin.md#L138-L138〕
| allowBodyChanges | true; a new output for a new body, gated by `replaceExisting` for an existing file | 〔src:ws:docs/plans/2026-10-25-writing-harness-plugin.md#L139-L139〕
| repairRounds | 1; the range is 0 to 3 | 〔src:ws:docs/plans/2026-10-25-writing-harness-plugin.md#L140-L140〕
| sourceScope | the explicit paths, named sources, and permitted web research; never widen it silently | 〔src:ws:docs/plans/2026-10-25-writing-harness-plugin.md#L141-L141〕
| styleOverrides | empty; an explicit user rule wins | 〔src:ws:docs/plans/2026-10-25-writing-harness-plugin.md#L142-L142〕
| protectedTerms | empty; user terms add to the profile terms | 〔src:ws:docs/plans/2026-10-25-writing-harness-plugin.md#L143-L143〕

Do not infer a required conclusion. A supplied conclusion is a constraint on the
deliverable, not evidence for it.

`replaceExisting` is false unless the user asked to replace that body. Give the
full brief to `init` with a fresh UUID v4 `runId`.

## 2. Plan the argument

1. Research the required questions inside the source scope, then record
   `research`. In evidence mode, finish the adapter preflight first.
2. Write a prescriptive plan: thesis, question IDs, and sections in writing
   order. Every required question must appear in at least one section. Each
   section states a claim, its premises, its assumptions, its evidence
   references, its dependencies, the reader takeaway, and a `lengthWeight`.
3. Check the plan before you record it: question coverage, dependency order,
   evidence references, and purpose variety. A plan that answers its own
   question in the background section is an `order` defect.
4. Record `plan` with `expectedBodyHash: null` and `expectedPlanHash: null`.

Use the profiles as prompts, not gates. The `technical` profile answers the
question early, defines terms, separates observation from inference and
recommendation, and keeps conditions. The `research` profile separates source
reports from synthesis, compares methods and evidence, and explains disagreement
and gaps. The `opinion` profile states the thesis and criteria, addresses a
material objection, and separates preference from fact. `technical-ste` applies
to English only, on request, and is not ASD-STE100 certification.

## 3. Draft

Draft in section order with the normal write tool. Give each section the brief,
the whole plan, the actual summaries of earlier sections, its evidence, and the
relevant objections. Do not paste the plan or the section scaffolding into the
body. Keep the reader in one line of reasoning from the title to the end.

After each section, record `context` with what the section actually says: its
summary, the claims it establishes, and its open questions. If the evidence
changes the thesis, revise the plan and record it again. The previous version
stays in the run history.

Then run `snapshot` on the complete draft.

## 4. Diagnose the structure

1. Extract a reverse outline from the body. Do not pass the plan into that
   extraction prompt; prompt separation is the control here, not isolation.
2. In a separate step, compare the reverse outline with the plan and the brief.
   Record a `structure` review with one outline entry per prose block, complete
   coverage ranges, and real spans.
3. Address major findings first. A blocked evidence issue can send you back to
   research inside the same source scope.
4. Apply at most `repairRounds` structural cycles from this skill's defaults. One
   cycle is one applied `structure` proposal plus one complete `structure`
   re-review over the changed body, including adjacent sections and
   dependencies. A changed plan needs a fresh structure review.

Do not restructure a diagnostic finding away. If you reject your own finding,
record `status: "rejected"` with a resolution.

## 5. Revise the language

Run one clarity pass and one concision/style pass. Concision and style share a
single slot. Merge all edits of one intent into one proposal, and state the
intent and the protected meaning in each proposal.

Then:

1. `compare` the pre-language snapshot with the final candidate.
2. Record the `semantics` review over every changed prose block and its
   neighbors.
3. If drift remains, make one `semantic-repair` proposal, apply it, compare
   again, and re-review the affected meaning.
4. On semantic failure, `restore` to the pre-language snapshot. The passes stay
   consumed. Keep the rejected proposals as unresolved, and never deliver the
   failed candidate as an accepted edit.

## 6. Finalize

1. `status` to confirm the next required stage; then `finalize` with the current
   body hash.
2. Read `editorial-report.md` and check the outcome label, the coverage limits,
   and the unresolved findings.
3. In evidence mode, bind and review the exact final body through the adapter. In
   ordinary mode, say `VWA evidence review: not performed`.
4. Report the body path, the report path, the outcome, and the open items.

## 7. Limits

- Mechanical checks establish file identity and preservation only. Structural and
  semantic findings are model judgments, not proofs.
- The report is local derived data. An agent can edit it; it is not a
  tamper-proof receipt.
- Version 1 supports one cooperative writer per body. Use the default companion
  directory so the concurrent-run check can see sibling runs.
- A review request with no edit permission belongs to `article-review`. Copy
  editing with no structural change belongs to `language-editing`.
- If the user also asks for VWA evidence review, this skill owns the
  orchestration and uses the adapter. Do not start a second editorial loop in
  `vwa-writing`.
