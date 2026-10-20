# VWA lane-2 Hardening — Feature E: Large-Source Compaction

## Status: Implemented — PR #271 (open, pending merge). Three-lane blind review converged (critic + two external lanes, seven rounds, final round GO on all lanes).

This document is one of six feature designs split from the combined
lane-2 reliability hardening design. It addresses Problem 9 from the tui-40b4 session.
Dependencies: None.

The twelve session problems were each verified against current code at
HEAD 7960c4ff before design work began; all anchors below cite that tree.

## Feature E: Large-Source Compaction

### E.1 Problem

Sources stage tasks include the FULL source text in the review envelope
(review-input.ts:62). A 215KB source exceeds the 48K `maxContextChars` cap →
ReviewContextError. There is no compaction, windowing, or derived-source
mechanism. The user manually created a distilled substitute document and
computed UTF-16 spans by hand.

The 8 MiB hard limit (sources.ts:167) is a separate, much larger cap — the
binding constraint is the per-task context window.

### E.2 Design

**E.2.1 Structured data detection.**

Before windowing, detect whether the source is structured data or prose.
Structured sources are NOT windowed — head+tail of a structured file produces
invalid syntax that the model cannot evaluate.

Detection heuristic (conservative — false positives are safe, false negatives
are not):

```ts
function isStructuredData(text: string): boolean {
  const trimmed = text.trimStart()
  // JSON: starts with { or [
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return true
  // JSONL: first line parses as JSON
  const firstLine = trimmed.split('\n')[0] ?? ''
  try { JSON.parse(firstLine); return true } catch { /* not JSONL */ }
  // XML: starts with <?xml or <
  if (trimmed.startsWith('<?xml') || trimmed.startsWith('<')) return true
  // CSV/TSV: cross-line consistency — the first two non-empty lines have
  // the same field count when split by the same delimiter.
  // Known limitation: quoted CSV fields containing delimiters (e.g.,
  // `"a,b",c\nx,y`) produce inconsistent field counts and are misclassified
  // as prose. The derived-source path (E.2.3) is the recommended approach
  // for complex structured data.
  const lines = trimmed.split('\n').filter((l) => l.trim().length > 0)
  if (lines.length >= 2) {
    const delimiter = lines[0]!.includes('\t') ? '\t' : ','
    const firstFields = lines[0]!.split(delimiter)
    const secondFields = lines[1]!.split(delimiter)
    if (firstFields.length >= 2 && firstFields.length === secondFields.length) return true
  }
  return false
}
```

