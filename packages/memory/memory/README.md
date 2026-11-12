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
  `@dsh-cc/memory-consolidation`'s fork write-back. Registration is opportunistic:
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
- **SystemOne decision recall (opt-in, off by default)** — with the
  `cc-systemone-memory-recall` namespace set to `shadow` or `active`, candidate
  relevance is judged as an independent probability per candidate by the
  SystemOne decision model instead of a generative filename pick, and the
  deterministic `include`/`exclude` filter decides what to inject. It is an
  optional layer on the same recall pipeline: the legacy selector stays and is
  the fallback, and the feature runs nothing while its mode is `off`.

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

## SystemOne decision recall (opt-in, default off)

Recall can also be decided by the SystemOne decision model: one `noul`
question per candidate returns an independent relevance probability, and a
deterministic filter picks the injected files. This path ships **off** — `mode`
defaults to `off`, so no decision request is ever sent until an operator turns
it on.

The knobs live in their own settings namespace, `cc-systemone-memory-recall`
(registered through `registerNamespaceSafe`, which also keeps a broken or
duplicate registration from blocking the mount; keys are kebab-case there). A
host without a settings service keeps exactly these defaults; an update carrying
any invalid value is rejected whole and the previous valid snapshot stays in
force — values are never clamped into range, and a rejected first registration
leaves every field at its default.

| Field | Default | Range and meaning |
|---|---|---|
| `mode` | `off` | `off` / `shadow` / `active` — see the modes below |
| `timeout-ms` | `1500` | 100-30000; total deadline for the whole selection (every batch) — size it to your pool: ~1.3 s per 24-candidate batch, and the default 96/24 planning runs four |
| `max-input-tokens` | `6000` | 512-16000; per-batch limit for the complete request |
| `max-candidates` | `96` | 1-256; a larger candidate pool falls back to the legacy selector |
| `batch-size` | `24` | 1-32; also bounded by the question count the route advertises |
| `include-probability` | `0.75` | `0.5`-`1`; `p ≥` this is an explicit inclusion |
| `exclude-probability` | `0.25` | `0`-`0.5` and below `include-probability`; `p ≤` this is an explicit exclusion |
| `fallback-max-candidates` | `256` | `max-candidates`-1024; above it the round skips recall instead of selecting from a subset |
| `fallback-max-bytes` | `65536` | 4096-262144; UTF-8 cap on the request text the legacy selector receives |

Modes:

- **`off`** (default) — nothing new runs: the legacy branch alone selects and
  injects, no route is read and no decision request is sent.
- **`shadow`** — the legacy branch still selects and injects; the decision model
  runs alongside and the comparison is recorded only. A shadow result is never
  injected, so the mode is safe to enable first.
- **`active`** — the decision model decides. A probability strictly inside
  `(exclude-probability, include-probability)` makes the whole pool uncertain
  and falls back to the legacy selector once; every other degradation (no
  service, no resolvable route, over the candidate limit, batch or token budget,
  timeout, malformed answer, a route revision change) also falls back exactly
  once. Cancellation never falls back, and an all-low pool is a valid empty
  result. Turning the mode back to `off` leaves no persistent state behind.

Relationship to the existing switch and legacy options: `recallEnabled` remains
the master switch — with `recallEnabled: false` none of the three modes run.
`recallProviderName`, `recallAgentOptions` and `recallUseSmallFast` configure
only the legacy selector and its fallback; they do not steer SystemOne routing,
which always uses the exported decision lane alias (`DECISION_LANE_ALIAS`,
`gauge`) — there is no per-consumer alias setting, and the optional
`systemone-decisions` `routes` pin row can only narrow that lane's revision and
bounds. `sectionEnabled` and `teamEnabled` are unaffected.

Private inputs: the decision route receives the turn's query plus metadata only
— per candidate its scope, filename, name and description, and the names of
tools already used this turn. Memory file content, absolute paths, content
hashes and tool arguments are never sent, and the metadata is data, not
instructions. A model answer cannot gain file-reading ability: path
canonicalization, directory boundaries and readability are still enforced by
the original fs flow, and a selected file whose hash changed on re-read is
discarded rather than injected.

Optional host dependency: the route is hosted by the optional
`ctx.systemoneDecisions` service published by `@dsh-cc/decision-usage` (feature
S1-02). Memory never imports that plugin — the face is structural, so a host
without it still mounts and simply degrades (`shadow` records no comparison,
`active` falls back to the legacy selector). **No profile enables this feature
by default**: the `cc` preset mounts the service row (inert until a consumer
binds an agent), and the namespace above starts at `mode: off`. Enabling recall
therefore needs BOTH the plugin and a non-`off` mode; the plugin alone changes
nothing, and a mode without the plugin only ever falls back.

```jsonc
// settings cascade
{ "cc-systemone-memory-recall": { "mode": "shadow" } }
```

## Model Experience

Baseline cost: one synchronous render of the cached section text per step (no
I/O). The cheapest path additionally scans the memory directory — when it
contains topics, recall may spend one small-model subagent call per turn until
all topics have been shown, then stops. Token growth is bounded by the
entrypoint truncation caps and the five-file recall ceiling. With
SystemOne recall in `shadow` or `active`, a turn may instead spend one decision request
per batch — bounded by `max-candidates`, `batch-size` and `timeout-ms`, and
metered by the host's decision ledger (`@dsh-cc/decision-usage`) when that
service is mounted.

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
  shared with `@dsh-cc/memory-consolidation`.
- `readPressure(fs, dir)` / `armPressure(fs, dir, now, policy?)` /
  `markPressureForced(...)` / `clearPressure(...)` / `PRESSURE_FILE` — the
  consolidation-pressure marker (`.consolidation-needed`) that queues a forced
  dream when the index gate signals pressure.
- `MemoryRecall` — the pre-step recall coordinator.
- `SETTINGS_NAMESPACE` / `DEFAULT_RECALL_DECISION_SETTINGS` /
  `DEFAULT_RECALL_DECISION_SECTION` / `recallDecisionSettings(section)` /
  `registerRecallDecisionSettings(ctx)` — the `cc-systemone-memory-recall`
  namespace (kebab-case fields), its design defaults and the camelCase reader, which
  the recall slices consume.
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


## Topic-index byte cap (`cc-memory-section`)

The combined topic index block is capped by `cc-memory-section.max-bytes`
(default **8192**, bounds 1024..65536; **provisional** until input-ledger
distribution data lands). Only the index block is capped — header, per-layer
fragments and the "Searching past context" guidance render byte-identical to an
uncapped session. Truncation removes whole entries from the bottom of the
alphabetical list and appends `… (N more memory topics; grep the memory
directory for older entries)`. Floor rule: if one entry plus the note does not
fit, the section keeps header + search guidance + note with no entries — the
budget is a cap above the floor, never below it. `truncate: false` renders the
index uncapped (the section is never removed).
