# Selective System-Prompt Sections

- Date: 2026-11-12
- Status: Implemented — PR #403 (merged 2026-11-12)

r3 → r4 fold: first-pass formula moved fully to `min-entry-bytes` with UTF-8-safe byte slicing (char-boundary cuts); call-site phrasing corrected to the single real `renderCatalog` call (`catalog.ts:234`) with settings threaded through the shared `render()` path.
- Program: context-engineering input governance (doc 4 of 8)
- Depends on: nothing hard; doc 3's `AssembleRow.sections[].bytes` is the distribution instrument that tunes the defaults.
- Literature basis: PAACE (plan-aware context slicing); Less Context (token ↓~63%).

## Formal design

- mode: auto (session-adopted; no formal-design screening clause in the project rules at this revision; adoption snippet at `<skill>/references/agents-snippet.md`).
- decision: not-needed (documented downgrade of an FD-L2 literal hit)
- triggerIds: FD-L2 (byte bounds) is literally hit, but deliberately downgraded: both renders are **stateless total functions** over `(defs, settings)` — the doc's own property tests (`bytes ≤ max-bytes` for all non-floor cases over random defs) are a complete decision procedure for the bound, and there is no cross-step state or ordering to miss.
- backends: `none`
- rationale (selected scope): downgrade justified by the absence of a state machine; the floor/overflow forms are finite-domain properties exhaustively testable. Re-screen if caps ever become adaptive or stateful.

## Problem

Variable system-prompt sections render uncapped on every assemble. The two large ones:

- `memory` section: the combined memory **topic index** renders without any cap (`packages/memory/memory/src/section.ts:357-369`; `:121-125` is only the registration site). Per-layer fragment bodies are already truncated by `truncateEntrypointContent`; the uncapped surface is the topic index.
- `cc:subagent-catalog` section: full roster `- agentType — whenToUse` lines, no byte cap; the 500 ms readiness re-render bounds latency, not bytes (`packages/subagent/task/src/catalog.ts:285-295`, `:132-167`).

## Goals / Non-goals

Goals:

1. Deterministic budgets with documented block-priority allocation for the two sections.
2. Discoverability preserved *up to a documented floor*: section existence, retrieval guidance, and agent names survive — and when the mandatory floor itself exceeds the budget, the floor wins (budgets are caps above the floor, never below).
3. Per-section settings, including explicit on/off for truncation, with generous provisional defaults tuned later from ledger data.

Non-goals:

- No phase-aware selection, no LLM relevance filtering, no claimed relevance ordering (neither section has any relevance/recency signal today; truncation boundaries are stated as what they are — alphabetical).
- No changes to `serena-first`, `output-styles`, persona, `foreign-rules`.
- Recall unaffected (it scans the memory directory itself).

## Current behavior (anchors)

