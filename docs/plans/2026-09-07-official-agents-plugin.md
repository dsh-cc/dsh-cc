# Official `dsh-cc-agents` Plugin — deep-reasoner + fast-worker as a Loadable Plugin

Status: reviewed — blind parallel review by a fresh deep-reasoner
(**approve-with-changes**) and Codex (**reject**, 6 findings), all folded;
delta re-reviews by both (**approve-with-changes** each) confirmed the folds,
and their remaining minor items (advisory-safety wording for deep-reasoner's
Bash, aggregate boot-log observable, testable release planner, skill
visibility assertion) are folded in turn. The divergence itself was the
finding: Codex (correctly) overruled keeping `background: true` on the
distributed fast-worker and refuted the preset-cc dependency claim, which
deep-reasoner had recommended.
Date: 2026-09-07
Scope: new content package `packages/plugin/dsh-cc-agents`, a monorepo-root
plugin marketplace manifest, release/publish wiring, parity docs. Builds on
the seam plugin-agent dispatch that landed in PR #5 (b237854).

## 1. Problem

`deep-reasoner` and `fast-worker` exist only as this repo's workspace agents
(`.claude/agents/`). With PR #5 merged, the CC Task tool dispatches plugin
agents by scoped id (`plugin:agent`), folding them exactly like file
definitions. Shipping the two agents as an official, installable plugin makes
them available to every dsh-cc user without copying files — and without
bundling them into the default surface (rejected earlier: they encode a
workflow contract and assume alias config).

## 2. Design

### 2.1 Packaging — new content package `packages/plugin/dsh-cc-agents`

CC-plugin content, not a cordis preset, so it does NOT go under
`packages/preset/cc` (whose `files` is a closed yml/md list,
`packages/preset/cc/package.json:15-20`). Layout:

```
packages/plugin/dsh-cc-agents/
├── package.json                  # @dsh-cc/plugin-dsh-cc-agents, private: false,
│                                 # files: [".claude-plugin/plugin.json", "agents", "skills", "README.md"]
│                                 # publishConfig.access: "public", repository.url, license
│                                 # (check-publish-manifests.mjs asserts all three)
├── .claude-plugin/plugin.json    # { name: "dsh-cc-agents", version: <pkg version>, description }
├── agents/deep-reasoner.md       # adapted, §2.3
├── agents/fast-worker.md         # adapted, §2.3
├── skills/dsh-cc-agents-orchestration/SKILL.md  # unique dir name (review fix), §2.3
└── README.md                     # prerequisites (aliases), scoped ids, usage, update flow
```

The manifest name is the namespace prefix (sanitized by `scopedType`,
`cc-plugin-loader/src/agents.ts:168`): users address
`dsh-cc-agents:deep-reasoner` / `dsh-cc-agents:fast-worker`.

**Release wiring (review finding — BOTH reviewers caught this):**
`scripts/release.mjs` discovers only `packages/<group>/<pkg>/package.json`
(`release.mjs:92-120`) and never touches a nested `.claude-plugin/plugin.json`.
Since `updatePlugin` no-ops when the marketplace-declared version equals the
installed entry (`cc-plugin-manager/src/update.ts:50-57`), a stale plugin.json
makes `/plugin update` a permanent no-op for every user. Hard work items:

1. Extend `release.mjs` to also rewrite the version in every publishable
   package's `.claude-plugin/plugin.json` (when present) — extract the
   walk/version-write planning into an EXPORTED pure function (mirroring
   `check-publish-manifests.mjs`'s testable structure; the CLI entry
   self-executes git validations and is not CI-testable as-is). The gate
   covers the nested manifest only — the manager's legacy top-level
   `plugin.json` fallback (`install.ts:54`) is out of scope (this package
   ships nested only).
2. Extend `check-release-version.mjs` (or the publish gate) to assert
   package.json == plugin.json == tag equality, so drift fails the gate.
