# Memory section: one unified, maintained-order topic catalog

- Date: 2026-11-13
- Status: Implemented — PR #415 (merged 2026-11-13); design v3b (r1 three-lane review folded, then the r2 and
  r2→v3b delta rounds folded — see the fold ledger below).
- Supersedes (partially): `docs/plans/2026-11-12-selective-system-prompt-sections.md` §A. That doc capped the derived
  index and kept the per-layer `MEMORY.md` fragments. This doc removes the fragments and merges both views into one
  budgeted catalog. §B (subagent catalog) is untouched. That landed doc is deliberately left byte-unmodified by this
  change (its §A is historical record); this header is the supersession pointer of record.
- Program: context-engineering input governance (follow-up to doc 4 / PR #403)
- Depends on: nothing hard.

## Formal design

- mode: auto (session-adopted)
- decision: not-needed
- triggerIds: FD-L2 (byte bounds) is literally hit and deliberately downgraded — the same downgrade doc 4 recorded.
- backends: `none`
- rationale: the added logic is a **stateless total function** over `(layers, options)`: ordering, trimming and
  fitting have no cross-step state, no async ordering and no crash-recovery surface. Bounds are finite-domain
  properties exhaustively testable by property tests over random corpora (`rendered catalog bytes ≤ max-bytes` for
  every non-floor case) — that is a complete decision procedure **for the bound**, and nothing here claims it proves
  behavior for arbitrary settings or arbitrary text. The stateful machinery around the render (cached scan state, the
  500 ms first-assembly readiness refresh, `system-prompt/change`) keeps its existing mechanism, **but** the
  change-detection KEY changes and that change is in scope and explicitly tested (§F, R6). Re-screen if ordering ever
  becomes adaptive, mtime-dependent or otherwise stateful.

## Problem

The `memory` system-prompt section renders the same information twice, from two different sources, truncated along
two different axes, and the two views drift apart.

Layout today 〔src:ws:packages/memory/memory/src/section.ts#L377-L408〕:

1. `# Memory` header + save guidance (fixed, ~800 B).
2. **Per-layer `## MEMORY.md (<label>)` fragments** — the on-disk entrypoint text verbatim, capped per layer by
   `truncateEntrypointContent` at 200 lines / 25 KB 〔src:ws:packages/memory/memory/src/truncate.ts#L14-L17〕.
3. **`## Memory index`** — a *derived* list of every topic file's frontmatter, sorted by filename, capped at
   `cc-memory-section.max-bytes` = 8192 〔src:ws:packages/memory/memory/src/section-settings.ts#L42-L45〕
   〔src:ws:packages/memory/memory/src/section.ts#L411-L467〕.
4. `## Searching past context` grep guidance.

Blocks 2 and 3 enumerate the same directory twice. The entrypoint lines are themselves one-line pointers
(`- [name](file) — description`) that `memory_save` maintains
〔src:ws:packages/memory/memory/src/save.ts#L83-L96〕 and the dream rewrites
〔src:ws:packages/memory/memory-consolidation/src/prompts.ts#L135〕; the derived index re-extracts the same triple
from each topic's YAML frontmatter 〔src:ws:packages/memory/memory/src/section.ts#L417-L420〕.
Two enumerations mean two truncation axes:

- The 25 KB entrypoint cap freezes the fragment: a save past the cap is skipped, so the fragment stops tracking the
  directory while the derived index keeps tracking it. The model sees two disagreeing partial views.
- The 8 KB cap truncates **alphabetically** — at scale the retained part is a letter prefix of little retrieval
  value, while the entrypoint's maintained order is the only ordering signal that exists and no cap uses it.
- Bytes go to duplicated structure: one `## MEMORY.md (<label>)` heading per layer, plus the pointer list rendered
  twice (the entrypoint's own body and the derived index directly below it).

### Measurement methodology (all numbers machine-local, measured during implementation)

Corpus: workspace memory directory
`.../projects/Users-bytedance-workspace-github.com-dsh-cc` holding 574 `.md` files besides `MEMORY.md`, of which
**571 parse as topics** (3 excluded by `parseMemoryFile`: `ci-merge-ref-stale-fetch-trap.md`,
`memory-merged-placeholder.md`, `preset-composition-mechanics.md`); plus 6 global topics in `/Users/bytedance/.dsh/memory`
→ **577 topics**, identified by `(scope, filename)`. The workspace `MEMORY.md` is at its 25 KB read cap with 69
pointer lines; the global one has 6. The corpus is live (the memory jobs add files), so these are a snapshot, not a
constant.

Both renders were driven by one script over the same parsed states (`.scratch/measure-both.mts`): the pre-change
renderer is the shipped `lib/` of the main checkout with today's shipped budget (fragments + an 8192-byte derived
index); the post-change renderer is this worktree's `renderLayers` with the new defaults (24,576 bytes, 160-byte
descriptions). "Visible" counts distinct `](<file>.md)` targets in the whole section text — what the model can
actually see.

| | whole section | enumeration block | distinct topics visible | `## MEMORY.md (` headings |
|---|---|---|---|---|
| **before** (fragments + 8192 index) | 35,604 B | index 8,075 B (plus 25 KB-capped fragments) | **94** | 2 |
| **after** (one catalog, new defaults) | **25,768 B** | catalog 24,322 B | **94** | **0** |

