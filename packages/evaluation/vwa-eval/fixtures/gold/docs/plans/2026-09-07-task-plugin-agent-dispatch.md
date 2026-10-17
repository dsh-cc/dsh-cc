# Seam Plugin-Agent Dispatch for the CC Task Tool — Design

Status: **Implemented** — PR #5 (merged 2026-09-07). Reviewed — deep-reasoner cold Staff-Engineer review returned
**approve-with-changes**; all five findings (scoped-registration mechanism,
colon file-def shadowing, re-entrant catalog emit, no-prefix discoverability,
plugin-def resume pins) and all four TDD gaps are folded in, and a delta
re-review confirmed resolution (the colon guard is pinned to the
file-registry discovery path only, never the shared parse layer). The Codex
blind review (GPT-5.6-sol via `codex exec`, after the CLI environment was
repaired) returned **reject** against the merged implementation — its four
findings were verified by the orchestrator and are folded in as the §9
remediation below. The divergence itself was the finding: Codex caught the
namespace-escape hole in the verbatim rule that both deep-reasoner rounds
had explicitly protected.
Date: 2026-09-07
Scope: `@dsh-cc/subagent-task` (the CC `Task` tool),
`@dsh-cc/cc-plugin-loader` (agent mounting), parity docs. No harness
(`@deepseek-ai/dsh-*`) changes.

## 1. Problem

The CC `Task` tool (`subagent_fork`, `packages/subagent/task/src/tool.ts`)
dispatches `subagent_type` over per-workspace `.claude/agents` file
definitions only. Plugin agents are a dead end: `cc-plugin-loader` already
loads a plugin's `agents/` directory into `AgentProvider`s registered on the
`subagents` seam (`packages/compat/cc-plugin-loader/src/agents.ts`), but the
Task tool cannot address them. The v1 limitation is recorded in
`packages/subagent/task/README.md` ("No plugin-agent dispatch (v1)") with two
stated blockers: the provider's start contract carries no task body, and
capability flags reject `maxDepth`.

Claude Code parity: plugin agents register with **scoped identifiers**
`plugin-name:agent-name` (subdirectories extend the namespace, e.g.
`my-plugin:review:security`) and are dispatchable through the Agent/Task tool
by that id.

## 2. Core architectural decision

**Do not route Task dispatch through `AgentProvider`. Treat the seam's
registered agent providers purely as a definition source: Task enumerates
them live, extracts each provider's `AgentDefinition`, folds it identically
to a file definition, and dispatches through the existing `spawn` provider.**

Why the provider path is unusable as-is (all load-bearing):

- `AgentProvider.start` **overwrites the delegation's `prompt` with the
  definition's `systemPrompt`** (`cc-plugin-loader/src/agents.ts:100`) — the
  Task body (`base.prompt`, `tool.ts:220`) would be destroyed. Its backend is
  hardcoded `'fork'` (agents.ts:56) with `inheritsParentContext: true`
  (agents.ts:82) — wrong semantics for Task, whose children are fresh
  conversations.
- `capabilities.depthLimit: false` (agents.ts:73) makes the seam's
  `assertCapabilities` reject `maxDepth`, which Task always sends
  (tool.ts:223).
- Background/foreground collect require `startContinuable({provider:
  'spawn', …})` (`background-start.ts:372-385, 450-461`) and
  `prepareContinuable` on the provider (`background-start.ts:227-235`) —
  `AgentProvider` has neither.

Routing via `spawn` sidesteps all of it: **no seam capability relaxation is
required**, because Task never calls `seam.start(pluginAgentName, …)`;
`maxDepth: 3` is folded into the spawn request exactly as for file defs, and
the spawn provider already passes the capability probe. Background/foreground
parity is free: `captureDefinition` is typed `AgentDefinition`
(`background-start.ts:124`) and accepts plugin definitions; `wantsBackground`
reads the `background?: boolean` frontmatter field the plugin loader already
parses. Nothing in either dispatch path keys on file origin.

Alternatives considered:

- **Alt 2 (rejected): dedicated `ccPluginAgents` service published by the
  loader, merged into `AgentRegistry`.** Decouples from the seam shape, but
  plugin mounts are effect-scoped Cordis contexts while `AgentRegistry` is a
  plain process object created in `apply()`; a service publication needs
  root-realm plumbing plus preset wiring and duplicates the registration bus.
  The seam already exposes `list()` + `getProvider` (duck-typed in
  `SubagentsLike`, `background-start.ts:81-82`) — one source of truth.
