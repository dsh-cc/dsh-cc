# dsh-memory-consolidation

English | [中文](README.zh.md)

Background memory consolidation for the DeepSeek Harness: turn-end extraction
and the three-gate dream rewrite of the memory directory that `dsh-memory`
reads.

## What this package provides

- **extractMemories** — an `agent/turn-stopping` listener starts a background
  forked subagent (via `ctx.subagents` only, tracked internally — not on the
  `ctx.jobs` seam; read/search tools only) that extracts durable facts from the
  turn and reports them as structured output; the plugin validates the batch and
  writes the matching topic files host-side.
- **Dream consolidation** — three configurable gates that must all pass before
  a read-only forked subagent reviews past sessions and reports the rewritten
  `MEMORY.md` + topic file set the same way:
  1. **Time** — at least `minHours` (default 24) since the last consolidation.
  2. **Session count** — at least `minSessions` (default 5) new transcripts.
  3. **Lock** — a `.consolidation-lock` file whose stored timestamp enforces
     mutual exclusion; a stale holder (older than `lockStaleMs`, default 1 hour)
     is reclaimed, so a crash mid-consolidation recovers automatically. A
     successful consolidation RELEASES the lock (holder cleared, epoch kept),
     so the next dream waits only on its own cooldown or the time gate. A
     failed or killed consolidation rolls the lock back so the time gate
     re-opens.
- **Memory writes change model-visible context** — upstream, `dsh-memory`
  re-assembles the `memory` system-prompt section via `system-prompt/change`
  after the memory directory changes. This package introduces no new session
  events for the memory files themselves.

## Sandbox interaction: why the plugin writes, not the fork

Each memory directory lives in the harness home, OUTSIDE any session
workspace. A forked subagent inherits the parent session's sandbox policy, so
under `workspace-write` (or `read-only`) every model-side `write`/`edit`
aimed at a memory directory is fenced (`FS_SANDBOX_DENIED`), and a
background job cannot use the escalation retry — escalation prompts, and the
job's approval policy is `never`. Model-side memory writes are therefore
guaranteed to fail in any sandboxed session.

