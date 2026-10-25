---
name: article-review
description: Review an existing Markdown article's structure, logic, evidence, and prose in Chinese or English, and report findings without changing the body. Use for a structural critique, a logic review, or a review-only request; Chinese triggers include 文章评审、逻辑审查. Use article-writing for a rewrite, and language-editing for copy edits. Do not use for translation or for evidence delivery receipts.
---

# Article review

Review an article and report findings. Change no body bytes.

1. Read `../writing-workflow/SKILL.md` from this skill directory. It defines the
   run directory, the nine script commands, the counters, and the resume rules.
2. Read `../writing-workflow/references/workflow.md`, Section 3, for the
   review-only stage order.
3. Read `../writing-workflow/references/review-rubric.md` before you record a
   review. It fixes the categories, the severity criteria, and the coverage
   rules.
4. Read `../writing-workflow/references/contracts.md` before you write an
   artifact.
5. Read `../writing-workflow/references/vwa-adapter.md` only when the user asks
   for VWA evidence review as well.

Resolve every path from this skill directory, not from a repository root.

## 1. Fix the brief

Resolve question, audience, language, body path, and source scope. The body path
must exist. With no audience, ask; the audience decides what counts as material
ambiguity. With no language, ask.

Apply these defaults and record each adopted default in
`brief.defaultsApplied`:

| Field | Value for this skill |
| --- | --- |
| operation | `review` |
| question | from the user, or derived from the article and recorded in `defaultsApplied` |
| requiredQuestions | from the user, or exactly `[{id:"q1", text: question}]` | 〔src:ws:docs/plans/2026-10-25-writing-harness-plugin.md#L157-L157〕
| allowBodyChanges | false | 〔src:ws:docs/plans/2026-10-25-writing-harness-plugin.md#L159-L159〕
| plan | descriptive only |
| repairRounds | 0 unless the user asks for a repair plan | 〔src:ws:docs/plans/2026-10-25-writing-harness-plugin.md#L140-L140〕
| evidenceMode | `ordinary` unless VWA review is requested explicitly | 〔src:ws:docs/plans/2026-10-25-writing-harness-plugin.md#L135-L135〕

An unanswered required question becomes a `coverage` finding. Never invent
content to fill it. Run `init` with `allowBodyChanges: false` and a fresh UUID v4
`runId`.

## 2. Reconstruct the argument

Build a descriptive plan from the article as written: `descriptive: true`,
thesis, and sections with their claims and dependencies. Mark this plan as
reconstructed in the report. It is a reading of the text, not the author's
approved intention.

Use the plan to test the article against the brief. A required question with no
section is a `coverage` finding. A section whose claim rests on nothing stated is
an `unsupported-inference` or `missing-premise` finding.

## 3. Diagnose in two passes

1. `snapshot` the body. Note the hash; every span and quote must match it.
2. Record a `structure` review. Extract a reverse outline from the body without
   the plan in that prompt, then compare it with the plan and the brief in a
   separate step. Give one outline entry per prose block, ordered coverage ranges
   over every prose block, and `coverage: "complete"` only when the ranges cover
   the body.
3. Record a `language` review over the same body hash. Use the language
   categories: `ambiguity`, `verbosity`, `register`, `terminology`, and the
   preservation categories. Keep one item, one name.
4. For a long article, review in section-sized chunks and aggregate them into one
   review. Include the neighboring summaries and the full plan. Mark coverage
   `partial` if an input is truncated or a dependency does not fit.

Do not apply a proposal. Do not run `compare` while the body stays unchanged.
Write no body bytes, and do not reformat the file.

## 4. Judge severity

A major finding is a reasoning defect, a material ambiguity, a missing required
answer, or changed factual meaning. A stylistic preference alone is minor.
Include minor findings in the report body; they do not change the outcome.

Prefer fewer, better findings over a long list. State the reason for each
finding, and quote the exact text. Do not give a global score, a grade, or a
replacement VWA assessment.

## 5. Finalize

1. `finalize` with the current body hash. If the body changed during the review,
   the script returns `STALE_BODY` (exit 3). Re-snapshot and review the new body
   rather than reusing the old findings.
2. The outcome is `checked-no-major-findings` when no current-open major finding
   exists, and `findings-present` otherwise. Open findings are valid output.
3. Read `editorial-report.md`, then report to the user:
   - the body path and its SHA-256;
   - the outcome label, major findings first, with the exact quotes;
   - the minor findings and the coverage limits;
   - the unresolved items and the recommended next action.

If the user then asks for a repair, that is a new task: `language-editing` for
copy edits, `article-writing` for a structural rewrite. The review findings can
seed the new run.

## 6. Limits

- Findings are model judgments. Mechanical checks prove file identity and
  preservation, not correctness.
- No review detects every instance of Chinese numerals, implicit causality, or
  paraphrased quotation. Say so in the report.
- A VWA request needs the VWA runtime, not another plugin. If VWA is unavailable,
  report that status; do not switch an explicit evidence request to ordinary
  mode.
- The report is local derived data; it is not a tamper-proof receipt.
