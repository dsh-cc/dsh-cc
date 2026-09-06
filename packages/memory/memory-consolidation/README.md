# dsh-memory-consolidation

English | [中文](README.zh.md)

Background memory consolidation for the DeepSeek Harness: turn-end extraction
and the three-gate dream rewrite of the memory directory that `dsh-memory`
reads.

## What this package provides

- **extractMemories** — an `agent/turn-stopping` listener starts a background
  forked subagent (via `ctx.jobs` + `ctx.subagents`, read/search tools only)
  that extracts durable facts from the turn and reports them as structured
  output; the plugin validates the batch and writes the matching topic files
  host-side.
- **Dream consolidation** — three configurable gates that must all pass before
  a read-only forked subagent reviews past sessions and reports the rewritten
  `MEMORY.md` + topic file set the same way:
  1. **Time** — at least `minHours` (default 24) since the last consolidation.
  2. **Session count** — at least `minSessions` (default 5) new transcripts.
  3. **Lock** — a `.consolidation-lock` file whose stored timestamp enforces
     mutual exclusion; a stale holder (older than `lockStaleMs`, default 1 hour)
     is reclaimed, so a crash mid-consolidation recovers automatically. A
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
| `subagentProviderName` | `fork` | one-shot provider for the forks |

```ts
import consolidation from '@dsh-cc/memory-consolidation'
await ctx.plugin(consolidation, { minHours: 24, minSessions: 5 })
```

## Model Experience

The turn-stopping listener is nearly free when the gates are closed (one lock
read). When the time and session gates open, one forked subagent runs per
consolidation, restricted to read/search tools plus the `structured_output`
report tool; its output is not appended to the main transcript. Per turn,
extraction may start a short background fork.

## API

- `tryAcquireLock(fs, dir, pid, now, policy?)` / `rollbackLock(fs, dir, priorAt, policy?)` /
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
- The session-count gate currently counts live sessions through `ctx.sessions`
  and treats them as new; a clocked transcript query is deferred.
- There is no delete channel: the dream drops outdated memories from
  `MEMORY.md`, but an orphaned topic file stays on disk until overwritten.
  Topic-file deletion is deferred (the fork allow-list never had a remove
  tool either).
- Concurrent extractions from parallel sessions write last-writer-wins; the
  dream lock serializes only consolidations.