Net on this corpus: **identical coverage (94 topics) in 9,836 fewer bytes (−27.6%)**, one enumeration instead of two,
and no duplicated heading. The coincidence of the two counts is not a law: today's union is `pointers ∪ index ∪
global pointers`, whose size only happens to land at the catalog's entry budget here — on a corpus of very long names
with one-byte descriptions the fragments can expose more entries than a 24,576 B catalog holds (R2).

Description byte distribution over the corpus: p50 = 225, p75 = 307, p90 = 402, p99 = 599, max = 1,223 — descriptions,
not entries, consume the budget, which is why `description-max-bytes` exists. Trimmed at 160 B the catalog's entry
budget buys 94 entries; untrimmed it buys 53 at the same byte ceiling.

## Goals / Non-goals

Goals:

1. One enumeration of the memory directory per render, one truncation axis, one byte budget.
2. On the captured production corpus at the new defaults: the same 94 visible topics in 25,768 B versus 35,604 B —
   one enumeration, −27.6% bytes. **This is a fixture-scoped regression assertion, not a general theorem** — a corpus
   of very long names with one-byte descriptions can fill today's 200-line fragment cap with more entries than a
   24,576 B catalog holds (see R2).
3. An order that reflects maintained curation: pointers the entrypoint lists come first, in the entrypoint's own
   order, interleaved round-robin across scopes so each partition is fairly ordered; everything else follows
   deterministically by filename. Round-robin is an **ordering** fairness property, not a visibility guarantee: under
   prefix fitting a long entry in the first scope can still consume the budget ahead of a short entry in the last
   one (R14).
4. Discoverability preserved down to a documented floor: section, retrieval guidance and ellipsis line always
   survive; a cap never removes the guidance.

Non-goals:

- No mtime-based or relevance-ranked ordering. `dsh-fs` exposes no mtime (`FsInfo` carries `version`/`type`/`size`
  only; `version` is a branded opaque token that must not be interpreted), so no recency signal is reachable. The
  order is stated as what it is: maintained entrypoint order, then filename order.
- No claim that maintained order equals importance. `upsertPointer` keeps an existing pointer's position and appends
  new ones (`save.ts:86-96`); the dream prompt asks for one line per topic and specifies no ranking
  (`prompts.ts:135`). The order is a **presentation policy** that preserves curation history, not a priority score.
- No change to on-disk formats: `MEMORY.md` keeps its pointer format, `memory_save` keeps upserting it, the dream
  keeps rewriting it. The entrypoint remains the curator artifact and the ordering signal — it stops being injected
  verbatim.
- No change to recall, extraction or pressure paths. `extraction-index.ts` reads `MEMORY.md` from disk with its own
  fs read 〔src:ws:packages/memory/memory-consolidation/src/extraction-index.ts#L60-L64〕; recall scans the directory
  itself; `recall-preselect` parses the entrypoint text from the scan state
  〔src:ws:packages/memory/memory/src/recall-preselect.ts#L97-L104〕. None of them reads the rendered section.
- No change to subagent behavior: `MemorySection.render` still returns `''` for non-top-level agents
  〔src:ws:packages/memory/memory/src/section.ts#L216-L222〕.
- No fix for index-cap pressure: a full `MEMORY.md` still needs the dream. The ellipsis line tells the model the
  catalog is partial.

## Design

### A. Rendered layout (exact)

```
# Memory

You have a persistent, file-based memory system. …

There are two scope levels:
- workspace: …
- global: …
[- team: …]

Each directory keeps its own index and topic files. …

<save guidance, 2 paragraphs>

## Memory index

<entry lines>

## Searching past context

…
```

Rules, all four cases enumerated and mutually exclusive so nothing is guessed:

| observed topics | rendered |
|---|---|
| 0 topics (all layers empty or unscanned) | header block, a single paragraph `(no memories yet)`, **no** `## Memory index`, **no** search block |
| ≥ 1 topic, `truncate: false`, or the catalog fits `max-bytes` | header block, `## Memory index`, blank line, all entry lines, `## Searching past context` block |
| ≥ 1 topic, over budget, **at least one entry fits beside the ellipsis line** | same, with the kept entries and the ellipsis line last inside the catalog block |
| ≥ 1 topic, over budget, **not even one entry fits beside the ellipsis line** (floor) | header block, `## Memory index`, blank line, ellipsis line only, then search block |

Every row retains the header block and the save guidance — the floor row loses enumeration only, never the save
channel.

The third and fourth rows are the two halves of "over budget"; they never both apply. `truncate: false` renders as
the second row regardless of size.

- The header block (`# Memory` … save guidance) is rendered by the **same lines as today** (`section.ts:382-400`),
  including the team scope line when team memory is enabled — no change of wording.
- No `## MEMORY.md (<label>)` heading is rendered anywhere. `MemoryLayer.label` stays in the interface for API
  stability and is marked in its doc comment as no longer rendered.
- The placeholder case renders the literal line `(no memories yet)` in place of the whole catalog block (this
  preserves the always-present-section contract and the memoryless placeholder asserted by
  `section.spec.ts:91`).
- `## Searching past context` keeps its block structure and the `grep -rn "<search term>" <dirs/> --include="*.md"`
  line. Its lead sentence changes from `When a MEMORY.md entry is not enough, …` to `When an index entry is not
  enough, …` — after this change the model reads catalog entries, not the `MEMORY.md` body, so the old wording names
  a surface it can no longer see.

### B. Entry line format (unchanged)

```
- [<escapeLinkText(name)>](<filename>) — <trimmed description> (<scope>)[ [<type>]]
```