The CSV/TSV check requires cross-line consistency: the first two non-empty
lines must have the same field count when split by the same delimiter. This
correctly rejects prose ("It was the best of times, it was the worst of
times" has a comma but the next line won't have the same field count) and
correctly accepts CSV with empty first fields (`,value\nx,y` — both lines
have 2 fields).

When a structured source exceeds the context limit, the tool returns
`CONTEXT_TOO_LARGE` with a pointer to the derived-source path (E.2.3):

```json
{
  "ok": false,
  "code": "CONTEXT_TOO_LARGE",
  "message": "Source src_... is structured data (JSON/JSONL/CSV/XML) and exceeds the review context limit. Windowing is not applied to structured data. Register a distilled companion source with lineage.parentSourceIds: [\"src_...\"] to proceed.",
  "retryable": false
}
```

**E.2.2 Sources-stage envelope windowing (prose only).**

When a prose source's contribution to the envelope would exceed the context
limit, the envelope includes a windowed view instead of the full text.

Each sources-stage task inlines text only for its target source. Dependency
expansion can include other sources through shared claims, authenticity
evidence or lineage. These sources retain their metadata and any evidence
quotes/context slices, without inlining full source text. Their metadata and
all evidence slices count toward the serialized envelope budget, including
the initial full-text check and every windowed candidate. The final combined
envelope is measured before it is returned. Source dependencies remain in
the digest, so parent changes still invalidate a companion's review.

**Measured sizing**: the window size is computed by measuring the serialized
envelope (not by estimating from constants), then shrinking the window until
the envelope fits. The measurement is always performed — even for the
"fits without windowing" case — because JSON escaping can expand the
serialized size beyond the raw character count:

```ts
// In review-input.ts reviewContext, sources stage:
const MIN_SOURCE_WINDOW = 2000  // chars; below this, windowing is useless

function fitSourceText(text: string, envelopeWithoutText: unknown, maxContextChars: number): { text: string; windowing?: object } {
  // Measure the full envelope with the complete text first.
  const siblings = envelopeWithoutText.sources ?? []
  const fullCandidate = { ...envelopeWithoutText, sources: [...siblings, { text }] }
  if (stableJson(fullCandidate).length <= maxContextChars) {
    return { text }  // fits without windowing
  }
  // Compute the window from the remaining budget.
  const baseSize = stableJson(envelopeWithoutText).length
  const overhead = 300  // omission marker + windowing metadata (conservative)
  const availableForSource = maxContextChars - baseSize - overhead
  if (availableForSource < MIN_SOURCE_WINDOW) {
    throw new ReviewContextError('envelope overhead leaves insufficient room for source text')
  }
  const headChars = Math.floor(availableForSource / 2)
  const tailChars = availableForSource - headChars
  const windowed = text.slice(0, headChars) + '\n\n[... ' + (text.length - headChars - tailChars) + ' chars omitted ...]\n\n' + text.slice(-tailChars)
  // Measure the serialized envelope with the windowed text.
  const windowedCandidate = { ...envelopeWithoutText, sources: [...siblings, { text: windowed, windowing: { totalChars: text.length, headChars, tailChars } }] }
  const windowedSize = stableJson(windowedCandidate).length
  if (windowedSize <= maxContextChars) {
    return { text: windowed, windowing: { totalChars: text.length, headChars, tailChars } }
  }
  // JSON escaping expanded the text beyond the raw char estimate.
  // Shrink by the overshoot and retry once.
  const overshoot = windowedSize - maxContextChars
  const shrunkAvailable = availableForSource - overshoot - 500  // safety margin
  if (shrunkAvailable < MIN_SOURCE_WINDOW) {
    throw new ReviewContextError('envelope overhead leaves insufficient room for source text after JSON escaping')
  }
  const shrunkHead = Math.floor(shrunkAvailable / 2)
  const shrunkTail = shrunkAvailable - shrunkHead
  const shrunkWindowed = text.slice(0, shrunkHead) + '\n\n[... ' + (text.length - shrunkHead - shrunkTail) + ' chars omitted ...]\n\n' + text.slice(-shrunkTail)
  // Measure the shrunk candidate too — the safety margin may not cover
  // pathological escaping (e.g., text that is 100% newlines).
  const shrunkCandidate = { ...envelopeWithoutText, sources: [...siblings, { text: shrunkWindowed, windowing: { totalChars: text.length, headChars: shrunkHead, tailChars: shrunkTail } }] }
  if (stableJson(shrunkCandidate).length > maxContextChars) {
    throw new ReviewContextError('envelope overhead leaves insufficient room for source text even after shrinking')
  }
  return {
    text: shrunkWindowed,
    windowing: { totalChars: text.length, headChars: shrunkHead, tailChars: shrunkTail },
  }
}
```

The key invariant: every return path (full text, windowed, shrunk) is
measured against the serialized envelope size, not estimated from raw
character counts.

The implementation measures the persisted target entry and the full
`taskEnvelope` scaffold (including contract, rules, dependencies and budget),
rather than the bare `{ text }` illustration above. The runner also reserves
the stage prompt's length from the whole-message context budget.

**Evidence context slices**: for the sources stage, `currentReviews` is empty
(first stage), so the main risk is evidence slices. Evidence context spans
are capped at 12K chars each (graph.ts:143-144). When multiple evidence items
reference the same source, their context slices can dominate the envelope.
The `envelopeWithoutText` serialization accounts for this by measuring the
full envelope without the source text.

**Sources stage only**: windowing applies only to the sources stage — the
only stage that inlines full source text (review-input.ts:62). Other stages
include evidence quotes and context slices but not full source text.

**Prompt update**: the sources prompt gains one paragraph:

> When a source's `windowing` field is present, the text is a head+tail
> excerpt of the full source. Provenance, edition, and access information
> (SOURCE-01) is typically at the head; content assertions (SOURCE-02) may
> be sampled from both ends. If the excerpt is insufficient to evaluate a
> rule, return `needs-review` for that rule with an explanation that the
> windowed excerpt is insufficient.

**Prompt hash change**: the sources prompt changes → `promptHash` changes →
existing sources records are NOT reused. One-time cache invalidation.

**§13 amendment**: the design doc's "evidence is never truncated" rule is
amended for the sources stage only: the source text may be windowed when the
envelope exceeds the context limit, with explicit disclosure via the
`windowing` field. Evidence quotes and context slices are never truncated —
they are either included in full or the task fails with CONTEXT_TOO_LARGE.

**E.2.3 Derived source registration.**

A source can be registered with `lineage.parentSourceIds` pointing to the
original large source. The derived source IS a separate source (with its own
snapshot, hash, and review). The lineage field already exists in the data
model.

The companion must be cited instead of the oversized original in claim scope
or evidence to request its review.
The original remains registered and participates in dependency metadata and
invalidation, but its full text is not included in the companion's review.
Reviewing a companion does not verify its parent's full content or establish
the parent's authenticity. A separate review of an oversized structured
original still returns `CONTEXT_TOO_LARGE`.

The skill doc provides this guidance:

> When a source exceeds the review context window, register a distilled
> companion source with `lineage.parentSourceIds: ["src_original"]`. The
> companion's text should be a faithful summary or structured extract (e.g.,
> counts, key passages). Cite the companion instead of the oversized original
> in claim scope or evidence.
> Its lineage makes the derivation explicit; reviewing the companion does
> not verify the full original.

