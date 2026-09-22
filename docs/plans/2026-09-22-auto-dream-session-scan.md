# Auto-dream never fires: drop the `sessions` service dependency, scan the session store

**Status:** **Planned** — amended after critic cold review round 1 (2026-09-22:
blocker #1 prefix reads impossible via the fs seam → scanner reads via
`node:fs` directly; blocker #2 v3 header contract pinned against a real
stream; major #3 memo must cache the unfiltered list; major #4/#5 dogfood
gate and scan-stats logging; minor #6–#10 incorporated).
**Date:** 2026-09-22
**Worktree:** `.claude/worktrees/auto-dream-debug` (branch `worktree-auto-dream-debug`)

## 1. Context

`@dsh-cc/memory-consolidation` mounts a turn-end listener that fires per-turn
extraction forks (gateless) and, when its gates pass, a consolidation ("dream")
fork that rewrites the workspace memory directory. Production forensics on
2026-09-22 show the dream has never executed once — and the new pressure
trigger from PR #102 inherits the same dead input:

- `.consolidation-lock` / `.consolidation-needed` have never existed in any
  memory directory under `$DSH_HOME/memory`. Lock acquisition is the first step
  after the gates, and both success and failure leave the file on disk
  (rollback is a tombstone write), so zero files means zero attempts ever
  reached the gates' far side.
- The session projection cache holds 132 `extract-memories` fork sessions and
  zero `memory-consolidation` fork sessions. The turn-stopping listener, the
  jobs seam, and the `fork` subagent provider all work in production; only the
  gated path is dead.

Root causes, per the diagnosis session (all silent):

- **R1 — gate deadlock.** `runDream → listNewSessions` reads
  `ctx.get('sessions')`. No `sessions` service provider exists in the cc-tui
  runtime: the tui profile mounts exactly four bundles (`@deepseek-ai/dsh-base`
  plus the three dsh-cc bundles), and their 172-package dependency closure
  contains no `session-controller`/`dsh-session`. The only known providers are
  the web-client stack (`ClientSessions`) and test-support. The lookup returns
  `undefined`, `listNewSessions` returns `[]`, `sessionCount` is permanently 0,
  and the `minSessions` gate (default 5) can never pass. Even if a provider
  were mounted, the code calls `sessions.list()` as a synchronous method
  returning entries with `session.header.*`, while `ClientSessions.list` is an
  `ObservableSnapshot<SessionListState>` *property* — the call would throw
  `TypeError`, swallowed by the dispatcher's `.catch(() => {})`. Same outcome,
  same silence.
- **R2 — pressure path inherits R1.** PR #102's forced-dream path correctly
  bypasses the time/count gates, but the prompt's session list still comes
  from `listNewSessions()`, so a forced dream would run with an empty input
  list — and on a legal-but-empty write batch it *succeeds* and tombstones the
  pressure marker, silently consuming the only signal.
- **R3 — transcript pointer is doubly wrong.** `buildConsolidationPrompt`
  receives `sessionTranscriptDir(agent)`, which returns the agent's cwd (the
  workspace). Real transcripts live under
  `$DSH_HOME/sessions/--<projectKey>--/<sessionId>/session.v3.jsonl.zstd` —
  zstd streams a read/grep-only fork cannot consume. The prompt's step 4
  ("grep transcripts narrowly") directs the fork at a location that holds no
  transcripts, in a format it could not read anyway.
- **R4 — total silence.** Every failure path is swallowed: the missing service
  maps to `[]`, exceptions hit `.catch(() => {})`, job failure rolls the lock
  back with no record. From the outside, "never triggered" and "failing every
  turn" are indistinguishable. This is the G2 observability gap, recorded as
  deferred in PR #80, biting its own feature.

## 2. Goals and non-goals

Goals (this PR):

- The dream gates run on real data with no cordis service dependency: session
  count and hint list come from a direct host-side scan of the session store
  on disk.