Identical in shape to today's `renderCombinedIndex` (`section.ts:417-420`), including the ` [<type>]` suffix only when
`frontmatter.type` is present. What changes is **content**: with `description-max-bytes: 160` any description longer
than that renders truncated, so existing assertions that pin long descriptions must be updated. The line format is
stable; the text is not.

### C. Ordering (total, deterministic, scope-fair)

CANONICAL LAYER ORDER = `workspace`, `team`, `global`, restricted to layers **present in the `layers` argument**
(team only when team memory is enabled). The input array's own order is ignored (`section.ts:378-380,401` already
re-finds layers by scope; this makes that explicit).

**Pass 1 — maintained partition.** For each layer, walk its `state.entrypoint` **raw text** (never
`truncateEntrypointContent`; the scan stores the raw file, `scan.ts:28-29`), top to bottom. For each line:

- Take `firstPointerTarget(line)` (existing export, `index-commit.ts:38-41`) and compare it to same-layer topics'
  `filename` by **exact, case-sensitive string equality**. No basename extraction, no `./`-prefix stripping, no
  directory-prefix stripping, no URI decoding, no Unicode normalization. `./a.md`, `dir/a.md`, `A.MD` do **not**
  match; those topics fall through to pass 2.
- No match → skip the line; do **not** try a second link on the same line.
- A match emits that topic unless its `(scope, filename)` was already emitted from this layer (first occurrence
  wins, so a duplicated target renders once).
- `entrypoint === undefined`, empty, or a layer whose state is `undefined` → that layer's pass-1 list is empty.
  Pointers never promote topics from another layer.

**Interleave (zip-longest).** Emit pass 1 round-robin over the canonical layer list: round *i* = 0, 1, 2, …; for
each layer in canonical order, emit that layer's i-th maintained entry if it exists. A pass ends when its longest
per-layer list is exhausted; an exhausted or empty list contributes nothing and does not shift the other layers'
rounds. Pass 2 restarts at round 0. A longer list is never cut short by a shorter one. If two input layers carry the same scope, only the first is used — today's `renderLayers`
selection behavior, preserved 〔src:ws:packages/memory/memory/src/section.ts#L378-L380〕.

**Pass 2 — remaining topics.** Each layer's topics not emitted in pass 1 are sorted **within that layer** by
`compareFilename(a, b)` = `a.localeCompare(b)` (no locale argument) with `a < b ? -1 : a > b ? 1 : 0` as an exact
tie-break, so the order is total even when the collation returns 0 for distinct strings. The sorted per-layer lists
are then interleaved by the SAME zip as pass 1.

**There is exactly one algorithm.** Layer index is NOT a sort key — the round-robin IS the cross-layer order, so a
topic's scope only decides which round it takes. Do not "improve" this into a global sort by `(filename, layer)`:
that is a different order, and a pass that ends early (zip-shortest) would demote a longer layer's remaining
maintained entries into the tail, breaking "maintained order is preserved". `localeCompare` is called **without a
locale argument** (matching `scan.ts:84` today); the tie-break makes each sort total but does not make collation
identical across hosts with different ICU data. Two topics with the same filename in different scopes are distinct
entries — both render, each with its own scope tag (R12).

### D. Description trimming

Option: `descriptionMaxBytes` (`cc-memory-section.description-max-bytes`, default 160; `0` = trim nothing).

`trimDescription(description, descriptionMaxBytes)`:

1. Return the input unchanged when `descriptionMaxBytes === 0`, or when the description is empty, or when
   `Buffer.byteLength(description, 'utf8') ≤ descriptionMaxBytes`.
2. Otherwise walk the description by **code point** (`for (const char of description)`), accumulating
   `Buffer.byteLength(char, 'utf8')`, and stop before the running total would exceed
   `descriptionMaxBytes - 3` (the `…` U+2026 costs 3 UTF-8 bytes).
3. Append `…`. The result's byte length is therefore ≤ `descriptionMaxBytes` and no multi-byte sequence or surrogate
   pair is ever split.

Trimming runs **before** budget fitting, so it can only increase how many entries fit. It never touches `name`,
`filename`, `scope` or `type`. It is independent of `truncate`: `truncate: false` disables dropping entries, not
trimming (R16).

### E. Budget and floor

`fitCatalog(entries, maxBytes)` — today's algorithm (`section.ts:456-467`) moved to `catalog.ts` unchanged in
semantics:

- The measured object is exactly `['## Memory index', '', ...keptEntries, ...(ellipsis ? [ellipsisLine] : [])].join('\n')`,
  UTF-8 bytes. No trailing newline is added or counted.
- Over budget → drop whole entries from the **bottom** of the interleaved order and append the ellipsis line, keeping
  the largest `kept` that fits. Honest statement of what that preserves: dropping from the bottom removes the last
  round-robin rounds, so what survives is an **early prefix of the interleaved order** — every layer's first
  maintained entries stay, later entries of *every* scope can be dropped, and the pass-2 tail goes first.
- **Floor:** when not even one entry fits beside the ellipsis line, the section renders its header block, then
  `## Memory index`, a blank line, the ellipsis line, then the search block — the same shape as any other row, with
  zero entries.
- Ellipsis copy changes to `… (N more memory topics; grep the memory directory)` — `N` counts entries, and
  "older entries" is dropped because under §C the omitted tail is not an age ordering.
- `truncate: false` → the catalog renders complete (195,921 B of entries on the measured corpus with trimming off;
  141,384 B with the default trim).
- Default `max-bytes` rises 8192 → **24,576**; bounds unchanged (1,024 … 65,536).

### F. Change detection (the fragment cache becomes a fingerprint)