- **Alt 3 (rejected): extend `AgentProvider.start` to carry a task body +
  persona and add `prepareContinuable` forwarding.** Rejected on the defects
  above; also forces capability-matrix churn on a harness-owned contract.

## 3. Namespacing and resolution order

`mountAgents` already has an unused `namespacePrefix` option
(agents.ts:143-145). Thread it from `mountCcPlugin` using the plugin manifest
name: each provider's seam name becomes `` `${prefix}:${agentType}` ``
(sanitize the prefix: strip `:` and whitespace; if `agentType` already
contains `:`, use it verbatim — defensive against future subdirectory
nesting). Nothing dispatches to agent providers by bare name today (only
tests; skill `context: fork` uses `'fork'`,
`skill-semantics.ts:80`), so renaming registered providers is low-risk.
No-prefix behavior stays byte-identical for direct `mountAgents` consumers.

Resolution order for `subagent_type`:

1. Sentinels (`general-purpose`, `fork`).
2. Workspace file registry, exact name (unchanged).
3. Seam provider, exact name containing `:` (plugin scoped id).

A bare plugin agent name is **not** addressable — matching CC, where plugin
agents are addressed only by scoped id. (CC's "file defs shadow bundled
agents" concerns bundled agents, which here arrive via the file registry's
bundled layer, not the seam.)

**Colon hardening (review finding).** "Colon ids can never collide with
file-def bare names" is false as filed: a workspace file
`.claude/agents/p:researcher.md` yields a file definition whose `agentType`
contains `:` (`:` is a legal filename byte), which would shadow the plugin
scoped id forever (file defs resolve first) and make the id ambiguous. Fix:
the file-registry discovery path (`loadClaudeCodeAgents` / `discovery.ts`)
**warns and skips** any file definition whose `agentType` contains `:` — file
agents in CC are bare names, so such a definition is unreachable there
anyway. **Placement matters (delta-review finding):** the guard lives ONLY in
that discovery path, never in the shared parse layer (`parse.ts` /
`loadAgentsDir`), which `cc-plugin-loader`'s `mountAgents` also uses — plugin
subdirectory agentTypes legitimately carry `:` (the CC parity example
`my-plugin:review:security`), and the verbatim rule in `scopedType` depends
on them surviving the loader. Documented as a deviation in the capabilities
YAML.

## 4. Concrete changes, in implementation order

### 4.1 `packages/compat/cc-plugin-loader/src/agents.ts`

- Expose `get definition(): AgentDefinition` on `AgentProvider` (the private
  ctor field).
- **Scoped-registration mechanism (review finding — the HIGH one):** the seam
  keys registration on `provider.name`, which today is a getter over the bare
  `definition.agentType` (agents.ts:65-67). Add an optional `registeredName`
  constructor parameter that the `name` getter prefers when present, while
  `definition.agentType` stays **bare** — mutating or copying the definition
  would corrupt the Task fold that consumes it (and the `start` error
  message at agents.ts:94). Never rewrite the definition to rename the
  provider.
- In `mountAgents`: when `namespacePrefix` is provided, construct each
  provider with `registeredName = scopedType(prefix, definition.agentType)`
  via a small exported `scopedType(prefix, agentType)` helper (prefix
  sanitized: strip `:` and whitespace; an `agentType` already containing `:`
  is used verbatim — defensive against future subdirectory nesting).
  No-prefix path byte-identical for direct `mountAgents` consumers.

### 4.2 `packages/compat/cc-plugin-loader/src/index.ts`

- `mountCcPlugin` passes `namespacePrefix` derived from the manifest name
  (fall back to `options.nameHint`, then basename of `root`).

### 4.3 `packages/preset/claude-code-agents` — colon guard (review finding)