So the forks hold no write tools at all. They report their file set through
`outputSchema` (the driver-injected `structured_output` tool), and the plugin
— trusted host code — performs the writes itself. Writes land in the TURNING
agent's own workspace directory — `<memoryHome>/projects/<slug>/`, resolved
from the agent's canonical git root with `resolveWorkspaceMemoryDir` — never the
shared home root (that root is the explicitly-global layer owned by
`dsh-memory`'s `memory_save` with `scope: "global"`):

1. `validateMemoryWrites` checks the untrusted payload: flat `.md` filenames
   only (no separators, `..`, absolute paths, or dotfiles), no duplicates,
   and hard caps (32 files / 64 KiB per file / 256 KiB per batch). Any
   violation rejects the WHOLE batch.
2. `writeMemoryFiles` writes the batch via the `ctx.fs` seam, stamping a
   per-call policy of `{ mode: 'workspace-write', workspaceRoot: <memory dir> }`
   — confinement is kept, but the writable root IS the memory directory. The
   sandbox still fences each write behind the validation above; nothing
   outside the memory directory becomes writable.

The job status reflects the real outcome: a non-completed `stopReason`, a
missing/invalid payload, or a write-back failure maps to `failed` with detail
instead of a silent fake-`completed`.

## Usage

Load the plugin with `@dsh-cc/memory-consolidation`. Configuration:

| Key | Default | Meaning |
|---|---|---|
| `memoryHome` | harness home `memory/` | memory home root; extraction/dream write into the turning agent's repository `projects/<slug>/` under it |
| `extractEnabled` | `true` | run turn-end extraction |
| `dreamEnabled` | `true` | run the three-gate dream |
| `minHours` | `24` | minimum hours between consolidations |
| `minSessions` | `5` | minimum new transcripts to consolidate |
| `lockStaleMs` | `3_600_000` | lock holder stale window |
| `pressureCooldownMinutes` | `60` | minimum minutes between forced (pressure) dreams |
| `subagentProviderName` | `fork` | one-shot provider for the forks |
| `sessionsRoot` | `<DSH_HOME>/sessions` | session store root the gates scan |

```ts
import consolidation from '@dsh-cc/memory-consolidation'
await ctx.plugin(consolidation, { minHours: 24, minSessions: 5 })
```

## Extraction decision gate (`cc-systemone-memory-extraction`)

An optional, default-off gate in front of the turn-end extraction fork. Before a
fork starts, one System One decision-model call answers a single question over the
complete review window — the session events since the last reviewed seq, plus the
existing topic index: *does this window hold at least one durable novel fact?*
Only an explicit low-probability verdict may omit the fork. Every other outcome —
an incomplete window, a budget overflow, a missing route or runner, an invalid
answer, a timeout — extracts exactly as before.

Three modes are read dynamically from the `cc-systemone-memory-extraction`
settings namespace (kebab-case external keys; any invalid value rejects the whole
section and keeps the previous snapshot):

| Key | Default | Meaning |
|---|---|---|
| `mode` | `off` | `off` keeps the legacy listener and issues no decision request; `shadow` serialises jobs through the coordinator but still extracts and only records the would-skip; `active` lets an eligible low-probability verdict skip the fork |
| `timeout-ms` | `1500` | per-decision wire timeout (integer, 100–5000) |
| `max-input-tokens` | `6000` | estimated-token budget of one decision state (integer, 512–16000) |
| `max-surface-events` | `64` | above this many reviewed events the window extracts directly (integer, 1–256) |
| `max-state-bytes` | `32768` | byte budget of the complete state in UTF-8 (integer, 4096–131072) |
| `skip-probability` | `0.05` | `p` at or below this may skip (range `0`–`0.20`, both ends inclusive); `0.5` is the fixed positive boundary |
| `audit-every-n-skips` | `20` | every Nth eligible skip becomes an audit extraction instead (integer, 1–1000) |
| `failure-cooldown-ms` | `30000` | wait before a failed window may be retried (integer, 1000–300000) |
| `session-state-cap` | `200` | LRU cap on idle session states with no in-flight work (integer, 1–2000) |

These probabilities are experimental: there is no accuracy or benefit guarantee.
The gate is inert unless `@dsh-cc/decision-usage` — or another provider of the
root-realm `ccSystemoneDecisions` service — is mounted. There is no per-consumer
alias setting: the decision route is the exported lane alias
(`DECISION_LANE_ALIAS`, `gauge`) resolved by the model-alias registry, and the
service's `systemone-decisions` `routes` pin rows can only narrow that lane
(revision, an optional version pin, token bounds). Without that service every
eligible window simply extracts (reason `unavailable`), and the extraction model,
`memoryHome` and `subagentProviderName` keep their original configuration under
every mode.

**Shadow is not event-for-event identical to the legacy scheduling.** `shadow` and
`off` produce the same expected memory content with the same read/write
permissions and the same generative model configuration, but `shadow` deliberately
tightens the concurrency timing: jobs are serialised through the coordinator and
the review watermark advances only after the host validated and wrote the batch,
so an unfinished job is never treated as finished. Only `active` can omit a fork.

**Private input.** A complete window sends current session text plus the existing
topic index to the configured decision route — a higher disclosure risk than the
candidate metadata a recall selector sends. Nothing is sent with the default
`off`. No credentials, request headers, tool arguments or absolute paths enter the
state; if material would have to be trimmed, the window is marked incomplete and
the original fork runs instead, so a skip is never based on trimmed text. The
watermark, skip ordinal and lease live in process memory only — no memory file or
session event type is added.

**Evaluation and rollback.** [`eval/`](eval/README.md) carries the synthetic
240-window golden set, the label definition and the offline gates (zero false
skips on positives — including the explicit-correction and user-preference
subclasses — zero skips on incomplete windows, fact recall no lower than the
always-extract baseline, total cost below it). The gated harness
(`DSH_EXTRACTION_EVAL=1 pnpm vitest run packages/memory/memory-consolidation/tests/eval-extraction-systemone.spec.ts`)
runs the windows through the real builder and gate with a fake decision runner and
writes a report that is stamped `invalid-for-release`: a mock run never supports a
rollout decision. Roll out `shadow` first (at least 100 complete, authorised
windows with every would-skip positive checked by hand), then `active` in a
designated workspace. Set the mode back to `off` if an audit fork finds any
durable fact, a cross-repo write, a watermark that jumped past an unfinished job,
or a concurrent overwrite of the same memory directory. Rollback is the same flip:
the coordinator cancels the new gate and waits for the write lease to be released,
in-memory watermarks and skip counts are discarded, on-disk memory is neither
migrated nor deleted, and the legacy listener owns the next turn-stopping. The
default stays `off`; changing it needs its own evaluation evidence and review.

## Model Experience

The turn-stopping listener is nearly free when the gates are closed (one lock
read). When the time and session gates open, one forked subagent runs per
consolidation, restricted to read/search tools plus the `structured_output`
report tool; its output is not appended to the main transcript. Per turn,
extraction may start a short background fork. With the extraction decision gate
in `active` mode an eligible skip replaces that fork with one short decision call;
in `shadow` mode the decision call is added on top of the unchanged fork.

## API

- `tryAcquireLock(fs, dir, pid, now, policy?)` / `releaseLock(fs, dir, pid, at, policy?)` / `rollbackLock(fs, dir, pid, at, priorAt, policy?)` /
  `readLastConsolidatedAt(fs, dir)` — the consolidation lock.
- `gatesPass(input)` / `timeGatePasses(...)` / `sessionGatePasses(...)` — the
  gate predicates.
- `MEMORY_TOOL_FILTER` / `MEMORY_AGENT_TOOLS` — the memory-scoped tool set
  (read/search + `structured_output`).
- `MEMORY_WRITES_SCHEMA` — the `outputSchema` contract every fork reports.
- `validateMemoryWrites(input)` / `writeMemoryFiles(fs, dir, writes)` /
  `memoryWritePolicy(dir)` — the host-side write-back (owned by
  `@dsh-cc/memory`, the memory directory owner, and re-exported here).
- `buildExtractionPrompt` / `buildConsolidationPrompt` — the fork prompts.

## Known Limitations and Deferred Work

- The `ctx.fs` seam exposes no mtime, so the lock stores the holder PID and
  last-consolidated epoch in the lock file's body rather than in the file
  mtime; crash recovery rests on the stale window, not process-liveness.
- The session-count gate scans the durable session store with header-only prefix
  reads; a directory it cannot read is counted separately rather than silently
  treated as empty.
- There is no delete channel: the dream drops outdated memories from
  `MEMORY.md`, but an orphaned topic file stays on disk until overwritten.
  Topic-file deletion is deferred (the fork allow-list never had a remove
  tool either).
- Concurrent extractions from parallel sessions no longer drop each other's `MEMORY.md`
  pointers: an index write is checked against the baseline the job read and rebased onto
  whatever landed meanwhile. Topic-file bodies are still last-writer-wins, and the dream
  lock serializes only consolidations.
- The extraction decision gate's write lease is a within-process, per-directory
  lease for the `shadow`/`active` modes of this plugin only. It is not a
  cross-process transaction, it does not widen the dream lock's meaning, and it
  makes no claim about two independent harnesses updating one memory home.
