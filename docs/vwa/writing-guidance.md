# VWA writing guidance (lane 1: technical documentation)

An AGENTS-mountable fragment for the verifiable workspace agent, lane 1.
Design basis: `docs/plans/2026-10-12-verifiable-workspace-agent.md` (§5 for
the pipeline and language note, §4 for the receipt contract). This fragment
is behavioral guidance, not a re-spec; where the two disagree, the design
doc wins.

## Marker discipline

Every verifiable claim in a deliverable carries an evidence marker. Mark a
sentence when it asserts something checkable — don't mark opinions,
transitions, or questions.

Four claim families get marked (the same families the mechanical detector
recognizes):

1. **Numbers with units or percentages** — "uses 40% less memory", "up to
   3× faster", "timeout of 30s".
2. **Dates** — calendar dates, deadlines, release dates.
3. **Versions** — "requires v0.2.0-rc.2", "since v1.4".
4. **API and identifier shapes** — function names with parentheses,
   CamelCase types, CONST_CASE constants, quoted config keys.

Entity names alone are not claims — don't mark a mention; mark the sentence
that asserts something about one.

Syntax: `〔src:ws:<path>#L<a>-L<b>〕` immediately after the claim it
supports. The path is POSIX, relative to the workspace root. `L<a>-L<b>` is
the supporting line range (one line: `#L7-L7`). Multiple sources join with
`;` inside one marker. External material (web pages, papers, third-party
docs) has no legal marker until snapshotted into the workspace as a `ws:`
resource first — if you cite it before snapshotting, the claim reads as
unmarked. Never point a marker outside the workspace (including `../`
escapes); those are out-of-bounds and fail the whole artifact.

Do not put markers inside code spans or fenced code blocks — they are
recognized only in prose.

## Turn-end verification loop

When a writing turn stops, the evaluator runs automatically: gates (links,
style, executability) → extraction and read-back → a receipt appended to
the session ledger. You never write receipts yourself.

- If a gate fails, a claim is out-of-bounds, or coverage is below
  threshold, a nudge arrives in the same turn asking you to self-repair
  **once**. Backfill the missing markers or fix the cited spans, then stop;
  the re-evaluation produces the second receipt. If it still doesn't
  verify, state the shortfall in the deliverable note and hand it over —
  one round only, never loop.
- Coverage = claims with a legal marker that pass read-back ÷ detected
  claims. Unmarked verifiable sentences are the usual cause of a low
  number.

## Delivery states

`draft → verified → delivered`. An artifact is **verified** when no gate
fails, overall passes, and coverage meets the threshold — all three at
once. Any edit flips the artifact hash and returns it to draft.
**Delivered** means the user received the artifact and its receipt digest.
An artifact that does not verify may still be delivered, but it lands as
`delivered-unverified` (including "passes overall but below the coverage
threshold"); point the delivery note at the receipt and say so plainly.

## Style baseline

Write against the Diátaxis four-layer model (tutorial / how-to /
reference / explanation — pick one per document) and the Google developer
documentation style guide. The baseline and its rationale live in the
design doc §5; don't restate them here.

## Language (D3, provisional)

Self-declare the artifact language: a `lang:` frontmatter field, or state
it in the turn instruction. If undeclared, ask before writing. For mixed
documents, run the declared primary language's rules throughout.
