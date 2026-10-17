# VWA humanities guidance (lane 2: evidence and argumentation)

An AGENTS-mountable fragment for the verifiable workspace agent, lane 2.
Design basis: `docs/plans/2026-10-16-vwa-evidence-argument.md` (§2 for the
compatibility table, §19 for the body-text requirements). This fragment is
behavioral guidance, not a re-spec; where the two disagree, the design doc
wins. It extends — never overrides — lane 1 (`docs/vwa/writing-guidance.md`).


## Bound paths are hash-watched

Once a document is bound to a VWA lane-2 project, its bytes are
hash-watched: writes from ANY editor trigger re-evaluation at turn-end,
including shell redirections. The lane-1 "editing tools only" rule still
applies to *unbound* paths — an unbound file stays invisible to the
evidence pipeline — but a bound path loses that invisibility. Writing a
bound artifact through shell tools is therefore not a way around review:
it changes the artifact hash, invalidates the binding, and forces a
re-bind and a full re-audit.


## Claim markers (authoring aid)

A new marker MAY be used while drafting: `〔claim:<id>〕`, pointing at a
claim registered in the project graph. Notes:

- Lane-1 mechanical verification treats `〔claim:<id>〕` as non-marker
  text: it is skipped, produces no `invalid-marker`, and preserves all
  character offsets. Mixing it with `src:` markers is safe.
- By default, writing claim markers is NOT required. The lane-2 audit
  extracts the artifact independently and aligns it against the graph;
  occurrences of claims in the body are used directly.
- Claim markers are an authoring aid only. Internal claim markers are not
  retained in the final body text: removing them before formal delivery
  changes the artifact hash, so the artifact MUST be re-bound and
  re-audited afterwards.


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