3. Regression test: a version bump makes `/plugin update` materialize a new
   cache directory (via installPlugin/updatePlugin deps injection).
4. Verify `check-release-version.mjs` / `check-deep-src-imports.mjs` tolerate
   a content-only package (no src/lib).

The package is published standalone on npm (the marketplace flow in §2.2-A is
primary and needs no npm artifact). **Do NOT wire it as a dependency of
`@dsh-cc/preset-cc`** (Codex finding): preset-cc is `private: true` and the
published TUI stages only the preset's yml files
(`ui/tui/scripts/stage-preset.mjs`), so a dependency edge would NOT carry the
artifact into installed deployments. The pluginDirs escape hatch (§2.2-B)
points at any local checkout or a standalone npm install of the package.

### 2.2 Loading — official marketplace on this monorepo (recommended)

Grounded trace: cc-shell-glue mounts `CcPluginsService`
(`bundle/cc-shell/src/index.ts:109-121`); default discovery is
installed ∩ enabled under `$CLAUDE_CONFIG_DIR`/`~/.claude`
(`cc-plugin-loader/src/discovery.ts`); the plugin manager accepts a
marketplace whose plugins declare a string relative-directory source
(`cc-plugin-manager/src/resolve-id.ts:79-107`; source classification in
`marketplace.ts:82-97`) and installs by copying the plugin dir into the
`~/.claude/plugins` cache (`install.ts` `materializeCacheDir`). **No loader
code change is needed.**

- **(A) Winner — monorepo marketplace.** Root `.claude-plugin/marketplace.json`:
  `{ "name": "dsh-cc", "plugins": [{ "name": "dsh-cc-agents", "source": "./packages/plugin/dsh-cc-agents" }] }`.
  User flow: `/plugin marketplace add dsh-cc/dsh-cc` →
  `/plugin install dsh-cc-agents@dsh-cc` → restart. Clone weight is measured
  and a non-issue: the monorepo packs at ~4 MiB (size-pack 4.15 MiB).
  CC parity: CC ships no bundled plugins; it auto-adds the official
  marketplace `claude-plugins-official` at first launch and installs are
  explicit — option A mirrors that exactly (context7, code.claude.com/docs
  plugins reference).
  **Update flow (Codex finding):** `/plugin marketplace update dsh-cc` only
  re-pulls the marketplace clone (`marketplace.ts:265-286`); the installed
  plugin cache updates only via the SEPARATE `/plugin update
  dsh-cc-agents@dsh-cc` (`update.ts:50-68`). Document the two-command flow in
  the plugin README; never claim updates ride the marketplace re-pull alone.
- **(B) pluginDirs into a local copy** (repo checkout or standalone npm
  install of `@dsh-cc/plugin-dsh-cc-agents`) — works today, but the knob is
  composition-level config unreachable from the CLI; document as advanced.
- **(C) settings flag / auto-mount** — new glue code, diverges from CC (CC
  never auto-installs plugins). Rejected as default; a parity-correct
  follow-up is pre-registering the `dsh-cc` marketplace on first launch.
- **Not done**: the plugin declares no MCP servers (the loader's `mcp.ts`
  supports it, but an official plugin should not couple to third-party
  servers).

### 2.3 Definition adaptation for distribution

