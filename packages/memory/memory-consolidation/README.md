# dsh-memory-consolidation

English | [中文](README.zh.md)

Background memory consolidation for the DeepSeek Harness: turn-end extraction
and the three-gate dream rewrite of the memory directory that `dsh-memory`
reads. 〔src:ws:packages/memory/memory-consolidation/src/index.ts#L1-L15〕

## What this package provides

- **extractMemories** — an `agent/turn-stopping` listener starts a background
  forked subagent (via `ctx.subagents` only, tracked internally — not on the
  `ctx.jobs` seam; read/search tools only) that extracts durable facts from the
  turn and reports them as structured output; the plugin validates the batch and
  writes the matching topic files host-side. 〔src:ws:packages/memory/memory-consolidation/src/index.ts#L5-L6〕
- **Dream consolidation** — three configurable gates that must all pass before
  a read-only forked subagent reviews past sessions and reports the rewritten
  `MEMORY.md` + topic file set the same way:
  1. **Time** — at least `minHours` (default 24) since the last consolidation. 〔src:ws:packages/memory/memory-consolidation/src/gates.ts#L22-L31〕
  2. **Session count** — at least `minSessions` (default 5) new transcripts. 〔src:ws:packages/memory/memory-consolidation/src/gates.ts#L35-L42〕
  3. **Lock** — a `.consolidation-lock` file whose stored timestamp enforces
     mutual exclusion; a stale holder (older than `lockStaleMs`, default 1 hour)
     is reclaimed, so a crash mid-consolidation recovers automatically. A
     failed or killed consolidation rolls the lock back so the time gate
     re-opens. 〔src:ws:packages/memory/memory-consolidation/src/lock.ts#L16-L19;packages/memory/memory-consolidation/src/index.ts#L90-L92〕
- **Memory writes change model-visible context** — upstream, `dsh-memory`
  re-assembles the `memory` system-prompt section via `system-prompt/change`
  after the memory directory changes. This package introduces no new session
  events for the memory files themselves. 〔src:ws:packages/memory/memory/src/section.ts#L11-L11〕

## Sandbox interaction: why the plugin writes, not the fork

Each memory directory lives in the harness home, OUTSIDE any session
workspace. A forked subagent inherits the parent session's sandbox policy, so
under `workspace-write` (or `read-only`) every model-side `write`/`edit`
aimed at a memory directory is fenced (`FS_SANDBOX_DENIED`), and a
background job cannot use the escalation retry — escalation prompts, and the
job's approval policy is `never`. Model-side memory writes are therefore
guaranteed to fail in any sandboxed session. 〔src:ws:packages/memory/memory-consolidation/src/tools.ts#L3-L9〕