- Memory section render layout (`section.ts:324-354`): header → per-layer `MEMORY.md` fragments → combined index → "Searching past context" guidance block.
- Combined index ordering is **alphabetical by filename** (`memory/src/scan.ts:82`, `section.ts:363`); MEMORY.md pointers append on write (`memory/src/save.ts:83-96`). No recency ordering exists anywhere in the render path.
- Catalog ordering is `localeCompare` over `agentType` (`catalog.ts:151,233`) — alphabetical, not relevance-ranked.
- `MemorySection.render` runs over cached scan state (`section.ts:184-197`) and is re-entered by the first-assembly readiness refresh (one-shot `withinBudget(..., READINESS_BUDGET_MS = 500)`, `section.ts:38,140-145` — **not** a periodic refresh; delta-round wording correction) and by `system-prompt/change` re-renders (`:191-197`, `:238`) — all paths route through the same render function.
- `renderCatalog(defs)` is pure (`catalog.ts:285-295`); there is **one** production render call site (`catalog.ts:234` inside `render()`); the snapshot write at `:253-254` only stores what `render()` produced. Settings therefore thread through the shared `render()` method so both the ordinary path and the readiness-completion path render identically (delta-round fold: the r3 text's "two call sites" phrasing pointed at a non-render line).

## Measurement and unit contract (folded from codex + grok)

- All budgets and the ledger (doc 3) use **UTF-8 bytes** (`Buffer.byteLength` in tests). The existing memory truncation layer already measures bytes (`truncate.ts:53`) — this doc aligns to it; nothing here uses `text.length`.
- Scope of the new caps: **the combined topic index and the catalog render only**. Per-layer memory fragments are already capped by the existing `truncateEntrypointContent` (200 lines / 25 KB per layer, `truncate.ts:13-17`) — this design adds no second cap on top of that. (r2 fold: grok's r1-BLOCKER that a whole-section 8192-char cap would fight the existing 25 KB entrypoint cap and immediately trim production with no observe mode. The new caps strictly target the surfaces that have **no** cap today.)

## Design

### A. Memory section: cap the combined index (`packages/memory/memory`)

New namespace `cc-memory-section`:

| key | type | default | bounds |
|---|---|---|---|
| `truncate` | bool | true | explicit on/off for the new cap (`false` = render the index uncapped — semantic per grok r1 fold: it never removes the section) |
| `max-bytes` | int | 8192 (**provisional** until ledger distribution data lands) | 1024..65536 |

Settings are threaded through the class via a stored getter consulted per render (hot reload covers the direct render, the 500 ms refresh, and `system-prompt/change` re-renders).

Only the **combined index block** is capped. Header, per-layer fragments (already capped by `truncateEntrypointContent`), and the "Searching past context" guidance block render byte-identical to today (r2 fold: grok's BLOCKER — truncating the section as a whole would eat the guidance and the fragments first).

When the index block's UTF-8 size exceeds `max-bytes`:

1. Truncate from the bottom of the alphabetical list, keeping whole entries only (never a partial line); final line `… (N more memory topics; grep the memory directory for older entries)` where N counts **entries**, not lines. Retained prefix = same alphabetical order as today.
   - Honest boundary: alphabetical ≠ relevance. mtime-ordered omission is a v2 refinement candidate once doc 3 assemble-row data shows how often truncation fires.
2. **Floor rule** (codex r1-BLOCKER fold): if even one index entry plus the ellipsis line exceeds `max-bytes`, render header + search block + ellipsis line with no entries — the section keeps its retrieval guidance and loses only enumeration. `max-bytes < 1024` is rejected by settings validation.

### B. Subagent catalog budget (`packages/subagent/task`)

New namespace `cc-subagent-catalog`:

| key | type | default | bounds |
|---|---|---|---|
| `truncate` | bool | true | explicit on/off |
| `max-bytes` | int | 8192 (**provisional**) | 1024..65536 |
| `min-entry-bytes` | int | 40 | 20..400 |

`renderCatalog(defs, settings)` stays pure, all cutting byte-measured (`Buffer.byteLength` — grok delta fold: a char-sliced `whenToUse` over a byte budget overflows on CJK content; the knob is renamed accordingly):

1. Reserve header + trailer + ellipsis line.
2. First pass: keep every `agentType` name; per-entry `whenToUse` truncates to a slice of `max(min-entry-bytes, floor((budget - reserved) / N))` — cutting is **UTF-8-safe byte slicing** (slice on char boundaries only, counted by `Buffer.byteLength`; a char index never splits a multi-byte sequence).
3. Second pass: if still over, keep the first K entries with truncated text; remaining agents collapse into one names-only line, plus the ellipsis note. K = largest count that fits. K is **alphabetical** — stated, not embellished.
4. **Oversized-names floor** (codex + grok r1 fold): if even the names-only render (header + trailer + all names) exceeds `max-bytes`, the names line itself truncates with `… (N more agents omitted by cc-subagent-catalog.max-bytes; the catalog's usage line stays)`. Names are dropped only in this documented overflow form, never silently — that is the consistency fix for the two-seat BLOCKER that name-preservation and hard-cap are mutually impossible on large rosters.

## Registration / repo checklist additions

No preset row changes; two new settings namespaces via `registerNamespaceSafe`; README pairs (settings tables, truncation semantics, floor rules, provisional-default labels); capability manifest entries.

## Verification

- Unit (memory render): index-block-only capping (fragments and guidance byte-identical); whole-entry truncation with correct N; floor case (one oversized entry → header + search block + ellipsis, no entries); `truncate: false` → index uncapped; hot settings getter.
- Unit (catalog): name preservation down to the names-only collapse; byte-accurate entry slicing (CJK `whenToUse` does not overflow `max-bytes`; `min-entry-bytes` knob); oversized-names overflow form (`… (N more agents omitted …)` present, names dropped only with the documented line); property test `bytes ≤ max-bytes` for all non-floor cases over random defs.
- Integration (real preset assemble): caps respected on first render, after the 500 ms refresh, and after `system-prompt/change` re-render.
- Acceptance: integration asserts UTF-8 byte sizes of the index block and catalog render ≤ `max-bytes` (non-floor); ledger (doc 3) reports section-byte distributions for the provisional-default re-tuning after one release of data.

## Risks

- Alphabetical truncation can hide the relevant topic/agent: mitigated by name preservation + always-retained retrieval guidance; v2 relevance refinement depends on observed truncation rates.
- Default behavior change: some sessions render less after the flip; `truncate: false` is the restore-previous-behavior valve.

## Fold ledger

r1 → r2 (critic + codex + grok, NO-GO → folded): false "newest-first" rationale removed (alphabetical order anchors: `scan.ts:82`, `save.ts:83-96`); whole-section cap redesigned to **cap the uncapped blocks only** — combined index + catalog (per-layer fragments already capped by `truncateEntrypointContent`, `truncate.ts:13-17`; grok's BLOCKER); whole-section truncation eating guidance/fragments resolved (index-block-level cap; grok BLOCKER); hard-cap-vs-preservation impossibility resolved by documented overflow forms (floor rules; codex BLOCKER + grok names-overflow MAJOR); recency/relevance claims removed everywhere (alphabetical, honest); units aligned to UTF-8 bytes (`truncate.ts:53` precedent; drops the text.length contract); explicit `truncate` on/off (grok: `enabled:false` must mean render-uncapped, never section removal); render-purity/settings threading across all three entry points; search-guidance block always preserved unmodified; 8192 defaults provisional.

r2 → r3 delta (three seats; net result after folds: GO-class): catalog entry slicing moved fully to bytes (`min-entry-chars` → `min-entry-bytes`; CJK overflow hole — grok); "500 ms refresh" reworded to the one-shot first-assembly readiness budget it actually is; catalog settings threading stated explicitly for both `renderCatalog` call sites (`catalog.ts:234`, `:253-254` — critic).