- **background pin — SPLIT (Codex finding, divergent from the design draft;
  Codex's position wins).** Keep `background: true` on **deep-reasoner**
  (read-only; backgrounding is safe, explicit `run_in_background` always wins
  over the pin). DROP the pin from the distributed **fast-worker**: it
  mutates the tree, `isolation: worktree` is not wired through the Task path,
  and the pin's safety guardrail in this repo is a CLAUDE.md policy that does
  NOT travel with the plugin. A mutating agent must default to foreground so
  the orchestrator verifies before composing; users who want hands-free
  workers pass `run_in_background: true` explicitly. The orchestration skill
  states this asymmetry. **Advisory-safety honesty (delta-review finding):**
  deep-reasoner retains `Bash` (for read-only verification), so its
  read-only nature is a PERSONA CONTRACT, not an enforced capability — the
  README and skill must say exactly that; nothing stops a misbehaving
  backgrounded reasoner from running a mutating command.
- **model aliases — keep `opus`/`sonnet`.** Unconfigured aliases resolve to
  inherit-the-parent-route (`cc-model-aliases/src/resolver.ts`), so nothing
  breaks; lane separation is just lost until configured. Document the
  prerequisite; soften descriptions ("Spawns on Opus when the opus alias is
  configured").
- **MCP tool references — strip, with the corrected rationale (both
  reviewers).** All `mcp__serena__*`, `mcp__sequential_thinking__*`,
  `mcp__context7__*` entries come out of the frontmatter `tools:` lists. The
  real reason: the Task path sanitizes unknown names at execute time
  (drops + warns), but the DIRECT seam path (`AgentProvider.start`) overlays
  the raw `toolRestriction` unsanitized and can fail in the backend — an
  official plugin must be portable across both. Core tools only:
  deep-reasoner `[Bash, Read, Grep, Glob]`; fast-worker `[Bash, BashOutput,
  KillBash, Read, Write, Edit, Glob, Grep, TodoWrite, NotebookEdit]` (every
  name verified against CC_TO_HARNESS_TOOLS). Persona text keeps the
  fallback guidance (serena-first → Read/Grep/Edit).
- **Persona text — genericize.** "the orchestrator (Fable)" → "the
  coordinating agent"; drop references to this repo's routing table; keep
  strengths / how-to-work / output contract (that is the value). The
  selection-driving frontmatter key is `description` (not `whenToUse`) —
  give the plugin copies distinct wording ("official plugin build") so a
  workspace file def of the same agent is distinguishable in the catalog.
- **Orchestration guidance ships as a skill — with a unique directory name
  (Codex finding).** Plugin skill identity is the directory BASENAME and
  runtime duplicates are first-wins with a silent warn, so `orchestration`
  is collision-prone. Ship `skills/dsh-cc-agents-orchestration/SKILL.md`,
  carrying the genericized routing table with the EXACT scoped ids
  (`dsh-cc-agents:deep-reasoner` / `dsh-cc-agents:fast-worker` — plugin
  agents resolve only by exact scoped id), the background asymmetry above,
  and the report contracts. A skill is model-invocable by default; plugins
  cannot inject CLAUDE.md. **Skill activation must be verified**
  (deep-reasoner finding): `mountSkills` silently tallies "skipped" when the
  skills seam probe misses from the glue fiber inside the cc-services
  isolate realm — add a test asserting the skills component LOADS (not
  skips) and a §6 observable.

## 3. Failure modes

- Alias unconfigured → inherit parent route (documented, not a failure).
- MCP servers absent → moot after stripping mcp__ names (portability across
  the unsanitized direct-seam path is the reason, §2.3).
- Plugin disabled mid-session → effect-scoped providers disappear; the
  event-driven catalog invalidation (PR #5 remediation) drops the ids;
  `/plugin` re-enable + rescan is the recovery path.
- Name collision → workspace `.claude/agents/deep-reasoner.md` (bare) and
  `dsh-cc-agents:deep-reasoner` (scoped) are disjoint per the PR #5
  resolution order; both appear in the catalog. Document the mapping; the
  plugin copies carry distinct `description` wording.
- Second installed plugin with the same manifest name → identical
  `dsh-cc-agents:*` provider ids compete; the duplicate preflight (PR #5
  remediation) skips the later registration with a tally reason. Documented
  behavior, not a crash.
- Marketplace clone weight → measured: ~4 MiB pack for the whole monorepo.
  Non-issue; the tiny-repo split is dropped from consideration.
- Update flow confusion → the README documents the two-command flow
  (`/plugin marketplace update dsh-cc` + `/plugin update
  dsh-cc-agents@dsh-cc`); a marketplace re-pull alone does NOT refresh
  installed caches.

## 4. Capability manifest + parity docs

No new CC-surface: the mechanism is already covered by `plugins.loader` and
the task-tool scoped-id entry in `docs/claude-code-capabilities.yaml`.
Updates: note that a first-party plugin exercises the path end-to-end, and
mention the official `dsh-cc` marketplace in the plugins category summary.
`pnpm check:capabilities` + `pnpm docs:parity` in the same commit.

## 5. Test plan (TDD, red-first)

1. `cc-plugin-loader/tests/mounts.spec.ts` (or a new spec): `mountCcPlugin`
   on the real `packages/plugin/dsh-cc-agents` dir → providers register as
   `dsh-cc-agents:deep-reasoner` / `dsh-cc-agents:fast-worker` (branded,
   scoped); deep-reasoner's background pin folds and fast-worker has NO pin;
   the toolFilter sanitizes cleanly with a minimal tool set; an unconfigured
   alias resolves to inherit (no agentOptions); **the skills component
   LOADS (tally loaded, not skipped)** — and because a tally alone does not
   prove visibility (delta review: a duplicate name can register as a silent
   no-op), a real-registry `list/get` assertion finds
   `dsh-cc-agents-orchestration` with `invocation.modelInvocable === true`.
2. `subagent/task/tests/plugin-agents.spec.ts`: end-to-end Task dispatch of
   `dsh-cc-agents:deep-reasoner` mounted from the real plugin dir; catalog
   lists both scoped ids.
3. Package shape via `pnpm pack --dry-run --json` (Codex: inspect the packed
   file list, don't just assert the `files` array): plugin.json + agents +
   skills + README all present in the tarball.
4. Version lockstep: executable equality check between `package.json` and
   `.claude-plugin/plugin.json` versions, a direct unit test of release.mjs's
   EXPORTED pure planner (no git side effects), and the `/plugin update`
   regression test (§2.1 item 3).
5. Marketplace manifest: `.claude-plugin/marketplace.json` parses and its
   `source` resolves to an existing directory.
6. Install round-trip: install → discovery → mount from the git-clone→cache
   copy (not the repo working dir), so a forgotten `git add` of a shipped
   file fails CI (deep-reasoner gap (b)).

## 6. Verification (config-is-prompt)

Real-session recipe after release: install dsh-cc →
`/plugin marketplace add dsh-cc/dsh-cc` → `/plugin install dsh-cc-agents@dsh-cc`
→ restart. Observables: the boot log is an AGGREGATE per plugin
(`cc-plugin <name>: N loaded/M skipped`, `bundle/cc-shell/src/index.ts:122`)
so the expected line is `cc-plugin dsh-cc-agents: 3 loaded / 0 skipped`
(2 agents + 1 skill; a silently skipped skill shows as `2 loaded / 1
skipped`), and `/plugin` shows per-component counts as a cross-check; the
Available subagents section lists both scoped ids;
`Task(subagent_type: "dsh-cc-agents:deep-reasoner", …)` returns a report
ending in the output contract; with `opus`/`sonnet` configured the children
route accordingly; `/plugin disable` + rescan removes the ids and the scoped
id errors cleanly. Pre-release, verify the same flow against the worktree
(pluginDirs or a local marketplace path).

## 7. Risks / unknowns

- Whether the skills seam resolves from the glue fiber inside the
  cc-services isolate realm in the real composition — the pre-release
  worktree check (§6) must include the skills observable; the unit test
  (§5.1) pins the tally.
- npm tarball coverage of `.claude-plugin/plugin.json` — pinned by the
  `pnpm pack --dry-run --json` test (§5.3); `check:publish` validates
  manifest metadata but not packed files.
- The repo's default branch must carry the root marketplace.json before any
  user runs the add command — true post-merge; call it out in the release
  note.
- The runtime-skill registration semantics rest on the loader's own tests;
  the upstream `@deepseek-ai/dsh-skill` source was not inspected.
