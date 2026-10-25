---
name: language-editing
description: Improve the clarity, concision, and style of an existing Markdown article in Chinese or English with local edits that keep numbers, quotations, terms, conditions, and claim strength. Use for copy editing or a polish pass; Chinese triggers include 润色、语言修改. Use article-writing for a substantial rewrite, and article-review for a critique with no edits. Do not use for translation or new research.
---

# Language editing

Edit the language and keep the meaning. Work through local proposals only.

1. Read `../writing-workflow/SKILL.md` from this skill directory. It defines the
   run directory, the nine script commands, the counters, and the resume rules.
2. Read `../writing-workflow/references/workflow.md`, Section 4, for the edit
   stage order.
3. Read `../writing-workflow/references/review-rubric.md` before you record a
   review, and `../writing-workflow/references/contracts.md` before you write an
   artifact.
4. Read `../writing-workflow/examples/zh.md` or `en.md` for the intended edit
   style, and `../writing-workflow/profiles/<id>.json` for the profile rules.
5. Read `../writing-workflow/references/vwa-adapter.md` only for evidence mode.

Resolve every path from this skill directory, not from a repository root.

## 1. Fix the brief

The supplied article defines the question and the source scope: record both in
`defaultsApplied`. Resolve audience and language. With no audience, ask; the
audience decides the register. With no language, ask.

Apply these defaults:

| Field | Value for this skill |
| --- | --- |
| operation | `edit` |
| requiredQuestions | exactly `[{id:"q1", text: question}]` |
| plan | none; `record` rejects plan and research artifacts |
| allowBodyChanges | true, but only through applied proposals |
| repairRounds | 0 |
| profile | the closest profile, or ask; use `styleOverrides` for explicit user rules |

Run `init` with a fresh UUID v4 `runId`, the existing body path, and the default
companion directory.

## 2. Diagnose the language

1. `snapshot` the body. Every span and quote must match that hash.
2. Record a `language` review with `planHash: null`, complete coverage ranges over
   every prose block, and real spans.
3. Use the language categories: `ambiguity`, `verbosity`, `register`,
   `terminology`, plus `repetition` and `paragraph-purpose` where the paragraph,
   not the argument, is the problem.
4. Leave a passage unchanged when a logical problem blocks a safe edit. Record
   the finding and say why the text stays as it is.

Do not reorganize sections, introduce new factual assertions, fetch new
evidence, or strengthen the thesis. A request for that belongs to
`article-writing`.

## 3. Propose and apply

1. Write one `clarity` proposal, then one `concision`-or-`style` proposal. The
   two share a single language slot. Merge all edits of one intent into one
   proposal.
2. Reference only open findings from the language review. Every edit gives a
   reason and states the protected meaning.
3. Keep the base snapshot exact. Never overlap edits, never repeat an insertion
   at one offset, and never touch a protected region: frontmatter, inline code,
   fenced code, and link destinations.
4. Apply with `expectedBodyHash`. A mismatch returns `STALE_BODY` (exit 3);
   re-snapshot and re-propose. Do not force the old candidate over the new text.

Apply the smallest useful change. Do not rewrite a paragraph to fix one clause,
and do not impose a literary voice. A profile rule is advisory unless it is
marked otherwise, and an explicit user rule wins.

## 4. Check the meaning

1. `compare` the pre-language snapshot with the candidate. Read every
   mechanical change: numbers, quotations, citations, links, code, and terms.
2. State `expected` or `defect` with a reason for each change. In language-only
   mode, a corrected number or quotation needs explicit user permission; an
   unexplained change is a defect, not an improvement.
3. Record the `semantics` review over every changed prose block and its
   adjacent blocks. Check negation, modality, causal strength, quantifier, time
   range, population, attribution, and recommendation strength.
4. If drift remains, make one `semantic-repair` proposal, apply it, compare
   again, and re-review the affected meaning.
5. On semantic failure, `restore` to the pre-language snapshot. The passes stay
   consumed. Keep the rejected proposals as unresolved and report them.

A clean compare does not establish that the meaning survived. It shows only that
the protected tokens and code bytes match.

## 5. Finalize

1. `finalize` with the current body hash.
2. Read `editorial-report.md`: the language changes grouped by intent, the
   protected-item changes, the semantic outcome, and the unresolved findings.
3. Report the body path, the report path, the changes in one short list, and
   anything left unchanged with the reason.

A body with no change still gets a semantic check with equal hashes. Say that no
edit was necessary instead of inventing a small one.

## 6. Limits

- Mechanical checks prove file identity and preservation only. The semantic
  result is a model judgment, not a proof.
- Some changes are invisible to the scanner: Chinese numerals, implicit
  causality, and paraphrased quotation. Say so when they apply.
- Version 1 supports one cooperative writer per body. Use the default companion
  directory.
- The report is local derived data; it is not a tamper-proof receipt.
- Evidence mode needs the VWA runtime. An explicit VWA request must not be
  downgraded to ordinary mode.
