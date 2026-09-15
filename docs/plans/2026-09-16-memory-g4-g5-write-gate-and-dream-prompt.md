# Memory Write-Side Index Gate (G4) and Consolidation Prompt Quality (G5)

**Status:** **Revised r2** — critic cold review 2026-09-16 round 1 (F1–F9:
composition-point fix, counting semantics, global-scope deadlock mitigation,
consolidation fallback, test gaps) and round 2 (banner-headroom arithmetic,
fail-open mechanism flag, byte-accurate truncation slicing) incorporated.
**Date:** 2026-09-16
**Worktree:** `.claude/worktrees/memory-enhancement` (branch `worktree-memory-enhancement`)

## 1. Context

Claude Code's auto-memory enforces its `MEMORY.md` index read limit (200 lines /
25 KB — entries past the limit are silently dropped on every load) on the WRITE
side: a write that leaves the index over the limit errors in-session and forces
a rewrite under 140 lines. dsh-cc currently enforces the limit only on the READ
side (`truncate.ts` truncates with a warning banner), so a `memory_save` or a
consolidation fork can push the index over the boundary and the tail entries
become permanently invisible — a silent-loss gap.

Claude Code's AutoDream pipeline also carries a sharper consolidation workflow
than dsh-cc's current prompt: convert relative dates to absolute, resolve
contradictions, verify drifted facts against the codebase, and — critically —
avoid exhaustively reading session transcripts. dsh-cc's
`buildConsolidationPrompt` is a single generic "rewrite concisely" instruction.

This PR delivers both: a write-side hard gate on the index (G4) and a
workflow-quality rewrite of the consolidation prompt (G5).

## 2. G4 — write-side index hard gate

### 2.1 Invariant and the REAL composition points

**A batch that would leave `MEMORY.md` over 200 lines or 25 000 bytes is
rejected wholesale, with an actionable error naming the remediation.**

Critic finding F1 (blocking): `save.ts` today validates ONLY the topic file —
it pushes the upserted `MEMORY.md` write onto the array AFTER
`validateMemoryWrites` returns, so a gate inside `validateMemoryWrites` alone
would leave the primary write path ungated. The fix is a required restructure:

- `save.ts` execute: **move the entrypoint `fs.readText` above the
  `validateMemoryWrites` call**, then assemble BOTH writes (topic file AND the
  upserted entrypoint content) into `writes` BEFORE the call, so the gate
  sees the resulting index. The fail-open policy (§2.3) is carried by a new
  options parameter: `validateMemoryWrites(input, { allowOverLimitEntrypoint
  })` — default strict (forks unaffected); `save.ts` computes push-over vs
  pre-existing from the pre-save index content it already holds and passes
  the flag only in the pre-existing case (round-2 F2).
- Consolidation/extraction forks (`memory-consolidation/src/index.ts`
  `startMemoryJob` done handler): already pass the full reported file set
  through `validateMemoryWrites` — the gate composes here for free (no flag).

### 2.2 Exact change

In `writeback.ts` `validateMemoryWrites`, after per-file checks pass, add:

- If a write's `path` is `MEMORY.md`: measure the content — **trim, then
  count lines by splitting on `\n`, bytes by `Buffer.byteLength` of the
  trimmed content** (F2: `upsertPointer` always emits a trailing newline;
  an untrimmed split counts N entries as N+1 lines and false-rejects normal
  saves; trim matches `truncateEntrypointContent` semantics).
- If lines > 200 or bytes > 25 000 → throw the whole-batch-style error with
  an actionable message: target under 140 lines, one line per entry, move
  detail into topic files, merge or drop stale entries; for `memory_save`
  callers the message also names the immediately executable remediation
  (see §2.3).

Reuse `MAX_ENTRYPOINT_LINES` / `MAX_ENTRYPOINT_BYTES` from `truncate.ts`
(import, never re-declare). **F3 (round 2, completed): make
`truncateEntrypointContent` byte-accurate everywhere** — both the reported
`byteCount` AND the truncation slicing/comparisons must use
`Buffer.byteLength`, not `trimmed.length` UTF-16 code units. Byte-accurate
slicing: accumulate whole lines while the running UTF-8 byte total stays
within the cap (≤ 200 lines, byte budget 25 000) — never slice mid-character.
Read-side this was cosmetic; the consolidation fallback (§2.4) now feeds this
function's output into the hard gate, so code-unit arithmetic would
deterministically violate it.

### 2.3 Failure policy — scope-aware, no deadlock

The model has NO direct write channel to memory dirs; `memory_save` only
upserts one pointer line, it cannot compact an index. So blanket rejection
creates the deadlock the critic identified (F4):

