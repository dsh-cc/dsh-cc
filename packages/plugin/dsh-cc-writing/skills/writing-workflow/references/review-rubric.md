# Review rubric

Use this rubric when you produce a structure, language, or semantic review. It
defines categories, severity, and the evidence each finding needs. It does not
replace [the artifact contracts](contracts.md) or the script validators.

## 1. Finding categories

| Category | Use it when |
| --- | --- |
| `unsupported-inference` | The text concludes more than the stated evidence supports |
| `missing-premise` | A step needs a stated premise that the text omits |
| `contradiction` | Two passages or two claims disagree |
| `scope` | A claim covers more people, places, times, or cases than the source |
| `coverage` | A required question has no section that answers it |
| `order` | A passage needs material that appears later, or repeats material that came earlier |
| `repetition` | A passage restates an earlier point without advancing the argument |
| `paragraph-purpose` | A paragraph has no clear job in the argument |
| `ambiguity` | A reader can take two readings with different consequences |
| `verbosity` | Words or clauses add no information a reader needs |
| `register` | The tone does not fit the audience the brief names |
| `terminology` | One item carries two names, or two items carry one name |
| `citation-change` | A citation or source marker changed or disappeared |
| `number-change` | A number, unit, or date changed |
| `quote-change` | A quotation changed |
| `meaning-change` | Reportable meaning changed without a stated reason |

Structural categories: `unsupported-inference`, `missing-premise`,
`contradiction`, `scope`, `coverage`, `order`, `repetition`,
`paragraph-purpose`. Language categories: `ambiguity`, `verbosity`, `register`,
`terminology`. Preservation categories: `citation-change`, `number-change`,
`quote-change`, `meaning-change`.

A structure review judges the argument, not the wording. A language review
judges clarity inside the same claims. A semantic review compares the before and
after text for changed meaning. Do not silently downgrade a structure defect
into a style note.

Hedges are protected meaning. Under the `academic` profile, hedges such as
"may", "suggest", and "consistent with" must not be weakened or removed during
copy editing; a claim that drops its hedge, or promotes it to "is" or "shows",
is a `meaning-change` finding even when every number, quotation, and term
survives. `protectedTerms` does not cover this: judge the hedge's effect on the
claim and quote the changed span.

Under the `engineering-strategy` profile, judge the skeleton as well as the
prose. The opening should read as SCQA: a situation, a complication that creates
the tension, the question it forces, and the answer the document adopts. An
opening that only announces the topic is a structural finding, not a style note.
A guiding policy names one approach and states what it gives up; a policy with
no tradeoff rests on an unstated premise, which is a `missing-premise` finding.
Lint the four Rumelt anti-patterns item by item: fluff (empty high-level
verbiage), failure to face the challenge (no defined challenge, so the strategy
cannot be evaluated or improved), goals mistaken for strategy (a wish list
rather than a plan for overcoming obstacles), and bad objectives (goals that
address no critical issue or cannot be executed). A document over its 1-2 page
vision budget, or a diagnosis with no retained data and reasoning, is a
structural finding too. These are model judgments; the outline check confirms
only that the required headings exist in the declared order.

## 2. Severity

`major` covers:

- a reasoning defect: an unsupported inference, a missing premise, a
  contradiction, or a lost qualification;
- material ambiguity: two readings with different consequences;
- a missing required answer: a required question with no section;
- changed factual meaning: a number, quotation, citation, scope, or strength
  that moved without permission.

`minor` covers a stylistic preference and a local clarity or concision
improvement that leaves the claims intact.

Judge by effect on the argument, not by sentence length. Do not flag passive
voice or a long sentence as an error without context. A profile can offer these
as prompts, never as gates.

A reviewer must state reasons. Do not produce a global quality score, a grade
for the article, or a replacement VWA assessment.

## 3. What a finding must carry

1. An exact span and a quote from the reviewed snapshot. Both must match that
   snapshot byte for byte.
2. The category and the severity, with a sentence of reasoning.
3. The protected meaning: the numbers, conditions, terms, and scope that an
   edit must keep.
4. A suggested action in words: cut, move, split, state the premise, soften the
   causal verb, and so on. A review-only task does not apply it.

`status` is `open`, or `rejected` when the reviewer withdraws its own finding
and writes the reason in `resolution`. `addressed` and `unresolved` are derived:
a finding is addressed when a later current review does not repeat it as open.
Never write a derived label into a recorded finding.

## 4. Coverage

`coverage` is `complete` or `partial`. A partial review cannot satisfy
completion.

- A structure or language review covers every prose block.
- A semantic review covers every edited prose block and its adjacent blocks.
- Ranges are ordered, nonoverlapping, and inside the snapshot.
- `reverseOutline` has one entry per prose block for a structure review.
- Aggregate chunk results into one review and keep the chunk findings; set
  `crossSectionConsistency` to true only when you actually checked it.
- Mark `partial` when an input is truncated or a dependency does not fit.
- A zero-edit semantic review uses an empty range list with coverage complete,
  and the mechanical status is then clean.

## 5. What a review cannot claim

- Mechanical equality does not establish semantic equality.
- No review detects every instance of Chinese numerals, implicit causality, or
  paraphrased quotation. State these limits in the report.
- `no-issue-found` is a model result, not a proof of equivalence.
- Coverage declarations are checked against block offsets by the script. An
  honest review is not verifiable by a script; say so in the report.
- A model judgment cannot set a VWA grade, and an editorial pass cannot replace
  a VWA review.
