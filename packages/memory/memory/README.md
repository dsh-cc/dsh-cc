# dsh-memory

English | [中文](README.zh.md)

Claude Code-style file-based memory for the DeepSeek Harness: a durable memdir
format, a `memory` system-prompt section, the `memory_save` write channel, and
dynamic recall by a forked side-query. All file access goes through the
optional `ctx.fs` seam, so a remote or sandboxed backend works unchanged (a
providerless host mounts memory read-only).

## What this package provides

- **Memdir format** — a memory home (default the harness home's `memory/`)
  holding an always-loaded `MEMORY.md` entrypoint (capped at 200 lines / 25 KB)
  per layer, each a one-line index of `.md` topic files. Each topic file
  carries `name`, `description`, and `type` (`user` / `feedback` / `project` /
  `reference`) frontmatter plus a Markdown body. The parser is independently
  exported.
- **Per-workspace isolation with a global layer** — memories are scoped to the
  git repository (Claude Code auto-memory identity): `canonicalMemoryRoot`
  collapses linked worktrees and subdirectories onto the main checkout, then
  the slug is the upstream `projectKey` dash-encoding of that root, so the
  workspace directory is `<memoryHome>/projects/<slug>/`. Worktrees of one
  repo — and the opt-in `<workspaceDir>/team` layer — share one store. The
  home root itself is the global layer shared by every workspace. Sessions
  of different repositories never see each other's private memories; facts
  useful everywhere are saved with `scope: "global"`. Session transcripts
  still group by raw cwd (`sessions/--<cwd-slug>--`); memory no longer
  matches that grouping for worktree sessions.
- **`memory` system-prompt section** — save-channel guidance, each layer's
  entrypoint content (truncated), a scope-tagged combined index of topic
  files, and grep search guidance. The section ALWAYS renders (a memoryless
  layer shows a placeholder) so the save guidance never disappears. One global
  registration serves every agent: the text callback renders the assembling
  agent's own workspace layer (the agent arrives via the assemble scope).
  Delegated children (`delegationDepth > 0`) render an empty string so the
  section drops out of the child prompt — matching Claude Code, auto-memory is
  not shared with non-fork subagents; the parent prompt must pass any facts the
  child needs. Directory scans run in the background through `ctx.fs`; rendered
  per-layer fragments are cached and `system-prompt/change` fires only when a
  fragment actually changed; a turn-end listener re-scans so host-side writes
  surface without a restart.
- **`memory_save` tool** — the ONLY working save channel. Memory directories
  live outside every session workspace, so direct `write`/`edit` calls
  against them are fenced by the fs sandbox and always fail; the section says
  so explicitly. The tool takes structured fields (`name`, `type`,
  `description`, `body`, optional `scope`: `workspace` (default) or `global`),
  resolves the target directory from the calling agent's canonical git root,
  generates the frontmatter host-side, upserts the `MEMORY.md` pointer, and
  writes via the `ctx.fs` seam under a per-call policy of
  `{ mode: 'workspace-write', workspaceRoot: <memory dir> }` — confinement is
  kept, the writable root IS the memory directory. Validation (kebab-case
  slugs, the four types, size caps) shares the `writeback` boundary with
  `dsh-memory-consolidation`'s fork write-back. Registration is opportunistic:
  hosts without a tools service skip it and stay read-only.
- **Dynamic recall** — an `agent/pre-step` listener asks a small-model side
  query (a forked subagent via `ctx.subagents`) which topic files are relevant
  to the turn, then injects their bodies through `agent.inject()`. Recall
  scans both layers (the agent's workspace directory plus the global one) and
  deduplicates: topic files already shown this session are never re-injected.
  Tools used earlier in the session are tracked (`tools/post-execute`) and
  passed to the selector so reference-doc memories for an actively-used tool
  are suppressed (warnings/gotchas about it are still surfaced). Absence of the
  subagent service or provider skips recall without error.
- **Team memory (opt-in)** — when `teamEnabled` is `true`, a shared
  per-workspace team directory (`<workspaceDir>/team`) is layered on the
  workspace's private memdir and the `memory` section renders a combined
  workspace + team + global prompt. Every team-memory access runs a
  seam-native validation chain (pure-string key sanitization first, then
  `lstat` final-segment symlink rejection, then `resolve` + `contains` prefix
  containment).

## Usage

Load the plugin with `@dsh-cc/memory`. Configuration knobs:

| Key | Default | Meaning |
|---|---|---|
| `memoryHome` | harness home `memory/` | memory home root: the global layer, and the parent of each repository's `projects/<slug>/` directory |
| `sectionEnabled` | `true` | register the `memory` system-prompt section |
| `recallEnabled` | `true` | run dynamic recall on pre-step |
| `recallProviderName` | `fork` | one-shot subagent provider for the recall query |
| `recallAgentOptions` | unset | raw `agentOptions` stamped onto the recall fork; wins over `recallUseSmallFast` and is NOT alias-resolved (pass a resolved route, not `{ model: 'haiku' }`) |
| `recallUseSmallFast` | `false` | opt the recall fork into the cheap lane: stamp `resolve('haiku')` from `ccModelRoutes` (inherit when unconfigured). Opt-in so configuring `haiku` for typed agents doesn't silently flip every recall onto a cross-model, prefix-inheriting fork |
| `teamEnabled` | `false` | enable the per-workspace team memory directory + combined section |

> **`teamEnabled` is off by default.** Enabling it changes the persisted
> memory layout (creates and reads `<workspaceDir>/team/`), changes what the
> model writes (workspace vs `team` scope), and points team-memory reads at a
> shared directory. It is intended for single-tenant, trusted-writer projects:
> the per-access validation closes traversal, but the *intermediate*-component
> TOCTOU window is not fully closed (only the final segment is `lstat`-checked,
> and the resolve/containment check and the read are not atomic). Do not enable
> `teamEnabled` in multi-tenant or untrusted-writer deployments.

> **Layout change.** Before per-workspace isolation, all memories lived flat
> in `memoryHome/`. Those top-level files are not migrated: they now serve as
> the global layer (visible to every workspace). A pre-isolation team
> directory at `<memoryHome>/team/` is inert — team memory now lives at
> `<workspaceDir>/team/`; move its files manually if you had `teamEnabled`
> on. Pre-collapse worktree-cwd slugs (`projects/<slug-of-the-worktree-path>/`)
> are likewise not migrated: they stay on disk unused; new writes land in the
> main-checkout bucket.

```ts
import memory from '@dsh-cc/memory'
await ctx.plugin(memory, { memoryHome: '/tmp/mem' })
```

## Model Experience

Baseline cost: one synchronous render of the cached section text per step (no
I/O). The cheapest path additionally scans the memory directory — when it
contains topics, recall may spend one small-model subagent call per turn until
all topics have been shown, then stops. Token growth is bounded by the
entrypoint truncation caps and the five-file recall ceiling.

## API

- `parseMemoryFile(raw)` — split a topic file into frontmatter + body.
- `scanMemoryDirectory(fs, dir, signal?)` — read the entrypoint and topic index.
- `renderMemorySection(globalDir, workspaceDir, ...)` /
  `renderTeamMemorySection(...)` / `renderLayers(layers)` /
  `saveGuidance(workspaceDir, globalDir)` — the section text builders.
- `MemorySection` — background-refresh cache holder for the section (one
  registration, per-agent workspace layers).
- `registerMemorySaveTool(ctx, home, section)` / `MEMORY_SAVE_TOOL` /
  `MEMORY_SAVE_SCOPES` — the model-facing save channel.
- `validateMemoryWrites(input)` / `writeMemoryFiles(fs, dir, writes)` /
  `memoryWritePolicy(dir)` / `MEMORY_WRITES_SCHEMA` — the host-side write-back
  shared with `dsh-memory-consolidation`.
- `MemoryRecall` — the pre-step recall coordinator.
- `truncateEntrypointContent(raw)` — apply the line/byte caps.
- `resolveMemoryHome`, `resolveWorkspaceMemoryDir`, `canonicalMemoryRoot`,
  `projectSlug`, `cwdOf`, `resolveProjectMemoryRoot` — memdir root and
  workspace helpers. `canonicalMemoryRoot` is the git-repo collapse
  (worktrees → main checkout); `cwdOf` stays the live working copy.
- `sanitizePathKey(key)`, `validateTeamMemKey(fs, teamDir, relativeKey)`,
  `resolveTeamMemoryRoot(workspaceDir)` — the team-memory security chain and
  path helpers.

## Known Limitations and Deferred Work

- The `ctx.fs` seam exposes no mtime, so recall deduplication tracks shown
  paths per session rather than mtime+path; content is re-read fresh each
  injection, which still reflects on-disk changes. CC's `memoryAge` freshness
  weighting is therefore deferred until the seam carries mtime (see
  `docs/cc-parity-matrix.md`).
- The recall side-query relies on a registered one-shot subagent provider; no
  provider ships with this package (compose `fork` or `spawn`).
- `memory_save` writes the workspace and global layers only; a team-scope save
  channel and a delete channel are deferred (as is CC's direct-Write parity,
  which the fs sandbox makes impossible for session tools).
- Team memory (`teamEnabled`) reversibility and safety: enabling it is a
  persisted-format change, and the intermediate-component TOCTOU window (only
  the final segment is `lstat`-checked; resolve/containment and the read are
  not atomic) means it must not be enabled in multi-tenant or untrusted-writer
  deployments.
