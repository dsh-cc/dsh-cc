# VWA writing guidance (citation checks: technical documentation)

An AGENTS-mountable fragment for the verifiable workspace agent, citation checks.
Design basis: `docs/plans/2026-10-12-verifiable-workspace-agent.md` (§5 for
the pipeline and language note, §4 for the receipt contract). This fragment
is behavioral guidance, not a re-spec; where the two disagree, the design
doc wins.


## File writes: editing tools only

Write documents with the file editing tools (`write` / `edit`), never with shell redirection, heredocs, or `python -c` file writes. The evidence pipeline's artifact set is derived from editing-tool events inside the turn window: a bash-redirect edit is invisible to it, so the document leaves no receipt and never verifies. This editing-tool rule is load-bearing for every following section.


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

A second spec cites a **registered project source** instead of a live file:
`〔src:gr:<sourceId>#L<a>-L<b>〕`. The line range is read back from that
source's snapshot bytes, so the citation stays stable after the original file
moves or changes. Two restrictions apply:

- A source is `gr:`-citable only when its registered path is corpus-class —
  a `docs/` path or a `.md`/`.mdx` file. That is the same frozen whitelist
  `ws:` already obeys; it exists so a snapshot cannot make a non-corpus file
  citable by being registered.
- Sources registered before the snapshot pipeline recorded a corpus path
  cannot be cited with `gr:` at all. Re-register the source to cite it; a
  `gr:` marker naming such a source is an invalid marker, not a silent pass.

`ws:` and `gr:` specs may be mixed inside one marker with `;`.

Do not put markers inside code spans or fenced code blocks — they are
recognized only in prose.

## Drafts: edit the draft, never the deliverable

A bound document in a VWA project has two files, and only one of them is
yours to edit:

| File | Who writes it |
| --- | --- |
| `.dsh/vwa/<projectId>/drafts/<name>.md` | the agent, with `write` / `edit` |
| the deliverable path (e.g. `docs/article.md`) | the bind transaction, as compile output |

The draft is the source. It carries the markers. The deliverable is the
render: `argument.update` with `op: "bind-artifact"` and `mode: "draft"`
reads the draft, strips every `〔src:…〕` / `〔claim:…〕` marker from it, and
writes the result to the deliverable inside the same commit that records the
binding. Consequences worth internalizing:

- **Never edit the deliverable.** An edit there is drift, not authoring: it
  is invisible to the graph and gets overwritten by the next bind. Edit the
  draft and re-bind.
- **Occurrence spans are draft coordinates.** `start`/`end` index the draft
  text as written, markers and all, so adding a citation earlier in the
  paragraph still shifts them.
- **Markers never reach the reader.** Uniform removal applies inside code
  spans and fences too, so a document that must display a marker literally
  cannot be authored as a draft verbatim.
- **Re-binding overwrites; first binding does not.** Taking over bytes this
  pipeline never produced needs `overwrite: true` on the mutation.
- **Extension caveat.** Draft mode itself accepts a deliverable path with any
  extension outside the state tree, but `argument.review` still reads the
  deliverable through the markdown artifact-path gate (`.md` / `.mdx`). A
  non-markdown deliverable binds and renders yet cannot be reviewed. Keep
  deliverables markdown; do not promise reviewability for any other
  extension.

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

For a draft-backed artifact the hash that counts is the **rendered**
deliverable's hash — the file the reader gets, markers already stripped.
Editing the draft does not flip it until you bind; that is why the bind, not
the edit, is the state transition. When the deliverable on disk matches
neither the bound hash nor a render this pipeline produced, the artifact is
reported as stale rather than quietly re-verified, and the remedy is to
re-run the bind.

## Style baseline

Write against the Diátaxis four-layer model (tutorial / how-to /
reference / explanation — pick one per document) and the Google developer
documentation style guide. The baseline and its rationale live in the
design doc §5; don't restate them here.

## Language (D3, provisional)

Self-declare the artifact language: a `lang:` frontmatter field, or state
it in the turn instruction. If undeclared, ask before writing. For mixed
documents, run the declared primary language's rules throughout.