Today `scanDir(dir)` compares the rendered fragment for that directory and emits `system-prompt/change` on
inequality 〔src:ws:packages/memory/memory/src/section.ts#L270-L282〕. Fragments no longer render, and a rendered-text
key is wrong: the same directory can produce the same text under a different catalog order. Worked example (workspace
maintained `[a]`, workspace tail `[b]`, global maintained `[g,h]`): adding a workspace pointer for `b` changes the
rendered catalog from `a,g,h,b` into `a,g,b,h` while the directory's own rendered entries are unchanged as a set.
Scope tags cannot be rendered here either, because `scanDir` knows only the directory path.

Therefore the cached value becomes a **scope-free fingerprint** of that directory's §C-relevant inputs:

```
renderLayerFingerprint(state: MemoryDirectoryState): string
```

built from three joined lines (JSON for each segment, no custom separators):

1. `"P" + JSON.stringify(curatorFilenames)` — pass-1 order for that layer (entrypoint order, deduped, matched only).
2. `"T" + JSON.stringify(tailFilenames)` — pass-2 order for that layer.
3. `"F" + JSON.stringify(sortedTopics)` — every topic sorted by **§C's total filename comparator** (no-locale
   `localeCompare`, then exact `a.filename < b.filename` tie-break), each entry
   `[filename, name, description, type ?? null]` with the **raw, untrimmed** description. The tie-break is
   load-bearing here: two distinct filenames can collate equal (`é.md` vs `e` + U+0301 `.md`), and a locale-only sort
   would let directory enumeration order flip the fingerprint on every scan — an event storm. §C's comparator is
   total, so the fingerprint is stable.

Behavior this pins, all of which must be tested:

- A pointer edit that **reorders or promotes** a topic changes `P`/`T` → event emitted, even when the concatenation
  is unchanged.
- A new topic file that is not yet in `MEMORY.md` changes `T`/`F` → event emitted (today's fragment key ignores
  `topics`, so this is a deliberate improvement, not a regression).
- A description/name/type edit changes `F` → event emitted **even when trimming hides the change from the rendered
  text**. Over-firing is deliberate (an extra reassembly whose text is identical); under-firing would serve a stale
  section.
- A `MEMORY.md` prose edit that touches no pointer → no event. Intended: prose is no longer rendered (R1).
- The equal path still writes `this.states.set(dir, state)` before returning (`section.ts:275-277`) — dropping that
  would leave stale topics in the next render with no event.
- Fingerprints are compared **pre-budget**, exactly as today's fragment key was pre-budget.

### G. Settings namespace `cc-memory-section` (existing namespace, extended)

| key | type | default | bounds | semantics |
|---|---|---|---|---|
| `truncate` | bool | `true` | — | on/off for catalog entry dropping; `false` = complete catalog |
| `max-bytes` | int | **24,576** (was 8192) | 1024 … 65536 | UTF-8 ceiling for the catalog block (`## Memory index` header + entries + ellipsis line) |
| `description-max-bytes` | int | **160** | `0`, or 8 … 1024 | per-entry description ceiling in UTF-8 bytes; `0` disables trimming |

- `description-max-bytes` is schemastery `z.number().step(1)` (its integer check, which also rejects `NaN`) and
  **must not** carry `.min()`/`.max()` — a schema-level lower bound of 8 would reject the legal `0` before validation
  ever runs. The whole domain (`0`, or `8 … 1024`, and therefore the `> 1024` rejection too) is enforced solely in
  `validateMemorySectionSettings`. `1 … 7` is **rejected, never clamped** — that minimum is a **policy bound** (a
  smaller ceiling would render `…` and nothing else, which is noise), not an arithmetic necessity: `…` needs 3 bytes,
  so 3–7 would technically fit.
- Mapping to the internal camelCase shape uses `??`, so a stored `0` is preserved rather than replaced by 160
  (mirroring `section-settings.ts:129-134`).
- Hot reload: `MemorySection.indexBudget()` re-reads the namespace on every render and passes one resolved
  `MemoryCatalogOptions { truncate, maxBytes, descriptionMaxBytes }` into `catalog.ts`. `catalog.ts` never reads
  settings itself — there is exactly one settings source (R15). A settings change does **not** emit
  `system-prompt/change` (R17, accepted).
- Public render helpers: `renderLayers(layers)` with **no** budget keeps its historical contract — no cap and no
  trimming. Every field of a partially specified budget resolves independently, so no caller has to infer defaults:

  | `CombinedIndexBudget` field | omitted resolves to | rationale |
  |---|---|---|
  | `truncate` | `true` (capped) | today's contract: passing a budget opts into capping (`section.ts:77-86`) |
  | `maxBytes` | the settings default (24,576) | unchanged behavior class |
  | `descriptionMaxBytes` | `0` (no trimming) | trimming is new; an old caller must not get new text |

  `renderMemorySection` / `renderTeamMemorySection` pass no budget and therefore render uncapped and untrimmed; only
  the live `MemorySection` supplies the settings-derived options.

### H. File plan (implementation order)

