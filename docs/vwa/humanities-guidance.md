# VWA humanities guidance (argument review: evidence and argumentation)

An AGENTS-mountable fragment for the verifiable workspace agent, argument review.
Design basis: `docs/plans/2026-10-16-vwa-evidence-argument.md` (§2 for the
compatibility table, §19 for the body-text requirements). This fragment is
behavioral guidance, not a re-spec; where the two disagree, the design doc
wins. It extends — never overrides — the citation checks (`docs/vwa/writing-guidance.md`).


## Bound paths: draft-backed vs legacy inline

A bound document has one of two shapes, and the hash-watch story differs.

**Draft-backed (the current shape).** The binding records a draft under
`.dsh/vwa/<projectId>/drafts/`; the deliverable is that draft's render —
compile output written by the bind transaction. Editing the deliverable
yourself changes bytes the graph does not own: it is drift, the next bind
overwrites it, and until then the artifact reports as stale rather than
verified. Edit the draft and re-bind.

**Legacy inline (unchanged).** A binding made without a draft keeps the v1
behaviour: the bytes at the deliverable path are the artifact, and writes
from ANY editor trigger re-evaluation at turn-end, including shell
redirections. Writing such an artifact through shell tools is not a way
around review: it changes the artifact hash, invalidates the binding, and
forces a re-bind and a full re-audit. Binding with `mode: "draft"` is the
explicit conversion path; nothing converts implicitly.

For unbound paths the citation-check "editing tools only" rule still
applies: an unbound file stays invisible to the evidence pipeline.


## Claim markers (authoring aid)

A new marker MAY be used while drafting: `〔claim:<id>〕`, pointing at a
claim registered in the project graph. Notes:

- Citation checks treat `〔claim:<id>〕` as non-marker text: it is skipped,
  produces no `invalid-marker`, and preserves all character offsets. Mixing
  it with `src:` markers is safe.
- By default, writing claim markers is NOT required. The argument-review audit
  extracts the artifact independently and aligns it against the graph;
  occurrences of claims in the body are used directly.
- Claim markers are an authoring aid only. In a draft-backed artifact the
  render strips them, so they never reach the deliverable and removing one
  never changes the deliverable hash — it changes the draft hash, which is
  the graph↔source drift figure. Re-bind if you want that figure current.
  Legacy inline artifacts keep the old rule: a claim marker left in the
  delivered bytes is part of the artifact hash, so remove it before formal
  delivery and re-bind and re-audit.


## Migrating a v1 project

`/vwa repair <projectId> --migrate` moves a `schemaVersion 1` project to the
v2 layout: source snapshots to `.dsh/vwa/<projectId>/sources/`, review
reports to `.dsh/vwa/<projectId>/reports/`, and it creates the `drafts/`,
`renders/` and `retired/` directories. Every snapshot is hash-verified before
anything moves; the migration is all-or-nothing.

The move rewrites every source path, which changes every review identity, so
migration **retires** the project's review records and adjudications into
`retired/` instead of pretending they still apply. The project reads
`not-run` until it is reviewed again; that is the stated cost of the move,
not a lost result, and there is no half-converted state to reason about.
Sources registered before the move carry no recorded corpus path, so
re-register them before citing them with `gr:`.


## Body-text requirements (§19)

- Necessary qualifications appear in the relevant paragraph, not only in
  the closing report. The report may elaborate, but it cannot rescue a
  determinative error in the body text.
- Keep existing source markers as locatable references; record all
  multiple sources.
- Where evidence is still missing, say so plainly in the body. Honest
  wording such as "no verified evidence yet", "not checked", "not found
  within the following scope", or a registered gap statement is required —
  templates like "no controversy" or "proven absolutely correct" are not
  acceptable anywhere in the deliverable.
- Verbatim quotes from sources stay short, reviewed, and relevant; never
  copy an entire source into the deliverable.


## Review loop

Heavy semantic review runs only when you invoke `argument.review`. The
review never modifies your graph or your body text; it returns findings
(omissions, over-strong or over-broad statements, unsupported claims) that
you address by editing the artifact and updating the graph. When the audit
extracts a claim you never registered, it proposes — never silently
writes — the new claim; adopt it via `argument.update`, then re-review the
affected passages.
