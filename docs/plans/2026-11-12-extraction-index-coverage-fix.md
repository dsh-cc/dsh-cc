# Extraction Write-Back Index Coverage Fix (v2.1)

- Date: 2026-11-12
- Status: Implemented — PR #405 (open, pending merge); review converged at v2.1 r3 (critic + codex; grok seat down on auth)
- Program: memory integrity (incident-driven)
- Depends on: nothing hard. The dream path and the optimistic index commit protocol (`commitMemoryWrites`, modeled by `specs/tla/memory-write-lifecycle`) are unchanged.

## Incident (evidence chain in `memory-index-destroyed-by-extraction-writeback`)

At 2026-11-12 21:45:11 the workspace `MEMORY.md` shrank from 13,615 bytes (~37 pointer lines) to 3,440 bytes / 7 lines. The writer was an extraction fork settle: the fork reported `{writes: [one topic file, MEMORY.md-with-only-its-own-pointer]}`, and the host write-back committed it verbatim. Root causes: (1) `mergeIndexContent` treats the fork's rewrite as authoritative including deletions; (2) both extraction dispatch sites pass a **capped** index as the merge baseline (`extraction-coordinator.ts:293` `read.promptIndex`; `index.ts:299` `readExistingIndex` — 200 lines / 8 KiB via `capIndexForPrompt`), so over-cap lines were misclassified as concurrent additions (the 7 survivors were exactly the over-cap tail); (3) the fork's instruction is unsatisfiable at 552 topics under the entrypoint caps. Topic files were untouched.

## Review fold ledger

**r1 → v2**: v1 (label-keyed additive restore) rejected by both seats — carve drops retained pointers (codex, reproduced), whole-document `includes` spoofable (both), escape hatch unimplementable (builder throw exits with zero writes). Both seats independently converged on host-side upsert; v2 adopted it.