So the forks hold no write tools at all. They report their file set through
`outputSchema` (the driver-injected `structured_output` tool), and the plugin
— trusted host code — performs the writes itself. Writes land in the TURNING
agent's own workspace directory — `<memoryHome>/projects/<slug>/`, resolved
from the agent's canonical git root with `resolveWorkspaceMemoryDir` — never the
shared home root (that root is the explicitly-global layer owned by
`dsh-memory`'s `memory_save` with `scope: "global"`): 〔src:ws:packages/memory/memory-consolidation/src/prompts.ts#L6-L6;packages/memory/memory-consolidation/src/index.ts#L221-L221〕

1. `validateMemoryWrites` checks the untrusted payload: flat `.md` filenames
   only (no separators, `..`, absolute paths, or dotfiles), no duplicates,
   and hard caps (32 files / 64 KiB per file / 256 KiB per batch). Any
   violation rejects the WHOLE batch. 〔src:ws:packages/memory/memory/src/writeback.ts#L53-L57〕
2. `writeMemoryFiles` writes the batch via the `ctx.fs` seam, stamping a
   per-call policy of `{ mode: 'workspace-write', workspaceRoot: <memory dir> }`
   — confinement is kept, but the writable root IS the memory directory. The
   sandbox still fences each write behind the validation above; nothing
   outside the memory directory becomes writable. 〔src:ws:packages/memory/memory-consolidation/src/memory-job.ts#L150-L151〕

The job status reflects the real outcome: a non-completed `stopReason`, a
missing/invalid payload, or a write-back failure maps to `failed` with detail
instead of a silent fake-`completed`. 〔src:ws:packages/memory/memory-consolidation/src/memory-job.ts#L138-L157〕

## Usage

Load the plugin with `@dsh-cc/memory-consolidation`. Configuration:

| Key | Default | Meaning |
|---|---|---|
| `memoryHome` | harness home `memory/` | memory home root; extraction/dream write into the turning agent's repository `projects/<slug>/` under it 〔src:ws:packages/memory/memory-consolidation/src/index.ts#L86-L96〕 |
| `extractEnabled` | `true` | run turn-end extraction 〔src:ws:packages/memory/memory-consolidation/src/index.ts#L86-L96〕 |
| `dreamEnabled` | `true` | run the three-gate dream 〔src:ws:packages/memory/memory-consolidation/src/index.ts#L86-L96〕 |
| `minHours` | `24` | minimum hours between consolidations 〔src:ws:packages/memory/memory-consolidation/src/index.ts#L90-L90〕 |
| `minSessions` | `5` | minimum new transcripts to consolidate 〔src:ws:packages/memory/memory-consolidation/src/index.ts#L91-L91〕 |
| `lockStaleMs` | `3_600_000` | lock holder stale window 〔src:ws:packages/memory/memory-consolidation/src/index.ts#L92-L92〕 |
| `pressureCooldownMinutes` | `60` | minimum minutes between forced (pressure) dreams 〔src:ws:packages/memory/memory-consolidation/src/index.ts#L93-L93〕 |
| `subagentProviderName` | `fork` | one-shot provider for the forks 〔src:ws:packages/memory/memory-consolidation/src/index.ts#L94-L94〕 |
| `sessionsRoot` | `<DSH_HOME>/sessions` | session store root the gates scan 〔src:ws:packages/memory/memory-consolidation/src/index.ts#L95-L95〕 |

```ts
import consolidation from '@dsh-cc/memory-consolidation'
await ctx.plugin(consolidation, { minHours: 24, minSessions: 5 })
```

## Model Experience

The turn-stopping listener is nearly free when the gates are closed (one lock
read). When the time and session gates open, one forked subagent runs per
consolidation, restricted to read/search tools plus the `structured_output`
report tool; its output is not appended to the main transcript. Per turn,
extraction may start a short background fork. 〔src:ws:packages/memory/memory-consolidation/src/tools.ts#L3-L9〕

## API

- `tryAcquireLock(fs, dir, pid, now, policy?)` / `rollbackLock(fs, dir, priorAt, policy?)` /
  `readLastConsolidatedAt(fs, dir)` — the consolidation lock. 〔src:ws:packages/memory/memory-consolidation/src/lock.ts#L44-L44;packages/memory/memory-consolidation/src/lock.ts#L71-L71;packages/memory/memory-consolidation/src/lock.ts#L120-L120〕
- `gatesPass(input)` / `timeGatePasses(...)` / `sessionGatePasses(...)` — the
  gate predicates. 〔src:ws:packages/memory/memory-consolidation/src/gates.ts#L28-L51〕
- `MEMORY_TOOL_FILTER` / `MEMORY_AGENT_TOOLS` — the memory-scoped tool set
  (read/search + `structured_output`). 〔src:ws:packages/memory/memory-consolidation/src/tools.ts#L3-L9〕
- `MEMORY_WRITES_SCHEMA` — the `outputSchema` contract every fork reports. 〔src:ws:packages/memory/memory/src/writeback.ts#L53-L57〕
- `validateMemoryWrites(input)` / `writeMemoryFiles(fs, dir, writes)` /
  `memoryWritePolicy(dir)` — the host-side write-back (owned by
  `@dsh-cc/memory`, the memory directory owner, and re-exported here). 〔src:ws:packages/memory/memory-consolidation/src/index.ts#L49-L58〕
- `buildExtractionPrompt` / `buildConsolidationPrompt` — the fork prompts. 〔src:ws:packages/memory/memory-consolidation/src/prompts.ts#L26-L26;packages/memory/memory-consolidation/src/prompts.ts#L58-L58〕

## Known Limitations and Deferred Work

- The `ctx.fs` seam exposes no mtime, so the lock stores the holder PID and
  last-consolidated epoch in the lock file's body rather than in the file
  mtime; crash recovery rests on the stale window, not process-liveness. 〔src:ws:packages/memory/memory-consolidation/src/lock.ts#L22-L24〕
- The session-count gate scans the durable session store with header-only prefix
  reads; a directory it cannot read is counted separately rather than silently
  treated as empty. 〔src:ws:packages/memory/memory-consolidation/src/session-scan.ts#L30-L45〕
- There is no delete channel: the dream drops outdated memories from
  `MEMORY.md`, but an orphaned topic file stays on disk until overwritten.
  Topic-file deletion is deferred (the fork allow-list never had a remove
  tool either). 〔src:ws:packages/memory/memory-consolidation/src/prompts.ts#L66-L66〕
- Concurrent extractions from parallel sessions write last-writer-wins; the
  dream lock serializes only consolidations. 〔src:ws:packages/memory/memory-consolidation/src/lock.ts#L71-L71〕