- In the **file-registry discovery path only** (`loadClaudeCodeAgents` /
  `discovery.ts`), warn and skip any definition whose `agentType` contains
  `:`, so a workspace file can never occupy or shadow the plugin scoped-id
  namespace (see §3). The shared parse layer (`parse.ts` / `loadAgentsDir`)
  is untouched — plugin subdirectory agentTypes legitimately contain `:` and
  must survive (see §3's carve-out). The skip is logged via the existing
  warn channel.

### 4.4 New `packages/subagent/task/src/plugin-agents.ts` — `PluginAgentIndex`

- Holds `ctx`; reads `ctx.get('subagents')` **lazily on every call** (plugin
  mounts are effect-scoped and may appear after `apply()`).
- `list(): { id: string; definition: AgentDefinition }[]` — `seam.list()` →
  `seam.getProvider(name)` → structural guard: function `start`, string
  `name` containing `:`, and a `definition` with string `agentType` +
  `systemPrompt`. Builtin providers (`spawn`/`fork`/…) carry no definition
  and are excluded naturally.
- `resolve(type)` — exact match on provider name.
- `knownIds()` snapshot for catalog diffing (see §4.6).
- Optional injected seam for tests (same pattern as `AgentRegistryOptions`).
- The structural guard's doc comment must state the precondition explicitly:
  **no `namespacePrefix` at mount ⇒ the agent is undiscoverable** (neither
  addressable by Task nor listed in the catalog).

### 4.5 `packages/subagent/task/src/tool.ts`

- Construct `PluginAgentIndex` (additive, defaulted parameter).
- After `registry.resolve(root, type)` misses (tool.ts:250-257), try
  `pluginIndex.resolve(type)`. On hit, **share the file-def fold**: extract
  the fold block (tool.ts:259-294) into a local
  `dispatchDefinition(definition, …)` used by both paths — persona,
  sanitized toolFilter, ccModelRoutes `agentOptions`, deferred-MCP preload,
  `wantsBackground`, `startBackground`/`collectForeground`. Zero new start
  mechanics.
- Unknown-type error: append plugin scoped ids to the available list; when
  `type` contains `:`, add the hint "plugin agent not found — the plugin may
  be unmounted or the agent renamed".
- Tool + `subagent_type` parameter descriptions: mention plugin agents
  addressable as `plugin:agent` scoped ids.

### 4.6 `packages/subagent/task/src/catalog.ts`

- `AgentCatalogSection.render` merges the registry snapshot with
  `pluginIndex.list()` (synchronous live scan, no caching) into a single
  sorted list, rendering plugin entries as `- plugin:agent — whenToUse`.
- Diff plugin ids between renders; on change fire
  `ctx.emit('system-prompt/change')` so reassembly reveals newly mounted
  plugins. **Re-entrancy hardening (review finding):** unlike `ensureDefs`,
  which emits from a promise callback, this diff runs synchronously inside
  the section `text()` callback (mid-assembly) — defer the emit
  (`void Promise.resolve().then(() => ctx.emit(...))`) so it never fires
  during assembly. Termination is guaranteed: the re-render finds no diff and
  emits nothing, so the emit chain self-stabilizes after one extra assembly;
  note this argument in the comment (or use `setImmediate` if the real
  `system-prompt/change` handler turns out to re-enter synchronously). The
  plugin-id diff state is **global** (kept on the
  section instance), not per-root like the existing `snapshot`/`seen` maps —
  plugin ids are root-independent; note the asymmetry in a comment. The
  assemble-waterfall reconciliation needs no change (the scan is
  synchronous).
- The README note "deliberately does not enumerate seam backend provider
  names" still holds for builtins — the guard is definition-presence.

### 4.7 READMEs

- `packages/subagent/task/README.md` (+`.zh.md`): remove the "No plugin-agent
  dispatch (v1)" known-limits bullet and the "Seam plugin-agent dispatch"
  roadmap item; document the scoped-id dispatch rule and resolution order in
  "How dispatch works".
- `packages/compat/cc-plugin-loader/README.md` (+`.zh.md`): agents row —
  namespaced registration, the exposed `definition`, and the explicit note
  that mounting without a `namespacePrefix` makes the agents undiscoverable
  to the Task tool (back-compat escape hatch, not a supported dispatch mode).

### 4.8 Capability manifest + parity docs

- `docs/claude-code-capabilities.yaml`, entry `subagents.task-tool`: append
  to the deviation summary — plugin agents dispatched by CC-style scoped ids
  `plugin:agent` (file definitions and scoped ids occupy disjoint name
  spaces; bare plugin names are not addressable, matching CC); plugin
  definitions enumerated live from the `subagents` seam and folded
  identically (persona, sanitized toolFilter, alias-resolved model, maxDepth
  3, background pin, deferred-MCP preload, foreground collect / background
  continuable); dispatch targets the `spawn` provider, so the AgentProvider
  fork-inheritance semantics are not used; file definitions whose `agentType`
  contains `:` are skipped with a warning so the scoped-id namespace stays
  unambiguous. Add evidence:
  `packages/compat/cc-plugin-loader/src/agents.ts`,
  `packages/subagent/task/tests/plugin-agents.spec.ts`.
- Regenerate `docs/cc-parity-matrix.md` and the README parity block with
  `pnpm docs:parity`; commit together (`pnpm check:capabilities` /
  `check:parity` gate this).

## 5. Failure modes

- Unknown `plugin:agent` → unknown-type error with the colon-aware hint.
- Seam unmounted → existing guard; catalog renders file defs only.
- Provider present but agent renamed/removed → exact-match miss → same
  unknown-type error.
- Foreign provider carrying a definition-shaped property → structural guard
  requires `start` + namespaced name + definition shape; residual risk
  documented in the guard's doc comment.
- Duplicate plugin name at the seam → `registerProvider` duplicate-name
  semantics (throw vs overwrite) are **pinned by a test** (§6 item 2), not
  left to implementation time; if it throws, the loader warns and skips.
- Plugin def whose `agentType` contains `:` → verbatim rule in `scopedType`.
- `system-prompt/change` thrash from frequent mount/unmount → mitigated by
  diffing only within `render()` (once per assembly).

## 6. Test plan (TDD, red-first)

1. `packages/compat/cc-plugin-loader/tests/mounts.spec.ts` (extend the
   `mountAgents` block): prefix produces `provider.name === 'p:researcher'`
   **while `provider.definition.agentType` stays bare `'researcher'`**
   (pins the `registeredName` mechanism); no prefix keeps bare `researcher`
   (back-compat); `provider.definition` exposed; prefix sanitized (colons
   stripped).
2. `packages/compat/cc-plugin-loader/tests/index.spec.ts` (extend; it
   already has nameHint/marketplace-overlay cases): `mountCcPlugin` threads
   the prefix for the manifest-name, nameHint-fallback, and
   marketplace-overlay paths. Include one spec pinning the seam
   `registerProvider` duplicate-name behavior (throw vs overwrite) so the
   plugin-collision failure mode is tested, not assumed.
3. `packages/preset/claude-code-agents` tests: a file def whose `agentType`
   contains `:` is skipped with a warning and never reaches the registry.
4. New `packages/subagent/task/tests/plugin-agents.spec.ts`:
   `PluginAgentIndex.list/resolve` against the existing fake-seam pattern
   (`tool.spec.ts`) plus `AgentProvider` instances from real `mountAgents`
   with a tmp plugin root; builtin providers excluded; lazy seam read (index
   created before providers register still sees them).
5. `packages/subagent/task/tests/tool.spec.ts` (extend): Task(`p:researcher`)
   folds persona/toolFilter/agentOptions/maxDepth into the recorded `spawn`
   start request; `background: true` plugin def backgrounds on omit;
   `run_in_background: true` goes through `startContinuable` with
   `provider: 'spawn'`; foreground plugin dispatch returns collected text;
   bare plugin name unresolved; unknown `p:nope` error lists plugin ids and
   carries the colon hint; file def and plugin id coexist; a backgrounded
   plugin agent's resume-pin write succeeds with the plugin definition
   (plugin `baseDir`/`source` metadata does not break the capture fake).
6. `packages/subagent/task/tests/catalog.spec.ts` (extend): section lists
   plugin agents with scoped ids; `system-prompt/change` fires (deferred,
   not mid-assembly) when the provider set changes; **unmount** — disposing
   the plugin's effect scope drops the id on the next render and fires the
   change event.
7. Optional integration: `mountCcPlugin` into the fake seam +
   `registerTaskTool` in one context, then Task dispatch end-to-end.

## 7. Verification

- Narrow: `pnpm vitest run` in `packages/subagent/task` and
  `packages/compat/cc-plugin-loader`.
- Gates: `pnpm check:capabilities`, `pnpm check:parity`, repo presubmit.
- Observable behavior (config-is-prompt): in a real session with a plugin
  shipping `agents/researcher.md`, `Task(subagent_type: "<plugin>:researcher")`
  launches a child with the plugin persona; the `Available subagents` section
  lists the scoped id.

## 8. Risks / unknowns

- The real harness seam lives outside this repo; its
  `assertCapabilities`/`prepareContinuable` contract is inferred from the
  duck-typed `SubagentsLike` and the capability-checking fake
  (`tool.spec.ts`). If `seam.list()` is not cheap or `getProvider` returns
  wrapped descriptors, `PluginAgentIndex` needs adjustment.
- `registerProvider` duplicate-name semantics (throw vs overwrite) is pinned
  by a test (§6 item 2) against the fake seam; the real harness seam's
  behavior is assumed to match — if it differs, the loader's collision
  handling needs the warn-and-skip path.
- Plugin definitions carry a plugin-root `baseDir` in resume-pin captures
  (via `preparedBackground`). No current cold-resume path re-reads `baseDir`
  expecting a workspace agents dir (checked in `resume-capture.ts`), but the
  resume path is large; §6 item 5 pins the write side.
- Whether CC normalizes scoped ids (case, subdirectories) differently than
  `scopedType` — unverified against CC source; if wrong, only the id spelling
  changes, not the architecture.
- `cc-plugin-manager` may call `mountCcPlugin` with its own `nameHint` —
  confirm the prefix it produces matches the catalog-displayed plugin name.

## 9. Addendum — Codex blind review remediation (2026-09-07)

The Codex blind review (run after implementation, against the merged code)
returned **reject** with four findings; the orchestrator verified each
against source. All four are folded into the implementation.

### 9.1 (High) Drop the verbatim rule — colon basenames are invalid everywhere

The §4.1 verbatim clause ("an agentType already containing `:` is used
verbatim") protected the CC nested-id form `plugin:subdir:agent` — but
`loadAgentsDir` scans a single directory and derives `agentType` from the
basename, so nested ids can never arise from the loader. A literal
colon-bearing basename (`agents/review:security.md`) therefore ESCAPES its
plugin's namespace: plugin `p` registers `review:security`, colliding with a
plugin named `review`. Fix:

- `scopedType(prefix, agentType)` ALWAYS produces `` `${prefix}:${agentType}` ``.
- `mountAgents` warns and skips any plugin agent whose `agentType` contains
  `:` (mirroring the file-registry colon guard), recorded in the
  `ComponentTally`. The shared parse layer (`parse.ts`/`loadAgentsDir`)
  stays permissive; the guard lives at the loader's two consumption points
  (file-registry discovery for workspace files, `mountAgents` for plugins).
  The skip is UNCONDITIONAL (Codex delta-review Low): a no-prefix
  `mountAgents` caller also loses colon-bearing agents — accepted, because a
  branded colon-named provider without a prefix would otherwise become
  Task-addressable under an ambiguous bare-colon id, defeating the disjoint
  name spaces; the back-compat escape hatch covers bare names only.
- If recursive subdirectory loading ever lands, nested ids are CONSTRUCTED
  as `prefix:sub:agent` from relative paths — never taken from basenames.
- The Unit-1 test that pinned the verbatim behavior is inverted to pin the
  skip.

### 9.2 (High) Transactional agent mounting + duplicate preflight

The real harness seam THROWS on duplicate provider names
(`deepseek-harness/packages/subagent/subagent/src/index.ts:385`). Registering
sequentially without rollback leaks partial mounts: a collision on agent N
leaves agents 1..N-1 registered while the plugin is reported failed.
Fix:

- `mountAgents` preflights each scoped name (`seam.getProvider`); a duplicate
  is recorded in the tally as failed with a reason and skipped — no throw.
- The registration loop is transactional: any throw mid-mount disposes the
  providers this call already registered, then rethrows.
- `mountCcPlugin` gets component-level rollback: if any component mount
  throws after earlier components succeeded, their disposers run before the
  error propagates, so a failed plugin leaves nothing mounted.

### 9.3 (Medium) Event-driven catalog invalidation

The render-time diff can only fire when an assembly already happens — a
mount/unmount during quiet time never triggers reassembly — and same-id
`whenToUse` changes are invisible to an id-only diff. The real seam emits
`subagent/provider-added` / `subagent/provider-removed`. Fix:

- `PluginAgentIndex` (or the catalog apply) subscribes to those events;
  when the added/removed provider passes the brand guard (§9.4), it emits
  `system-prompt/change` directly (no render involvement, no deferral
  needed — the emit is not mid-assembly). Re-registration of a changed
  definition surfaces as remove+add, so fingerprints are unnecessary.
  Because the removed event carries only a NAME, brand membership is tracked
  in a `brandedIds` set — **seeded from the live index at listener startup**,
  since production mounts cc-shell-glue before subagent-task and initial
  providers' add events predate the listener (Codex delta-review catch,
  verified by its runtime probe).
- `AgentCatalogSection.render` becomes side-effect-free: it renders the
  current `pluginIndex.list()` and nothing else (the diff-state machinery
  and deferred emit are removed).
- Verify at implementation time that provider-lifecycle events are
  deliverable inside the preset's isolate realm; if they are not, fall back
  to the render-time diff (kept as the deviation note) and record the realm
  boundary as the reason. **Verified**: delivery works through the shared
  cordis bus (catalog.spec realm-delivery test).

### 9.4 (Medium) Brand the definition-source providers

The structural guard (start fn + colon name + definition shape) is an
accidental protocol — any foreign provider with those properties would be
adopted as a plugin agent. Fix: the loader stamps `AgentProvider` with an
exported brand (a `Symbol.for`-keyed property or an explicit
`definitionSource: 'cc-plugin'` marker), and `PluginAgentIndex`'s guard
REQUIRES the brand in addition to the existing shape checks.