**v2 → v2.1** (critic + codex delta, convergent):
- **Line ownership** (codex P1 / critic P1#2): replacing "the first line containing `](path)`" can erase a foreign pointer whose *description* links to `path` (`- [foreign](foreign.md) — see [batch](batch.md)`). Fix: match on the line's **first pointer target** (`firstPointerTarget(line) === path`, `index-commit.ts:29-36`); a line belongs to its first link's target; unmatched → append. Both seats endorse; resolves the last loss vector.
- **Over-cap steady state must not fail the job** (critic P1#1): `validateMemoryWrites`' entrypoint gate is strict by default, so an unchanged-but-over-cap index write would throw → every extraction fails forever. Fix: the fork's index write is dropped BEFORE validation; the host-generated index write is NOT a batch member (see validation ordering) and the builder emits no index write at all when the resulting content is byte-identical to `fresh`.
- **Description sanitization + clamping** (codex P2 / critic P1#3): frontmatter name/description are unclamped, may contain markdown link syntax (manufacturing ambiguous lines) and newlines (breaking one-line-per-pointer). Fix: the pointer-line renderer sanitizes (single line, markdown-link syntax neutralized, `MAX_DESCRIPTION_CHARS` clamp with truncate+warn).
- **Validation ordering + accounting** (codex P2#4): an over-cap fork index would fail validation before being "ignored" — so drop first, validate the topic payload only; the generated index write never re-enters the batch validator (a 32-topic report + generated index would otherwise exceed the batch file-count limit).
- **Parse-failure fallback claim corrected** (codex P2#3): `scan.ts:73-74` skips unparseable topics, so a frontmatter-less batch entry lands with no index line AND no scan/recall visibility — grep only. Documented as degraded-but-committed (still strictly better than dropping the write).
- **Label threading phrasing fixed** (critic (a)): `writeBackReport` has no label param today; it must be threaded from `startMemoryJob` (its `label` argument already exists at the dispatch signature).
- **Single-target replacement rule** (codex r3, its own prescribed fix): first-target ownership alone still loses a secondary target on a grouped line whose first target IS the batch path (`- [batch](batch.md), [foreign](foreign.md)`). Replacement now requires the matched line to carry no other pointer target; otherwise the line is preserved, the refresh skipped, a warn fired.
- **Empty batch** (critic P2#4): a report whose only write is the dropped index write completes with zero writes.
- **Resurrection risk reworded** (critic P2#5): any legacy-extraction batch writing topic T unconditionally re-upserts T's pointer (no conditional on dream rewrites).

## Goals

1. An extraction write-back can never remove or rewrite a pointer line other than by upserting pointer lines for topics **in its own batch**, where a line is "owned" by the target of its first markdown link. (Structural: the fork's index write is not executed at all.)
2. The dream path is unchanged (authoritative full-index rewrite remains its consolidation mechanism).
3. Fail-safe degradation: over-cap or unparseable inputs skip the pointer (warn) and never fail the job; the topic write still commits; the index never regresses.
4. No behavior change for saves, dreams, or the CAS/rebase commit loop.

## Non-goals

- No change to the dream write-back (`mergeIndexContent` / `pointerAdditions` / `carveEntrypointRoom` untouched).
- No change to the entrypoint caps.
- No corpus migration tooling in the repo (the workspace rebuild is a local ops action).
- No fix for the pre-existing `capIndexForPrompt` (chars) vs `capIndexText` (bytes) mismatch — backlog; with v2.1 extraction never consumes a merged baseline.
- No fix for the save path's own `includes`-based `upsertPointer` line matching (pre-existing, out of scope; the write-back helper is a new implementation that does not inherit it).

## Design

### A. Extraction write-backs ignore the fork's index write and upsert pointers host-side

`writeBackReport` gains a `label` parameter, threaded from `startMemoryJob`'s existing `label` argument (the call sites already pass `'extract-memories'` / `'memory-consolidation'`):

- `label === 'memory-consolidation'` (dream): exactly today's behavior. `baselineIndex` consumed as today.
- `label === 'extract-memories'`:
  1. **Drop first**: remove any `MEMORY.md` entry from the fork's `writes` BEFORE any validation (an over-cap or malformed fork index must not fail a batch whose index write is going to be ignored anyway). At most one exists by shape; the drop is silent-by-design — the prompt is updated in the same PR and old-shape reports are tolerated.
  2. **Validate the topic payload only**: `validateMemoryWrites` over the remaining topic writes (filename rules, per-file and total byte caps, duplicates). An empty payload after the drop is legal: the job completes with zero writes.
  3. **Commit with host-side upserts** through the existing `commitMemoryWrites` loop; the per-attempt builder:
     - Reads `fresh` (the durable index at this attempt).
     - For each topic write, in batch order: parse frontmatter from that write's own content (`parseMemoryFile`); on failure → no pointer for that entry, warn once per batch (the topic commits but has degraded visibility: no index line, no scan/recall presence, grep-only — honest degradation, still better than dropping the write).
     - Build the pointer line `- [name](path) — description` with the link target = the **batch path** (not the frontmatter name) and the display text **sanitized**: single line; markdown link syntax neutralized (strip `[` `]` `(` `)` from name and description — they are display-only text); description clamped to `MAX_DESCRIPTION_CHARS` with truncate+warn.
     - **Ownership matching (single-target rule, r3 fold)**: find the first line whose `firstPointerTarget(line) === path`; replace it ONLY when that line carries **no other pointer target** (count all `](...md)` matches on the line — one, the batch's own, is required). A line with additional targets (grouped pointers, description links) is preserved byte-identical, the refresh is skipped, and a warn fires (no duplication: we do not append a second line for a target already listed). Never `includes`. Unmatched → append. This makes the invariant total: a replacement can only consume a line that pointed solely at the batch path.
     - **Cap gate per upsert**: if the resulting index would exceed `MAX_ENTRYPOINT_LINES`/`MAX_ENTRYPOINT_BYTES`, skip that upsert and warn (the old line stays for a replacement; nothing lands for an append). A replacement that would *shrink* the index (or keep it under cap) is allowed even from an at-cap index.
     - **Byte-identical short-circuit**: if the resulting index content equals `fresh` (e.g., every upsert was skipped, or the payload was empty), return topic-writes only — no index write is emitted (the commit loop's existing no-index shape). This also guarantees a pre-existing over-cap index never produces a failing index write.
     - Return `{writes: [...topicWrites, {path: ENTRYPOINT_NAME, content: newIndex}]}` when an index write is warranted. The host-generated index write does NOT re-enter `validateMemoryWrites` (it is not fork payload; the builder's own cap gate is its validation).
  4. Per-attempt recompute: upserts and skip decisions are re-derived from `fresh` on every CAS round (stateless across attempts); warns fire from the committed attempt only.

`baselineIndex` is no longer consumed by the extraction path. Both existing dispatch sites keep their signatures; their capped baselines become inert for extraction.

### B. Label validation

`startMemoryJob` validates `label ∈ {'extract-memories', 'memory-consolidation'}` and throws on anything else (unknown labels must not silently default to deletion-capable authority). The three call sites are the only callers (`index.ts:174`, `:398`, `:440`; `index.ts:299` routes through `startMemoryJob` with `'extract-memories'`).

### C. Prompt update

Both extraction prompt builders (`buildExtractionPrompt`, `buildWindowedExtractionPrompt`, `prompts.ts:37` / `:79`) replace the "Add or update a one-line pointer in `MEMORY.md`" instruction with: report topic files only — the host maintains `MEMORY.md`. Old-shape reports remain valid input (the write is dropped per §A.1). The "Existing topics" injection stays (dedupe guidance).

## Formal design screening

- mode: auto (session-adopted; no formal-design clause in project rules at this revision).
- decision: **not-needed**.
- rationale: the extraction write-back's index interaction becomes structurally bounded upserts inside the existing per-attempt builder — no model-authored index content, no restore inference, no protocol change to the CAS/rebase loop (a builder returning topic-writes-only is an existing supported shape; the builder-throw-is-terminal contract unchanged). The safety property — *an extraction write-back alters only lines whose first pointer target is a path in its own batch* — is structural (a consequence of what the builder can emit), not a total-function property needing exhaustive verification. The dream path and the modeled protocol (`specs/tla/memory-write-lifecycle`) are untouched.
- Re-screen trigger: if extraction ever again accepts model-authored index content, or if upserts gain cross-attempt state.

## Test plan (TDD — red first)

1. **Incident reproduction (integration, RED)**: extraction-labeled job, report = one new topic + `MEMORY.md` with only its own pointer; seed 8 baseline pointers. Assert: all 8 baseline lines byte-identical after settle; the new topic's pointer appended; the fork's index write not executed. Fails on current code.
2. **Upsert semantics (unit)**: new topic → appended line from frontmatter, link target = batch path; updated topic (same path, new frontmatter) → its line replaced in place; path ≠ frontmatter-name → target follows the path.
3. **Ownership matching (unit, both orderings)**: a line whose description links to `path` (`- [foreign](foreign.md) — see [batch](batch.md)`) is NOT matched by an upsert for `batch.md`; AND a grouped line whose FIRST target is `path` (`- [batch](batch.md), [foreign](foreign.md)`) is NOT replaced (preserved byte-identical, refresh skipped, warn) — the r3 codex counterexample. The foreign target survives in both orderings.
4. **Sanitization + clamping (unit)**: frontmatter name containing `](foreign.md)` and a multi-line/oversized description → the emitted line is single-line, link-syntax-free, description clamped to `MAX_DESCRIPTION_CHARS`, truncate+warn.
5. **Fork index write ignored before validation**: a report whose `MEMORY.md` is over-cap (would fail `validateMemoryWrites`) still commits its topic writes; the index write is dropped without failing the job.
6. **Cap gate**: append over lines/bytes → skipped + warn, index otherwise unchanged, topic committed; replacement over bytes → old line kept + warn; replacement that shrinks an at-cap index → succeeds.
7. **Pre-existing over-cap index (frozen-not-failing)**: index already over cap → extraction completes (status `completed`), all appends skipped + warns, index byte-identical.
8. **Concurrent save preserved**: a pointer added to the durable index after job start survives the extraction settle.
9. **Dream regression (must stay green)**: existing `write-back-commit.spec.ts` suite unchanged and green.
10. **Label validation**: unknown label throws at `startMemoryJob`; both known labels dispatch.
11. **Frontmatter-less batch entry**: topic commits, no pointer, warn once; empty payload after drop → completes with zero writes.
12. **Batch-order sequential skips**: one append skipped (cap) then a later smaller append that fits → lands (batch order semantics).
13. **Prompt contract**: both prompt builders no longer instruct index maintenance.
14. **Live acceptance (post-merge)**: re-enable extraction, one turn, compare the index target set before/after: `after ⊇ before` and `after ⊖ before ⊆ batch paths` (skipped upserts allowed; the cap and parse-failure policies make the union conditional).

## Risks

- **Index growth / frozen-at-cap steady state**: extraction can no longer shrink the index; at cap, appends skip with warns (job still `completed` — v2.1 fixes the v2 shape where it would have failed validation forever). No repair trigger exists for extraction; the dream is the sanctioned shrink path. Degraded-but-safe: recall and the scan-based render still see every parseable topic.
- **Degraded visibility for unparseable topics**: a frontmatter-less batch entry commits with no index line and no scan/recall presence (grep only). Accepted and warned; strictly better than dropping the write.
- **Dream/legacy-extraction interleaving**: the legacy path takes no lease (pre-existing); any legacy extraction batch that writes topic T unconditionally re-upserts T's pointer, even against a dream that just consolidated T away. Index growth, not loss; the coordinator path serializes via the lease.
- **Prompt/report drift window**: a fork following the old prompt wastes tokens writing an index block that is dropped. Bounded by the same-PR prompt update.

## Rollout

1. Fix lands (this PR), CI green.
2. Rebuild the workspace `MEMORY.md` from topic frontmatter (local ops script, newest-first under the caps, trailing provenance note) — extraction is currently `off` (user-layer, user-confirmed this session), so the rebuild is safe immediately; the fix protects it thereafter.
3. Re-enable `cc-systemone-memory-extraction` (user-layer, with consent).
4. Live acceptance per test 14.

## Alternatives considered

- **Additive restore (v1, rejected in r1)**: carve could still drop retained pointers; `includes` presence checks spoofable; escape hatch unimplementable.
- **Reject-don't-restore**: loses the batch's memories with no retry this turn; still trusts model-authored index content.
- **Prompt-only fix**: no host-side invariant; survives any model mistake.