1. **Push-over rejection**: if the index was WITHIN limits before the save
   and this upsert pushes it over → reject with remediation: "the
   workspace/global index is at its cap; overwrite an existing memory (same
   name) to update it without growing the index, or save with
   `scope: 'workspace'` if this is not genuinely cross-workspace; a
   consolidation run will compact the index." Overwriting an existing topic
   does not add a line, so a capped index still accepts updates — the
   degradation is additions-blocked, updates-allowed, not a hard lock.
2. **Pre-existing over-limit index** (legacy, or global dir with no dream
   coverage): the save did not cause the overflow → **fail-open**: write the
   batch, return a warning in the result message ("index was already over
   its 200-line/25 KB cap before this save; tail entries are invisible until
   consolidation compacts it"). Rejecting here would brick every save
   against an already-broken index with no repair path.
3. **Global dir caveat, documented**: dream/extraction only write the
   turning agent's repo dir (`resolveWorkspaceMemoryDir`); the global
   (home-root) index has no fork that rewrites it. The fail-open rule (2)
   plus the updates-allowed rule (1) keep it usable; full global-dir dream
   coverage is out of scope (recorded in §6).

### 2.4 Consolidation-path fallback (F5: no livelock)

If the fork's reported file set has an over-limit `MEMORY.md`, a plain
rejection would fail the dream job, roll back the lock, and retry every
turn-end forever — each retry burning a full fork run for zero durable
output (a weak model may just keep ignoring the 140-line target; the fork
never sees the error text).

Fallback in `startMemoryJob`'s done handler, BEFORE `validateMemoryWrites`:
if the reported `MEMORY.md` content is over-limit, replace its content with
`truncateEntrypointContent(content).content`, then validate and write the
batch as normal.

**Round-2 F1 (banner headroom): the truncation output must SATISFY the
gate.** `truncateEntrypointContent` today slices to exactly 200 lines /
25 000 bytes and then APPENDS a warning banner — trim→split of that output
counts ~202 lines and can exceed the byte cap, so the fallback would throw
every time a cap fires and the livelock returns (arithmetic-certain).
Therefore `truncateEntrypointContent` gains headroom: line cap becomes
`MAX_ENTRYPOINT_LINES - 2` (198) and byte cap `MAX_ENTRYPOINT_BYTES - 256`
(24 744) for the truncated body, so body + banner is always within the gate.
Read side loses 2 lines of visible capacity — negligible; write side gains
the invariant "truncation output always validates". This is pinned by a test
(round-2 F4): a 500-line CJK index → fallback output →
`validateMemoryWrites` passes.

The banner makes the overflow visible to the fork and the model on the next
read (unlike read-side silent dropping); topic-file improvements from the
run are preserved; the run completes instead of looping (no lock rollback —
the `completed` branch never rolls back). The gate's forcing function for
forks lives in the prompt (140-line target, G5 phase 5), not in the rejection.

Extraction path: same treatment via the shared done handler.

### 2.5 Counting/limit constants table

| Constant | Value | Source |
|---|---|---|
| lines | > 200 rejects | `MAX_ENTRYPOINT_LINES` (truncate.ts) |
| bytes | > 25 000 rejects, UTF-8 | `MAX_ENTRYPOINT_BYTES` (truncate.ts) |
| semantics | trim → split('\n') → count; byteLength(trimmed) | mirrors truncate.ts (post-F3 fix) |

### 2.6 Tests

`writeback.spec.ts`:
- `MEMORY.md` write at exactly 200 lines / 25 000 bytes passes.
- 201 lines rejects with the remediation message (assert `140 lines`,
  `merge or drop`).
- Over 25 000 bytes (≤ 200 lines) rejects.
- Content with a trailing newline counts as its trimmed line count
  (200 entries + trailing `\n` passes — the F2 off-by-one regression test).
- Non-entrypoint `.md` file of 201 lines passes (gate is index-only).
- CJK content: 24 999 UTF-8 bytes but > 25 000 UTF-16-length chars passes
  (F3 regression — bytes, not code units).

`save.spec.ts`:
- Save whose upsert pushes a 200-line index to 201 lines rejects with the
  remediation message; nothing written (fs seam records no writes).
- Save against an ALREADY over-limit index fail-opens: batch written,
  result message carries the warning.
- Save that overwrites an existing topic on a 200-line index succeeds
  (update-without-growth).
- Both scopes (workspace + global) covered for the push-over rejection.

`memory-consolidation/tests/turn-stopping.spec.ts` (or a new focused spec):
- Reported batch with an over-limit `MEMORY.md` → fallback truncation
  applied, batch written, job completes (not `failed`), lock NOT rolled
  back.
- Determination of which existing spec file hosts this follows the
  existing structure; if the done handler is not reachable from
  turn-stopping harness, a unit-level test on the extracted
  fallback function is acceptable (extract it as a small pure helper).

`truncate.spec.ts`:
- byteCount now UTF-8 (CJK multibyte case).
- Round-2 F1 headroom invariant: `truncateEntrypointContent` output for a
  500-line (and CJK byte-heavy) index passes `validateMemoryWrites` — body
  (198 lines / ≤ 24 744 bytes) + banner ≤ the 200 line / 25 000 byte gate.
- Round-2 F3: byte truncation cuts on a line boundary, never mid-character
  (a CJK body whose byte-accurate cut would split a code point stays intact
  at the previous line).

## 3. G5 — consolidation prompt workflow quality

### 3.1 Rewrite of `buildConsolidationPrompt` (`memory-consolidation/src/prompts.ts`)

Keep the existing skeleton (memory-dir layout explanation, structured-output
contract, tool allow-list, session list). Replace the generic "rewrite
concisely" lines with an explicit ordered workflow, adapted from Claude
Code's AutoDream four-phase pattern to dsh-cc's readable surface:

1. **Orient**: list the memory directory, read `MEMORY.md` and the topic
   files it points at — the primary review material (plain Markdown,
   always readable).
2. **Verify against reality (drift check)**: your working directory is the
   session's workspace — before keeping a load-bearing fact, check it
   against the current codebase (paths, commands, behavior) with
   `read`/`grep`/`glob`. Fix the wrong side of any contradiction between
   two memories; delete facts that reference things that no longer exist.
   (F6: the prompt must NAME the workspace as the fork's cwd — the prompt
   previously only named the memory dir and transcript dir.)
3. **Normalize dates**: convert every relative date ("yesterday", "last
   week") to the absolute date it referred to.
4. **Search transcripts narrowly**: do NOT exhaustively read the session
   transcripts — grep them only for things already suspected important
   (symbols, paths, error strings surfaced by the memory files).
5. **Prune and index**: rewrite `MEMORY.md` as one line per topic, target
   under 140 lines (over 200 lines / 25 KB is rejected host-side, so stay
   well under), move detail into topic files, keep still-true load-bearing
   facts.

One line per phase — the prompt is a model-facing contract re-sent every
dream run.

### 3.2 Extraction prompt — no change

`buildExtractionPrompt` reviews model-visible messages already in the fork's
context; none of the five phases apply.

### 3.3 Tests

`prompts.spec.ts`: extend `buildConsolidationPrompt` assertions with the new
invariants (distinctive substrings): absolute-date instruction,
contradiction/drift instruction naming the workspace, "do not exhaustively
read" narrow-search instruction, the 140-line target. Existing assertions
(tool allow-list, structured-output contract, session list) stay green.

## 4. Files touched

| File | Change |
|---|---|
| `packages/memory/memory/src/writeback.ts` | G4 gate in `validateMemoryWrites` |
| `packages/memory/memory/src/save.ts` | restructure: validate topic + upserted index together; scope-aware reject/fail-open policy (§2.3) |
| `packages/memory/memory/src/truncate.ts` | F3: `byteCount` → `Buffer.byteLength` |
| `packages/memory/memory-consolidation/src/index.ts` | F5: over-limit fallback (truncate-then-write) in the shared done handler |
| `packages/memory/memory-consolidation/src/prompts.ts` | G5 prompt rewrite |
| spec files | `memory/tests/writeback.spec.ts`, `save.spec.ts`, `truncate.spec.ts`; `memory-consolidation/tests/prompts.spec.ts`, + fallback test |

No settings/permission/preset/hook surface changes: `memory_save` and the
consolidation plugin are dsh-cc-native. `pnpm check:capabilities` /
`check:parity` run to confirm no drift.

## 5. Verification plan

1. `node_modules/.bin/vitest run packages/memory` from the repo root.
2. `node_modules/.bin/tsc -b tsconfig.packages.json` (CI-identical).
3. `node scripts/check-spec-deps.mjs` (no new cross-package imports —
   writeback→truncate is intra-package, cycle-free).
4. `pnpm check:capabilities && pnpm check:parity` (expect no-op).
5. G4 smoke: scripted `validateMemoryWrites` call with a 201-line
   `MEMORY.md` throws; with 200 passes.

## 6. Out of scope / non-goals

- `/dream` manual command, dream observability, settings exposure (G1–G3).
- Daily-log append stream (G6).
- Shared `ENTRYPOINT_NAME` constant extraction across packages.
- Dream coverage for the GLOBAL (home-root) memory dir (today dream/extraction
  write only the turning agent's repo dir; the global index relies on §2.3
  rules 1–2 to stay usable). Recorded as a follow-up candidate.
- Team-layer index gating (reuses the same functions; behavior follows).