| # | file | change |
|---|---|---|
| 1 | `packages/memory/memory/src/catalog.ts` | **new** (319 lines as implemented): `MEMORY_CATALOG_HEADER`, `renderCatalog(layers, options)`, `fitCatalog`, `trimDescription`, `ellipsisLine`, `renderLayerFingerprint`, `compareFilename`. Moved out of `section.ts` because that file was at 497/500 lines against the source cap and now sits at 422 〔src:ws:scripts/check-file-size.mjs#L33-L33〕 — not cosmetic. |
| 2 | `packages/memory/memory/src/section.ts` | delete `renderLayerFragment`, `renderCombinedIndex`, `fitIndexEntries`, `INDEX_HEADER`, `indexEllipsisLine`; `renderLayers` delegates the catalog to `catalog.ts`; `fragments` map → `fingerprints` fed by `renderLayerFingerprint`; `CombinedIndexBudget` gains `descriptionMaxBytes?`; `indexBudget()` returns the 3-field options; `renderSearch` lead sentence updated (§A); `MemoryLayer.label` doc comment notes it is no longer rendered; header doc comment updated |
| 3 | `packages/memory/memory/src/section-settings.ts` | add `description-max-bytes` (schema, defaults, `MIN/MAX_DESCRIPTION_MAX_BYTES`, discontinuous validation); `maxBytes` default 8192 → 24576; internal shape gains `descriptionMaxBytes`; module doc rewritten (no fragment identity) |
| 4 | `packages/memory/memory/src/index.ts` | export the new catalog symbols; keep every existing export |
| 5 | `packages/memory/memory/src/truncate.ts`, `scan.ts`, `index-commit.ts`, `memory-consolidation/src/prompts.ts` | doc-comment truth-up only: "always-loaded index (injected verbatim)" → "on-disk index (the catalog's ordering source)". No behavior change. |
| 5b | `packages/memory/memory/src/save.ts` | ONE user-facing sentence: the fail-open over-cap warning claims "tail entries are invisible until consolidation compacts it". Under §C the catalog enumerates parsed topic files directly and raw over-cap pointers still order it, so "invisible" is false in both directions. Reword that clause to say the index should still be compacted; leave every other word and the pressure arming untouched. |
| 5c | `packages/memory/memory/tests/save.spec.ts` | the one assertion pinning that clause. |
| 6 | `packages/memory/memory/README.md`, `README.zh.md`, `README.i18n.yaml` | §"System-prompt section" rewritten (one catalog, no fragments, maintained-then-filename order, round-robin scope fairness, trimming, floor, the `(no memories yet)` case); settings table gains `description-max-bytes` + the new default; API section updated for the budget-less default; **"Upgrading" note** for a user who set `max-bytes: 8192`; every "always-loaded MEMORY.md" sentence fixed (the phrase itself is only at `README.md:14`; `:40` is the fragment-cache description, `:242` the token-growth paragraph and `:255-257` the API's budget paragraph — all three describe behavior this change alters and are updated) |
| 7 | tests | `tests/section.spec.ts` (drop fragment assertions; **three fixtures change semantics and are named explicitly** — `:73-84` seeds a topic file with no `MEMORY.md` and asserts `(no memories yet)`, which now renders the catalog entry instead; `:198-216` seeds ONLY `MEMORY.md` and treats a pointer-text edit as a change, which is now the R1c prose case and emits nothing, so it must be reseeded with real topic files; `:80`/`:91` are the placeholder/heading anchors; assert one `## Memory index`, zero `## MEMORY.md (`), `tests/section-index-budget.spec.ts` (semantics → catalog budget; floor fixtures set `description-max-bytes: 0`; drop "fragments byte-identical" cases; **the ellipsis copy is asserted in 5 places today** — `:66,:113,:179,:185` here and `tests/section.spec.ts:321` — all must move to the new wording), `tests/section-settings.spec.ts` (exists already: update the default, the three-field resolved shape, add discontinuous-domain rejection and `0`-preserved cases), `tests/team.spec.ts` (team topic renders `(team)`; pointer/topic mismatch fixture), **new** `tests/catalog.spec.ts` (ordering, round-robin interleave, dedupe, exact-match miss cases, trimming incl. Han/emoji/exact-fit, `description-max-bytes: 0`, floor, `truncate: false`, placeholder, fingerprint promotion/demotion/deletion, property `bytes ≤ max-bytes`) |
| 8 | `docs/claude-code-capabilities.yaml` | **both** rows: `settings.memory-section-budget` (title, deviation text — no "per-layer fragments render byte-identical", new default 24,576, the new key, maintained-then-filename order, floor; evidence anchor `fitIndexEntries` → `catalog.ts` `fitCatalog`) **and** `memory.core` (behavioral deviation: catalog instead of verbatim `MEMORY.md` body; evidence gains `catalog.ts` + `tests/catalog.spec.ts`) |
| 9 | `docs/plans/2026-11-12-selective-system-prompt-sections.md` | Status line: §A superseded by this doc (one line, no body rewrite) |
| 10 | generated | `pnpm docs:parity` → `docs/cc-parity-matrix.md`, `docs/claude-code-capabilities.json`, README parity block; `node scripts/check-readme.mjs --write` |

## Risks and how each one is closed

| # | risk | closure |
|---|---|---|
| R1 | **Information that only the fragment carried disappears from the prompt**: (a) non-pointer `MEMORY.md` prose; (b) pointers whose target has no parseable topic (dangling, or a file that fails `parseMemoryFile`); (c) pointer lines whose name/description differ from the topic's YAML frontmatter; (d) `MEMORY.md` is excluded from topics (`scan.ts:66-68`), so its own text is never a topic. | Accepted and stated in README: the catalog enumerates *parsed topics* only, in frontmatter form; recovery is an explicit read of `MEMORY.md` or a grep. Recall covers topics only (and team topics sit outside the workspace/global recall pool), so the doc does not claim recall recovers entrypoint-only text. Tests pin (b) and (c) as documented behavior so no one "fixes" it by accident. |
| R2 | **Coverage regression on other corpora.** Today's union can exceed a 24,576 B catalog: e.g. 150 topics with long names and 1-byte descriptions produce 150 short pointer lines inside the 200-line/25 KB fragment cap, while the catalog fits ~103. | The "at least as good" claim is **removed as a general guarantee**; Goal 2 and the regression test are explicitly fixture-scoped (the captured corpus + a checked-in smaller fixture). README states the trade: one authoritative enumerated view, capped by bytes, versus two partial views. Arbitrary corpora may render fewer entries. |
| R3 | **A user-set `max-bytes: 8192` now caps a much larger surface**: they keep 8192 → ~32 entries on the measured corpus, far below today's 87-topic union. | Documented as an explicit "Upgrading" note with the recommended value and the arithmetic; `truncate: false` and `description-max-bytes` remain the valves. No PR rewrites user-layer settings. |
| R4 | **Ordering claim inflation** (calling the tail recency-ranked, or calling maintained order "priority"). | Doc, README and the settings table say: maintained entrypoint order (insertion-preserving, not importance-ranked), then `localeCompare` by filename with an exact tie-break, then layer index. R14 covers fairness. No recency claim anywhere. |
| R5 | **`section.ts` hits the 500-line cap** while growing helpers. | §H moves the catalog renderer to `catalog.ts`; `section.ts` shrinks. `pnpm check:size` is in the local battery. |
| R6 | **`system-prompt/change` misses a real change or never fires** (the old key was the fragment). | §F defines the fingerprint, including the promotion/demotion case, the new-unindexed-topic case, the trimmed-away-description-edit case and the equal-path state write. Tests: promotion, demotion, new topic, frontmatter edit, prose-only edit (no event), identical rescan (no event). |
| R7 | **First assembly renders an empty catalog** while scans are in flight. | Unchanged readiness path (`READINESS_BUDGET_MS` 500, `section.ts:158-179`) re-renders with the same catalog function; test asserts the post-refresh assembly carries entries. |
| R8 | **UTF-8 corruption when trimming CJK/emoji descriptions.** | §D walks code points and measures bytes; tests cover Han, emoji (surrogate pairs), an exactly-at-limit description (unchanged), and `0`. |
| R9 | **Team layer silently dropped.** | The catalog path is shared by `renderTeamMemorySection`; test asserts a team topic renders with `(team)` and that round-robin gives it a slot. |
| R10 | **Subagents start receiving the catalog.** | Unchanged `isTopLevel` mute (`section.ts:216-222`); test asserts `''` for a child. |
| R11 | **Recall / extraction / pressure accidentally coupled to the rendered section.** | Verified independent (`extraction-index.ts:60` disk read; `recall-preselect.ts:95-104` entrypoint parse; recall scans the directory). No file in those paths is touched. |
| R12 | **Duplicate filenames across scopes.** | Entries are keyed `(scope, filename)`; both render with their own scope tags. Pinned by a test. |
| R13 | **Capability-evidence CI goes red** because I10 in the manifest library checks that each evidence anchor is a literal substring (`content.includes(anchor)`) of the named file 〔src:ws:scripts/check-capability-evidence.test.mjs#L342-L347〕, and `settings.memory-section-budget` anchors `fitIndexEntries` in `section.ts` 〔src:ws:docs/claude-code-capabilities.yaml#L3858-L3873〕 while its deviation text promises fragment behavior. | §H8 rewrites **both** capability rows and re-anchors the evidence to `catalog.ts`, then regenerates all three parity artifacts (`generate-parity-matrix.mjs` writes the matrix, the README block and the JSON 〔src:ws:scripts/generate-parity-matrix.mjs#L354-L356〕). |
| R14 | **Scope starvation**: workspace-first ordering could exhaust the budget before any team/global entry appears (on the measured corpus the workspace's 67 maintained entries nearly fill 24,576 B). | §C interleaves round-robin across the canonical layer order in **both** passes, so every layer's maintained entries are interleaved before any layer's tail. What this does **not** promise, stated so nobody relies on it: no per-scope visibility guarantee. Fitting drops a prefix-truncated suffix, so an oversized early entry can still push the floor before a short later-scope entry appears; each pass also ends when its longest per-layer list is exhausted. Pinned by a lopsided-corpus test asserting the interleaving, not a per-scope minimum count. |
| R15 | **Two settings sources / divergent public paths** (budget object vs live settings vs `catalog.ts` defaults). | One source: `MemorySection.indexBudget()`; `catalog.ts` takes a resolved options object. Public budget-less calls resolve to `{ truncate: false, descriptionMaxBytes: 0 }`, documented in README and tested. |
| R16 | **`truncate: false` silently also un-trims** (or vice versa). | §G/§D state the two are independent; tests assert `truncate:false` + default trim renders trimmed-but-complete, and `description-max-bytes: 0` + default truncate renders long descriptions within budget. |
| R17 | **A settings write does not reassemble the prompt** (no `system-prompt/change` on settings change), so a host that reassembles only on that event keeps the stale section until the next disk change. | Pre-existing (same for `max-bytes` today) and stated as an accepted non-goal in §G with a README sentence: a settings change takes effect on the next assembly (next turn / next disk change / new session). |
| R18 | **The maintenance contract silently changes for `MEMORY.md` authors**: the file is no longer prompt-visible, so prose edits there have no prompt effect. | §F states the prose-only case emits no event; README §"System-prompt section" says `MEMORY.md` is now the catalog's ordering source and the on-disk index, not injected text. |

## Verification

Behavior under test, how it is driven, and what counts as pass. Runner: `pnpm exec vitest run packages/memory/memory/tests`
(the package declares **no** `scripts`, so `pnpm --filter @dsh-cc/memory test` does not exist; root `test` is
`vitest run`).

1. **Render shape** — `renderLayers` / `renderMemorySection` over `FakeMemoryFs` states. Pass: exactly one
   `## Memory index`; zero `## MEMORY.md ` occurrences; the header block (`# Memory` through the save guidance,
   i.e. `section.ts:382-400`) equals a **golden snapshot of that header only** captured from the pre-change renderer
   — no fragment text is in the snapshot; the search block equals its pre-change snapshot **after applying the §A
   lead-sentence replacement** (the one deliberate wording change); the placeholder case renders `(no memories yet)`
   and neither the heading nor the search block.
2. **Ordering** — fixtures whose entrypoint order differs from filename order, plus a lopsided multi-scope fixture.
   Pass: maintained partition in entrypoint order, round-robin across scopes, dedupe first-wins, tail by
   `localeCompare` then layer index then exact tie-break.
3. **Matching rule** — fixtures with `./a.md`, `dir/a.md`, `A.MD`, a dangling pointer, a pointer naming a topic of
   another layer, and a duplicated pointer. Pass: only the exact same-layer match promotes; every other topic lands
   in the tail; no cross-layer promotion.
4. **Trimming** — ASCII, Han, emoji, exactly-at-limit, empty, and `0`. Pass: result bytes ≤ `descriptionMaxBytes`,
   ends with `…` only when text was dropped, no split surrogate pair, byte-identical at `0`.
5. **Budget + floor** — random corpora, measuring the exact array `['## Memory index', '', ...kept, ?ellipsis].join('\n')`.
   Pass: bytes ≤ `max-bytes` or the floor form (heading + ellipsis, no entries). Floor fixtures set
   `description-max-bytes: 0` (default trimming would otherwise shrink the oversized description below the budget and
   never reach the floor).
6. **Fingerprint / change events** — scan, then: reorder a pointer; add an unindexed topic; edit a topic's
   frontmatter; **delete a topic file**; edit prose only; rescan unchanged. Pass: one event for the first four, none
   for the last two, and the equal path still publishes the new state.
7. **Integration** — a mounted `MemorySection` on a real `Context` + `SystemPrompt`: assembled section on first
   render, after the readiness refresh, and after `system-prompt/change`.
8. **Real-corpus measurement** (not a CI unit test) — after `pnpm run build`, run one script that renders the
   production memory directory through **both** the pre-change and post-change renderers from the same parsed
   corpus, and report: whole-section bytes for each, catalog-block bytes, entries visible for each (identified by
   `(scope, filename)`), and the exact settings used. PR body carries those numbers; the script lives in
   `.scratch/`, not in the repo.

Acceptance: (1)–(7) green via the command above; (8) reported in the PR body; `pnpm check:size`,
`pnpm check:readme`, `pnpm check:capabilities`, `pnpm check:parity`, `pnpm check:spec-deps` green.

## Rollout

Ships **ON** (no settings change needed). Restore valves, in increasing bluntness: raise
`cc-memory-section.max-bytes`; set `description-max-bytes: 0`; set `truncate: false`.

## Fold ledger

### r1 → v2 (three lanes, blind; critic GO-WITH-CHANGES, grok NO-GO 1B/8M/3m, codex NO-GO 4B/7M/1m)

BLOCKERS folded:

- **Change-detection suppression** (grok): rendered-text-per-directory cannot see a cross-layer promotion
  (`a,g,b` → `a,b,g`). Fixed by §F's fingerprint (ordered maintained partition + ordered tail + per-topic fields).
- **Entrypoint-only edits stop emitting; `scanDir` has no scope** (codex): the fragment key was the truncated
  entrypoint body. The fingerprint is scope-free by construction (it is not rendered text), so `scanDir`'s missing
  scope stops being a problem; the three behavior changes (prose edits silent, new unindexed topic now emits, equal
  path must still publish state) are stated in §F and tested in Verification 6.
- **Coverage guarantee false for valid corpora** (codex, also critic #5): Goal 2 and R2 rewritten as fixture-scoped;
  the 150-long-name counterexample is stated. Property test restricted to the bound.
- **Capability row not updated → CI red** (codex, grok, critic): §H8 now updates **both** rows, re-anchors the
  `fitIndexEntries` evidence to `catalog.ts`, and §H10 regenerates all three artifacts. Verified against
  `docs/claude-code-capabilities.yaml:3843-3873` and `scripts/check-capability-evidence.mjs`.

MAJOR/MINOR folded:

- Pointer matching rule pinned everywhere (exact, case-sensitive, no normalization, no second link, raw entrypoint
  not the truncated one) — all three lanes.
- `localeCompare` without a locale, plus an exact final tie-break for collation ties (codex #7, grok #11).
- Public/budget-less defaults and the single settings source (critic #4, grok #5, codex #6) → R15, §G.
- `description-max-bytes` / `truncate` independence (R16), `0` preserved via `??`, `1…7` rejected with the correct
  reason (grok #12: only 1–2 cannot hold `…`; 8 is a policy bound).
- Floor fixtures defeated by default trimming (grok #9, codex #9) → Verification 5.
- Property-test measurement surface = the exact capped array (grok #10).
- Wrong acceptance command; build before measuring (codex #5) → Verification preamble + (8).
- Information-loss surface widened to dangling pointers, invalid topics, pointer-vs-frontmatter divergence, team
  topics outside recall (codex #4, grok) → R1.
- Scope starvation (grok #11) → round-robin interleaving in §C + R14.
- "Curator priority" overclaim (grok #11, critic) → "maintained order is a presentation policy" in Non-goals and R4.
- Formal-design clause that contradicted §F, and the "complete decision procedure" overclaim (codex #10, grok #12).
- Stale copy: search lead sentence (critic #6, codex #10) and the ellipsis "older entries" wording (critic #6).
- Doc-comment truth-up list (critic #9, grok #12) → §H5, §H6.
- Placement/placeholder contradiction in the layout diagram (critic #7) → §A four-case table.
- "Existing per-entry assertions stay valid" (critic #8) → §B format-vs-content distinction.
- Verification 1 unsatisfiable as a whole-string check (critic #11, codex #12) → golden-snapshot prefix/suffix split.
- Missing `tests/section-settings.spec.ts` (codex #9, grok #8) → §H7.
- Settings change emits no event (critic #10) → R17, accepted and documented.
- Measurement hygiene: exact settings, catalog-vs-section surfaces, `(scope, filename)` identity, physical vs parsed
  file counts, and the untrimmed-vs-trimmed `truncate:false` number (all three lanes) → §Measurement + §E.

### r2 delta → v3 (critic GO-WITH-CHANGES with all 16 folds verified CLOSED; codex GO-WITH-CHANGES, #11 PARTIAL)

Folded:

- **Four-case table not exclusive; floor row dropped the header** (critic #1, codex #2): §A rows now split "over
  budget with ≥ 1 entry kept" from "floor", `truncate: false` is explicitly the fits row, and every row states that the
  header block and save guidance survive.
- **Pass-2 sort was written per layer** (critic #2): §C now sorts one merged list, then interleaves.
- **Fingerprint `F` sort comparator unpinned / unstable for collation-equal filenames** (critic #3, codex #3): §F pins
  §C's total comparator and states why (an unstable `F` sort would emit on every scan for `é.md`-class names).
- **Partial budget defaults** (critic #4): §G now has the resolved-defaults table (`truncate` ⇒ capped, `maxBytes` ⇒
  settings default, `descriptionMaxBytes` ⇒ 0).
- **Schema trap on the legal `0`** (critic #5): §G forbids `.min()/.max()` on `description-max-bytes`; the whole
  domain lives in `validateMemorySectionSettings`.
- **Deletion case missing from event tests** (critic #6): Verification 6 adds topic deletion.
- **Prefix-fit overstatement** (critic #7): §E now says bottom-dropping keeps an early prefix of the interleaved
  order, so later entries of *every* scope can be dropped.
- **Golden-snapshot acceptance contradicted the intended edits** (codex #1): Verification 1 snapshots the fixed header
  only and compares the search block after the approved lead-sentence replacement.
- **Scope-fairness overpromise** (codex #4, #11 PARTIAL): Goal 3 and R14 now claim ordering fairness within each
  partition and explicitly **deny** a per-scope visibility guarantee under prefix fitting.
- **Stale promotion example** (codex #5): §F's worked example is now workspace maintained `[a]` + tail `[b]` + global
  `[g,h]`, `a,g,h,b` → `a,g,b,h`.
- Ambiguities folded into §C/§F: duplicate-scope inputs keep only the first layer (today's behavior); a pass ends when
  its longest per-layer list is exhausted and pass 2 restarts at round 0; fingerprint completeness assumes unchanged
  layer bindings and render options (settings changes are R17).
- Evidence markers 〔src:ws:…〕 backfilled for every load-bearing code claim (16 distinct anchors, all resolving
  inside the workspace).

### r2 delta → v3b (grok NO-GO: 1 BLOCKER + 3 MAJOR + 1 MINOR, all folded)

- **BLOCKER — pass 2 was two different algorithms at once** (per-layer sort + zip versus a global
  `(filename, layer)` sort, with zip-shortest/-longest unstated). §C now states ONE algorithm: per-layer
  `compareFilename` sort, then zip-longest; layer index is explicitly not a sort key; a longer list is never cut
  short. The implementation (`catalog.ts` `interleave`) always was this one — the doc was the defect.
- **Floor specified three ways** (table vs §E vs Verification): unified — header block, `## Memory index`, blank line,
  ellipsis, search block; zero entries.
- **`description-max-bytes: 0` would die if the schema copied `max-bytes`' `.min()` pattern**: §G already forbids
  `.min()/.max()` on that key and states the whole domain lives in the validator; the implementation follows.
- **H7 did not retarget the fixtures the new semantics break**: `section.spec.ts:73-84`, `:198-216` and
  `save.spec.ts:318` are now named in §H7/§H5c.
- **The save warning became false**: raw over-cap pointers still order the catalog and parsed topics are listed
  regardless, so §H5b rewords that one clause (and §H5c the assertion).
- **Wrong current-code anchors**: `section.spec.ts:80` (placeholder) vs `:91` (heading); the literal-substring check
  lives in the manifest library (I10), not the CLI wrapper; `docs:parity` rewrites the matrix, the JSON and the
  README block but never the YAML row; the README phrase cite is `:14` with three adjacent behavior paragraphs.
- **Ordering claims converge**: §C's single algorithm, Goal 3 and R4 now describe the same order (maintained →
  zip-longest; tail → per-layer filename sort → zip-longest), with round-robin as ordering fairness only.