### E.3 Implementation

1. `review-input.ts`: structured data detection (cross-line consistency for
   CSV/TSV); measured windowing in reviewContext for the sources stage;
   fitSourceText helper with measure-and-retry.
2. `prompts/sources.md`: add windowing paragraph.
3. `SKILL.md`: add derived-source guidance.
4. `types.ts`: add optional `windowing` field to the source envelope type.

### E.4 Tests

- review-input.spec.ts: JSON source > limit → CONTEXT_TOO_LARGE with
  derived-source pointer, no windowing.
- review-input.spec.ts: JSONL source > limit → CONTEXT_TOO_LARGE.
- review-input.spec.ts: CSV source with spaces in headers > limit →
  CONTEXT_TOO_LARGE.
- review-input.spec.ts: two-column CSV > limit → CONTEXT_TOO_LARGE.
- review-input.spec.ts: CSV with empty first field > limit →
  CONTEXT_TOO_LARGE.
- review-input.spec.ts: XML source > limit → CONTEXT_TOO_LARGE.
- review-input.spec.ts: prose source with commas in first line → NOT
  detected as CSV (cross-line consistency fails).
- review-input.spec.ts: prose source > limit → windowed text + windowing
  field; window size fits within maxContextChars after JSON escaping.
- review-input.spec.ts: prose source ≤ limit → full text, no windowing field
  (measured, not estimated).
- review-input.spec.ts: newline-heavy prose source → windowed text fits
  after measure-and-retry.
- review-input.spec.ts: envelope with large evidence context slices → window
  shrinks to accommodate; when overhead alone exceeds limit →
  ReviewContextError.
- review-adapter.spec.ts: sources response with needs-review citing
  insufficient window validates.
- Integration: register a 200KB prose source, run sources stage, assert the
  envelope contains windowed text (not the full 200KB).
- Regression: two large sources supporting one claim produce separate
  target reviews that fit the whole-message budget, retaining related
  metadata and untruncated evidence slices. Include the case where text
  alone fits but related metadata makes the envelope exceed the limit.
- Regression: a cited distilled companion of an oversized JSON source
  dispatches successfully with parent metadata only; parent changes still
  invalidate its review, and directly reviewing the original still refuses.

---

---

## Review history for this feature

The design passed three-lane blind review (an internal critic seat plus
two external seats) over seven folding rounds. Cross-feature findings
(for example the shared cache-key and feasibility interactions between
Features A and C) were adjudicated in the combined draft; the per-round
ledger below lists the findings that touched this feature's sections.

### Round 1 (three-lane, v1 draft)
| Lane | Verdict | Key findings |
| Codex | NO-GO | A: missing requiredRules in cache key, arbitrary record selection. B: budget math wrong, config drift misclassified. C: currentReviews breaks with batching. D: cascade safety overstated. E: 30K threshold unsafe. F: coverage grep broken. |
| Grok | GO-WITH-CHANGES | A: continue-on-complete is silent skip. B: retry math respects wall-clock, truncation permanent. C: batching doesn't close gap, currentReviews breaks. D: need per-task errorDetail in report. E: structured data shouldn't be windowed. F: coverage glob wrong. |
| Critic | GO-WITH-CHANGES | A: record selection nondeterministic, disagreement skipped. B: rawResponse plumbing path wrong, use finish.failure. C: envelope targets collision, budget math false-positive. E: window evidence slices too. F: grep broken, exclude MCP/plugin. |
### Round 2 (three-lane delta, v2 draft)
| Lane | Verdict | Fold results | New issues |
### Round 3 (three-lane micro-confirmation, v3 draft)
| Lane | Verdict | Fold results | New issues |
### Round 4 (three-lane micro-confirmation, v4 draft)
| Lane | Verdict | Fold results | New issues |
### Round 5 (codex micro-confirmation, v5 draft)
| Lane | Verdict | Fold results | New issues |
### Round 6 (codex micro-confirmation, v5 updated)
| Lane | Verdict | Fold results |
### Round 7 (codex micro-confirmation, v5 final)
| Lane | Verdict | Fold results |

**Convergence**: seven rounds; the final reviewed draft carries every
folded finding. The full three-lane ledger is preserved in the session
records (`.scratch/vwa-enhancement-design-v5.md` history).