- The pressure path (PR #102) keeps its semantics and gains a correct input
  list for free; it must not tombstone the marker on a scan failure.
- The prompt stops pointing the fork at the workspace for transcripts and
  stops asking for zstd greps the fork cannot perform.
- Every gate decision and dream outcome lands in `ctx.logger`; "never fired"
  becomes distinguishable from "fired and failed".
- TDD: failing tests first, then implementation.

Non-goals (unchanged follow-ups):

- G1 manual `/dream` command; G3 settings keys; global-directory dream
  coverage; per-project attribution of sessions (see §3.7 for the reasoning).
- Any change to the extraction path, the lock, or the write-back machinery.
- No new package dependencies. `node:zlib` zstd is used in-process (engines
  `^22.19 || >=24` guarantee it on official builds; the `zstd` CLI dependency
  that makes session-forensics tests conditionally skippable is deliberately
  not adopted).

## 3. Design

### 3.1 New module: `session-scan.ts` in `@dsh-cc/memory-consolidation`

```
/** One session directory's classification, unfiltered by any gate window. */
export interface ScannedSession { id: string; createdAt: number; sub: boolean }
export interface SessionScanResult {
  /** All classifiable sessions, so the memo can be shared across repos. */
  sessions: ScannedSession[]
  /** Session directories seen, classifiable or not. */
  scanned: number
  /** Directories skipped because no readable stream/header was found. */
  unreadable: number
}
export function scanSessions(sessionsRoot: string): Promise<SessionScanResult>

/** The gate window: qualify (`!sub && createdAt > lastAt`), count all
 *  qualifying, and select up to 50 hint ids, most-recent first. Pure. */
export function gateWindow(sessions: readonly ScannedSession[], lastAt: number): { count: number; hints: string[] }
```

**Reading mechanism (cold-review blocker #1):** the fs seam cannot serve this
scan — `FileSystem.readBytes` fails targets over `maxBytes` with
`FS_TOO_LARGE` instead of truncating (dsh-fs `types/index.d.ts`), so a prefix
read through the seam is impossible, and `readText`/`streamText` reject
binary. The scanner therefore reads with `node:fs` directly: this is
host-process, read-only access under `$DSH_HOME/sessions`, matching the
session-forensics precedent (#86 shells `zstd -dc` on raw paths). The cordis
fs seam remains in use for what already flows through it (marker and lock
writes under the memory-dir policy). As a side effect, the "the policy'd
backend may deny `$DSH_HOME` reads" failure mode (cold-review major #4)
disappears with the seam.

- Iterate `<sessionsRoot>/<projectKey>/<sessionId>/` via
  `fs.promises.readdir`. A missing/unreadable root yields a zeroed result
  plus one warn log by the caller (§3.5), never an exception.
- Per session directory resolve the stream file: `session.v3.jsonl.zstd`
  first, legacy `session.jsonl.zstd` as fallback — mirroring
  `session-forensics/src/scan.ts` (cross-reference comment; the full-scan API
  of that package is not reused because the gate needs only the header line
  of each session, not whole-stream analysis).
- Prefix read: `createReadStream(path, { start: 0, end: 256 KiB - 1 })` →
  `node:zlib` `createZstdDecompress` pipeline; destroy after collecting the
  first 16 KiB of decompressed text; take the first line with
  `type: "session"`. A header that does not surface within the decompressed
  budget is `unreadable`.
- **Pinned v3 header contract** (cold-review blocker #2, verified 2026-09-22
  against a real stream):

  ```json
  {"type":"session","version":3,"id":"tui-…","createdAt":1790042832672,
   "cwd":"…/auto-dream-debug","isSeeded":false,"delegationDepth":0,
   "agentPreset":"cc"}
  ```

  `createdAt` (epoch ms) and `delegationDepth` are top-level fields of the
  header line itself — not nested under `data`, and there is no `time`/`ts`/
  `timestamp` on the header. Legacy v1 headers carry `origin` under `data`
  (session-forensics/scan.ts:116-123). Defensive extraction:
  `createdAt = header.createdAt ?? header.time ?? header.ts ?? header.timestamp`;
  missing/non-safe-integer is recorded as `Number.MAX_SAFE_INTEGER` —
  counts as NEW under `gateWindow`, failing open to over-inclusion (same
  stance as the old `sessionStartOf`). `id` falls back to the directory name.
- Classification flags rather than drops: `sub: true` when
  `delegationDepth` is a safe integer > 0 or `origin === "subagent"`
  (top-level or `data`-level); `gateWindow` does the excluding. The `origin` check is
  a deliberate widening over the replaced code (cold-review minor #6): the
  old service-row shape offered only `delegationDepth`; the v3 header carries
  it directly, and legacy v1 headers only mark subagents via `origin`.
- Capability check: if `createZstdDecompress` is absent (nonstandard/undated
  Node build — engines floor 22.19 ships it), return a zeroed result; the
  caller logs one warn per process (§3.5). The gate fails closed.

Config addition: `sessionsRoot?: string` on the plugin `Config`, defaulting
to `join(defaultDshHome(), 'sessions')` — an internal override for tests and
dogfooding, not a user-facing setting.

### 3.2 `runDream` rewiring (`index.ts`)

New decision order (all decisions logged, §3.5):

1. fs seam present (marker/lock writes); resolve memory dir and policy —
   unchanged.
2. `readPressure`, `readLastConsolidatedAt` — unchanged.
3. Pressure mode (marker armed): cooldown check unchanged; stamp with
   `markPressureForced` before lock acquisition (unchanged); then scan for
   the hint list via the memoized raw list (§3.4).
4. Periodic mode: check the time gate FIRST (pure arithmetic, no I/O); only
   when it passes, run the scan and apply the session-count gate.
5. Lock, prompt, spawn, success/failure handling — unchanged, plus the
   pressure completion rule in §3.3.

The dream prompt receives the real `sessionsRoot` and the scanned hints.
`sessionTranscriptDir`, `sessionStartOf`, `listNewSessions`, and the
`SessionsService` structural type are deleted.

### 3.3 Pressure completion rule

A pressured dream whose scan reports `scanned === 0` (store unreadable or
empty) is treated as **failed**: the lock rolls back and the marker keeps its
post-stamp `armedAt`, so the next cooldown window retries. Rationale: there
is no material to consolidate. Caveat accepted (cold-review major #5): with
§3.7's global counting, `scanned === 0` requires the whole store to be
unreadable — a this-repo-only scanner defect is not distinguishable from a
healthy empty store; mitigations are the per-scan stats log and the dogfood
assertion in §6. A persistently broken scan retries once per cooldown window
(60 min default) — bounded churn, and the markers/logs tell the truth; a
capped retry count is deferred deliberately (the marker *is* the correct
permanent signal).

A pressured dream that legitimately consolidates (even an empty `writes`
batch returned by a fork that reviewed real material) tombs the marker, as
today. The periodic path is unaffected: a zero scan simply fails the count
gate.

### 3.4 Scan memoization (amended per cold review)

The memo caches the **unfiltered** per-session list —
`Array<{ id, createdAt, sub }>` — in the `apply` closure, reused while
younger than `SCAN_MEMO_MS` (30 min); the `lastAt` filter, count, and hint
selection are recomputed per call. Caching a pre-filtered result would leak
one repo's `lastAt` into another repo's gate in a multi-repo process
(cold-review major #3). The memo exists for the failure path, not the happy
path: after a fork failure the lock rolls back, `lastAt` is unchanged, the
time gate keeps passing, and every subsequent turn-end would otherwise
rescan the whole store (cold-review minor #7's objection — the 24h time gate
already rate-limits happy-path scans — is answered here; deleting the memo
was considered and rejected on this failure-storm bound).

### 3.5 Observability (closes the silent-failure amplifier)

One logger line per decision, all via `ctx.logger`:

- `debug`: gates evaluated (`{ mode: 'periodic'|'pressure', lastAt, count,
  minSessions, pass }`), cooldown skip, scan memo hit, per-scan stats
  (`{ scanned, unreadable, count, ms }`), dream job outcome with detail on
  failure.
- `warn` (once per process each): sessions root unreadable, zstd capability
  missing.
- `warn` (per occurrence): lock held by a live holder, spawn-level failure.

Existing channels stay: the save-side "queued" sentence (PR #102) and the
jobs list (`memory-consolidation` job with completion status) now carry real
information because the job can actually start.

### 3.6 Prompt changes (`prompts.ts`)

`buildConsolidationPrompt(memoryDir, sessionsRoot, sessionHints)`:

- Step 4's "grep the session transcripts" instruction is removed. The fork
  cannot read zstd and the pointer was wrong; keeping any version of it is
  hallucination fuel.
- The sessions block is reframed: real ids under the true root, explicitly
  described as *provenance hints* for the consolidation window. Primary
  material remains the existing memory files, re-verified against the
  current workspace (step 2, unchanged) — which is what makes index pruning
  (the pressure case) work with zero new sessions.
- The prompt full-text golden in `turn-stopping.spec.ts` is re-recorded.

### 3.7 Why global, uncapped-by-project counting is correct here

The old `ctx.sessions` list was never scoped to the current repo, and the
hint ids are now strictly informational (R3 removes transcript access). A
dream's write target is the turning repo's memory directory and its durable
input is that directory's existing contents; gate cadence ("has the product
been used enough since the last pass") need not be per-repo. Cross-project
hint ids cannot pollute the directory because the fork has no usable
transcript access either way — verification runs against the workspace, not
the hints. Per-project attribution would require decoded-slug prefix matching
against `~` escapes or git-probing each session's `cwd`: real machinery for
zero behavioral gain in v1. Recorded here so a future reviewer can revisit on
evidence, not suspicion. (Cold-review minor #10 concurred.)

## 4. File-level plan

| File | Change |
| --- | --- |
| `packages/memory/memory-consolidation/src/session-scan.ts` | New module: §3.1 scanner on `node:fs`/`node:zlib`, pure, no cordis. |
| `packages/memory/memory-consolidation/src/memory-job.ts` | Extracted spawn helper (`startMemoryJob`, job/subagent structural seams, `JobOutcome`, entrypoint fallback) — the 500-line size budget on `index.ts` forced the split; public re-exports preserved. |
| `packages/memory/memory-consolidation/src/index.ts` | Delete `listNewSessions`/`sessionStartOf`/`sessionTranscriptDir`/`SessionsService`; rewire `runDream` per §3.2–3.4; add `sessionsRoot` config + `SCAN_MEMO_MS`; add §3.5 logging. |
| `packages/memory/memory-consolidation/src/prompts.ts` | §3.6 prompt revision; parameter renamed `transcriptDir → sessionsRoot`. |
| `packages/memory/memory-consolidation/tests/session-scan.spec.ts` | New: scanner tests against real tmp dirs and real zstd frames (`zstdCompressSync`) — no fs fake (§5). |
| `packages/memory/memory-consolidation/tests/turn-stopping.spec.ts` | Replace the `sessions` service mocks with a tmp-dir sessions root; update gate assertions; re-record the prompt golden. The existing in-memory fs fake stays for marker/lock/dir machinery; the sessions root is on real disk (cold-review minor #8: the fake never grows byte-stream support). |
| `packages/memory/memory-consolidation/tests/prompts.spec.ts` | Phase-4 invariant assertion follows the new no-transcript text. |
| `docs/plans/2026-09-22-auto-dream-session-scan.md` | This document (status flipped to Implemented at merge). |

No capability-manifest surface change: preset composition, commands, hook
bridging, settings, and plugin-loader surfaces are untouched (`sessionsRoot`
is an internal plugin config knob). `check:capabilities`/`docs:parity` still
run in verification.

## 5. Test plan (TDD)

`session-scan.spec.ts`, real tmp dirs (`fs.mkdtemp`) and real zstd frames:

1. v3 stream preferred; legacy `session.jsonl.zstd` read when v3 absent.
2. Header parse per the pinned contract: top-level `createdAt`;
   `delegationDepth > 0` and `origin: "subagent"` (data-level, legacy) flag
   `sub: true`; missing `createdAt` is recorded as `Number.MAX_SAFE_INTEGER`
   and therefore qualifies through `gateWindow` (fails open to
   over-inclusion).
3. Read bound: a header beyond the decompressed budget is `unreadable`;
   corrupt zstd is `unreadable`; a directory with no stream file is
   `unreadable`; a compressed stream larger than the 256 KiB read window
   with an early header is still read (prefix mechanism works).
4. Missing root → zeroed result, no throw.
5. zstd capability absent (mock `node:zlib` without
   `createZstdDecompress`) → zeroed result, no throw.
6. `gateWindow`: qualification (!sub && createdAt > lastAt), count equals
   the full qualifying set, hints capped at the 50 newest-first.
7. The scanner never spawns a subprocess (in-process zstd; guardable by
   `vi.mock('node:child_process')` failing loudly).

`turn-stopping.spec.ts` (rewrite of the sessions-related suites):

1. Sessions gate: seed N store sessions under a tmp `sessionsRoot`; the dream
   spawns iff count ≥ 5 once the time gate passes; an empty root blocks.
2. The old `sessions`-service mock is gone; a missing `sessionsRoot` blocks
   the dream and emits the once-per-process warn.
3. Pressure mode: armed marker bypasses the time gate, spawns the dream with
   the seeded ids in the prompt, tombs on success, keeps the marker on fork
   failure; a scan-zero pressure run does NOT tomb (§3.3).
4. Memoization: two turn-stoppings within the window scan once; a second
   repo (different `lastAt`) reuses the raw list with its own filter.
5. Prompt golden re-recorded: contains the sessions root path and the hint
   ids; does NOT contain the grep-transcripts instruction.
6. Existing suites unaffected by the seam change (extraction single-flight,
   lock staleness, dream single-flight) keep passing.

## 6. Verification

- `pnpm exec vitest run packages/memory` (scoped run; the umbrella
  `--filter … test` scripts are scope-only in these packages).
- `pnpm exec tsc -b` (clean rebuild if stale incremental output is
  suspected).
- `pnpm check:spec-deps`, `pnpm check:capabilities`, `pnpm docs:parity`,
  and the CI-only `pnpm check:deep-src-imports` explicitly.
- Dogfood after merge: run a scratch workspace whose index is over cap to
  arm a real marker, end a turn, then assert from the logs that a scan
  reported `scanned > 0` (cold-review major #4's gate — the prior draft's
  "lock file appears" alone would not have caught a silently empty scan),
  observe the forced `memory-consolidation` job complete and the marker
  tombstone; and within 24 h, observe the first-ever `.consolidation-lock`
  from a periodic dream.

## 7. Follow-ups (not this PR)

- G1 `/dream` manual command; G3 settings keys; global-directory dream.
- Fork-side transcript access (host digests or a sanctioned reader tool) if
  real evidence shows memory-verification alone leaves the directory stale.
- Per-project gate attribution (`cwd`-based), only if cross-project cadence
  shows up as noise in practice — the header's top-level `cwd` makes this
  cheap to add later.
