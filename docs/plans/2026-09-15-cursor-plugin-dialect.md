# Cursor Plugin Dialect Support in cc-plugin-loader

Date: 2026-09-15. Status: **Implemented** — PR-A #72 (S0–S3, dialect discovery/manifest/report), PR-B #73 (S4–S5, rules guest seam + cc-shell bridge), PR-C #74 (S6, manager dialect + full e2e); all three merged 2026-09-15. Design was critic-reviewed twice (approve-with-amendments, then confirm);
amendments baked in. Ground-truth anchors verified against the cursor-plugins-support
worktree source during review; remaining line numbers re-verified in-slice.

## 1. Problem and goals

dsh-cc's plugin system (`packages/compat/cc-plugin-loader` + `cc-plugin-manager`) is a
Claude Code–compatible loader: it discovers `.claude-plugin/plugin.json` (nested preferred,
top-level legacy fallback), mounts the six CC components (skills / agents / commands /
hooks / mcpServers / settings), and sources marketplaces from directories, GitHub shorthands,
and git URLs.

Cursor published its own plugin spec (github.com/cursor/plugins, `schemas/plugin.schema.json`)
that is deliberately a dialect of the Claude Code format: the same component conventions
(`skills/<name>/SKILL.md`, `agents/*.md`, `commands/*.md|txt`, `hooks/hooks.json`, MCP
servers), the same nested-manifest layout with a renamed directory
(`.cursor-plugin/plugin.json`, repo-level `.cursor-plugin/marketplace.json`), plus two
genuine extensions:

1. a `rules/*.mdc` component (frontmatter: `description`, `alwaysApply`, `globs`) — no CC
   counterpart;
2. marketplace-flavored manifest metadata (`displayName`, `publisher`, `homepage`,
   `repository`, `license`, `logo`, `keywords`, `category`, `tags`, `minClientVersions`,
   `variables`) — the loader's tolerant parser already ignores these.

Goal: one loader serves both dialects. A Cursor marketplace repo or plugin directory mounts
through the same machinery with no translation layer and no plugin-author changes, and every
Cursor-specific semantic we cannot honor faithfully is surfaced in the structured load
report as a warning or skip — never silently dropped.

Non-goals (v1): runtime file-matching activation of glob-scoped rules; interactive
collection of manifest `variables`; `minClientVersions` gating; scanning Cursor's own
`~/.cursor/plugins/local/` tree (Cursor plugins enter dsh-cc through dsh-cc's own
directory/git/GitHub sources); managed settings.

## 2. Verified ground truth

Loader (`packages/compat/cc-plugin-loader`):

- `src/discovery.ts:50/:53` — manifest path constants: `NESTED_MANIFEST`
  (`.claude-plugin/plugin.json`) preferred, `TOP_LEVEL_MANIFEST` (`plugin.json`) legacy.
  `discoverCcPluginRoots` (:60) intersects the enabledPlugins cascade
  (claude-user → dsh-user → project → local) with `installed_plugins.json` across dual
  homes; `pluginDirs` flattening at :94+.
- `src/resolve-manifest.ts:36-42` — resolution chain: nested → top-level →
  `.claude-plugin/marketplace.json` overlay via nameHint (:44-63) → synthesized `{name}`.
  The marketplace lift moves only a fixed key list; extra manifest fields are dropped
  before mount.
- `src/manifest.ts` — tolerant schema in `parsePluginManifest` (:28-57): `name` required
  and validated (`readName` :72-81); `commands` accepts path / list / map
  (`normalizeCommands` :83-95); `agents`/`skills` paths or lists; `mcpServers` path or
  object; `hooks` inline or path; unknown top-level keys ignored.
- `src/index.ts:105` `mountCcPlugin` mounts skills → agents → commands → hooks →
  mcpServers → settings (:109-139); each mount is a Cordis effect; a missing guest seam
  tallies `skipped`, never a load failure.
- `src/seams.ts` — guest-seam pattern; `HooksSeam.mergePluginHooks` at :29. The hooks
  bridge (PR #16) provides it unconditionally with copy-on-write merge; the mcp seam
  landed via `packages/bundle/cc-shell/src/mcpSeam.ts` + `ccPlugins.ts` (PR #8:
  `buildRegistrations` + `ctx.plugin(CcMcpClient)` idiom). Both seams anchor in
  `packages/preset/cc/agent.cordis.yml:338-341` under group isolation.
- `src/commands.ts:81`, `src/skills.ts:29`, `src/agents.ts:154`, `src/hooks.ts:32`
  (`hooks/hooks.json`). Agents append the default `agents/` dir to manifest paths
  (documented CC divergence).
- Load report per plugin already carries a `skipped` tally with human-readable reasons;
  there is no separate `warnings` array today (review finding #1).
- Zero cursor-related code in the tree today.

Manager (`packages/compat/cc-plugin-manager`):

- `src/types.ts:11-17` — MarketplaceSource union: directory | GitHub shorthand | git URL;
  `src/marketplace.ts:93-104` classification (`classifySource` :95-104).
- State files (`known_marketplaces.json`, `installed_plugins.json` v2, per-scope
  `enabledPlugins`) are byte-compatible with CC v2.1.236 (probe-verified,
  docs/plans/2026-09-06-plugin-management.md); cache layout `cache/<mkt>/<plugin>/<version>`;
  dual-home cascade with dsh-wins merges (docs/plans/2026-09-07-plugin-dsh-home-cascade.md).

Cursor spec (github.com/cursor/plugins + `schemas/plugin.schema.json`, verified 2026-09-15):

- Manifest `.cursor-plugin/plugin.json`; only `name` is required. Component path fields
  (`commands`/`agents`/`skills`/`rules`) accept glob patterns; `mcpServers` accepts a path,
  an inline object, or an array of either; `hooks` accepts a path or an inline object;
  repo-level `.cursor-plugin/marketplace.json` lists plugins as `{name, source, metadata}`.
- Default component discovery paths and frontmatter contracts match CC
  (`skills/<n>/SKILL.md` name+description; `agents/*.md`; `commands/*.md|txt`;
  `rules/*.mdc` description/alwaysApply/globs; `hooks/hooks.json`). The official
  third-party example (`third_party/github`) uses `mcpServers: "./mcp.json"` plus a
  `variables` JSON Schema.

## 3. Design

### 3.1 Dialect detection — no configuration

Manifest lookup becomes an ordered candidate list; the first hit wins:

1. `.claude-plugin/plugin.json` (unchanged; existing behavior stable when both exist)
2. `.cursor-plugin/plugin.json` (new)
3. top-level `plugin.json` (legacy fallback)

The marketplace overlay is symmetric: `.claude-plugin/marketplace.json`, then
`.cursor-plugin/marketplace.json`. The resolver records `flavor: 'cc' | 'cursor'` on the
parsed manifest — an internal, resolver-injected field like `skillsReplaceDefault`, not an
author field. Flavor propagates to the load report (`report.plugins[n].flavor`), to the
per-component mounts where dialect matters (§3.2, §3.5), and to the `/plugin` listing
so users can tell which dialect a plugin speaks.

Precedence is never silent: when both nested manifests exist, the CC manifest wins AND the
report records a warning ("cursor manifest ignored: cc manifest takes precedence") —
honoring the plan-level rule that nothing is silently dropped.

Rationale for auto-detection over an explicit `flavor` option: zero UX change on the CC
happy path; the precedence order is documented and deterministic; fixtures force either
dialect simply by laying out the candidate dir they exercise.

### 3.2 Component mapping — the unchanged five

skills, agents, commands, hooks, mcpServers reuse the existing mounts. Flavor-keyed deltas:

- commands: Cursor permits `*.txt` sources; the commands glob accepts `.txt` when flavor is
  `cursor`. Whether Cursor's `.txt` files carry frontmatter is confirmed by an S2 fixture
  rather than assumed.
- mcpServers: the Cursor schema's array form (`path | inline | array of either`) is
  flattened into the existing path-or-object handling during normalization. `mcp.json`
  files use the standard `{"mcpServers": {...}}` shape mountMcpServers already parses.
- `variables`: v1 does not prompt. Decided semantics (review finding): an unresolved
  `${VAR}` reference inside a cursor plugin's MCP config fails THAT server with a warning
  naming the missing variable — never fails the whole plugin, never silently interpolates
  an empty string.
- OAuth stays documented-unsupported.

### 3.3 New component: rules (.mdc) — guest seam `rules`

Follow the hooks/mcp seam precedent instead of special-casing inside the loader:

- `seams.ts` gains an optional guest seam `rules` exposing
  `mergePluginRules(pluginName, entries: RuleEntry[])`; copy-on-write merge, fully disposed
  on plugin unload (mirrors the PR #16 hooks semantics, including its leaked-services
  variant test).
- `RuleEntry = { path, description, alwaysApply, globs, body }`.
- `src/rules.ts` (new): default discovery `rules/**/*.mdc`; manifest `rules` paths follow
  the same append-default-dir convention as agents; missing seam tallies
  `skipped: rules seam "rules" is not mounted`.
- Frontmatter: `.mdc` carries `alwaysApply` (boolean) and `globs` (a YAML LIST, inline or
  block form) — unlike skills/commands frontmatter, which is string-only. The slice budgets
  EXTENDING the shared frontmatter helper with typed (boolean/list) fields; if the existing
  helper cannot be extended cleanly, introduce one shared typed-frontmatter parser and
  migrate skills/commands reads to it — never a second YAML-frontmatter dialect.
- Provider: a bridge in `packages/preset/cc/**` provides the seam and renders entries into
  system-prompt segments:
  - `alwaysApply: true` → static segment "Rules from plugin <name>: <body>".
  - glob-scoped entries (v1 documented degradation) → static conditional-instruction
    segment: "When editing files matching <glob>: <body>". No runtime file-matching
    activation in v1; a file-event-driven activation layer is an explicit follow-up
    candidate, additive rather than a redesign.
  - `globs: []` with falsy `alwaysApply` → generic guidance segment + report warning.

### 3.4 Manifest schema evolution — one tolerant parser, both dialects

- New `rules` field: stringOrArray; a map form is rejected with a clear error (the Cursor
  schema has no map form).
- Glob-valued component paths (Cursor allows glob patterns; CC takes literals):
  - Values of the "directory-recursive" form (`agents/**`, i.e. ending in `/**`) are
    expanded cheaply in v1 using the existing directory walk — deliberately cheap because
    refusing them would drop the entire component set of plugins that declare the common
    `"/**"` shape.
  - Any other glob metacharacters are NOT expanded in v1: the entry is tallied as skipped
    with a warning that `/plugin` surfaces prominently (review finding: buried warnings are
    the failure mode to avoid). General glob expansion (with a chosen glob lib and a
    traversal-safety policy) is a named follow-up.
- Cursor metadata fields (`displayName`/`publisher`/`homepage`/`repository`/`license`/
  `logo`/`keywords`/`category`/`tags`): parsed and ignored (tolerant parser); a fixture
  asserts the bytes survive resolution untouched for the report.
- `minClientVersions`: parsed, ignored, warning "client-version gating is not enforced".
- `variables`: parsed, warning "plugin variables are not prompted; set values via
  environment" plus the §3.2 unresolved-reference behavior.
- Report structure (review finding #1, decided up front — the draft had this as an open
  question): add a first-class per-plugin `warnings: string[]` on the load report. The
  existing skipped-reasons array keeps its current "skipped/failed" semantics and is NOT
  reused for warnings. S2 therefore includes updating downstream consumers of the report
  (cc-shell `ccPlugins.ts` aggregation and command-plugin `/plugin` rendering) in the same
  slice; typecheck then proves no consumer was missed.
- Warning attachment point (review finding): warnings are produced during manifest parse /
  resolution and travel ON the parsed manifest object, so they survive the marketplace
  overlay's fixed-key lift (which otherwise drops fields before mount).

### 3.5 Hooks dialect — probe FIRST, not last

PROBE VERDICT (2026-09-15, S0): DIVERGENT — Cursor's hooks.json vocabulary is a camelCase
superset that only partially overlaps CC semantics; a flavor-keyed mapping table in
`hooks.ts` is required. Unmapped events tally as skipped warnings.

- CC inventory (source of truth: `packages/hooks/hooks-claude-code/src/config.ts`
  `CLAUDE_EVENTS`, consumed by the loader's hooks mount): SessionStart, UserPromptSubmit,
  PreToolUse, PostToolUse, Stop, SubagentStart, SubagentStop, PermissionRequest,
  PermissionDenied, Notification, PostCompact, SessionEnd, StopFailure, TaskCreated,
  TeammateIdle, Setup, PostToolUseFailure, SessionResume, WorktreeCreate, WorktreeRemove.
- Cursor inventory (source: https://cursor.com/docs/agent/hooks + official hooks.json in
  cursor/plugins `ralph-loop` and `advisor`; cross-checked, two independent sources):
  sessionStart, sessionEnd, preToolUse, postToolUse, postToolUseFailure, subagentStart,
  subagentStop, beforeShellExecution, afterShellExecution, beforeMCPExecution,
  afterMCPExecution, beforeReadFile, afterFileEdit, beforeSubmitPrompt, preCompact, stop,
  afterAgentResponse, afterAgentThought, plus Tab (beforeTabFileRead, afterTabFileEdit)
  and app (workspaceOpen) hooks; wire shape `{"version":1,"hooks":{<event>:[{"command",
  "matcher"?, "loop_limit"?}]}}` with `${CURSOR_PLUGIN_ROOT}` substitution.
- Mapping table (cursor → CC): sessionStart→SessionStart; sessionEnd→SessionEnd;
  preToolUse→PreToolUse; postToolUse→PostToolUse; postToolUseFailure→PostToolUseFailure;
  subagentStart→SubagentStart; subagentStop→SubagentStop; beforeSubmitPrompt→
  UserPromptSubmit; preCompact→PreCompact (CC emits PostCompact too — map Cursor's single
  compaction hook to the observed boundary the bridge supports); stop→Stop;
  afterAgentResponse/afterAgentThought→no CC equivalent (skipped warning);
  beforeShellExecution/afterShellExecution/beforeMCPExecution/beforeReadFile/afterFileEdit→
  no CC equivalent (skipped warning; CC models these as matcher-scoped PreToolUse/PostToolUse,
  so a later slice MAY map beforeShellExecution→PreToolUse matcher `Bash` etc. — deferred,
  not in the S-later mapping table's required set); Notification, PermissionRequest,
  PermissionDenied and the remaining CC-only events have no Cursor source (harmless —
  cursor plugins simply never emit them).
- Fixture pack (the S0 deliverable every later slice consumes):
  `packages/compat/cc-plugin-loader/tests/fixtures/cursor/` — `minimal/` (default-layout
  plugin exercising all inventoried event names in hooks/hooks.json, skills/agents/
  commands .md+.txt/mcp.json/rules .mdc inline+block globs), `declared-paths/` (manifest
  declares component paths incl. `agents/**`), `github-mcp/` (third_party/github shape:
  mcpServers "./mcp.json" + variables JSON Schema + metadata fields), `dual-manifest/`
  (both dialect manifests present).

The hooks seam contract (`mergePluginHooks`) and its bridge stay unchanged either way.

### 3.6 Manager dialect support

cc-plugin-manager reads `.claude-plugin/marketplace.json` at add/update and plugin
manifests at install/enable. The §3.1 candidate-dir support lands in ONE shared helper used
by loader and manager both — a second dialect-selection copy in the manager would guarantee
skew. No state-file shape changes: `known_marketplaces.json` / `installed_plugins.json` v2
keep their CC byte-compatible formats, cursor marketplaces stored under the same schema
keyed by marketplace name; cache layout unchanged; C5 uninstall guard and the dual-home
cascade untouched.

Enable/disable + rescan flows (review finding): the installed-plugins key and the
directory-shape discovery must agree after dual-manifest support lands, and `rescan()`
disposes and remounts everything, so S1 ships fixtures covering enable → disable → rescan
round-trips for cursor-flavored plugins under both homes (`CLAUDE_CONFIG_DIR` and
`DSH_HOME` both seeded to tmp — house rule).

A repo containing BOTH dialect dirs: the marketplace manifest is selected with §3.1
precedence, the report warning records it, and the README documents the choice.

### 3.7 Capability manifest discipline

Per AGENTS.md, loader/manager/preset changes update `docs/claude-code-capabilities.yaml`
in the same commit and regenerate with `pnpm docs:parity`; `pnpm check:capabilities` and
`check:parity` gate presubmit. Anticipated entries:

- `plugins.loader`: upstream block gains the cursor-dialect note.
- New `plugins.rules` row. Validator invariants respected: it anchors in
  `packages/preset/cc/agent.cordis.yml` (I4); sorted within the category (I7);
  `behavioral: divergent` (glob activation degraded to conditional instructions) which
  caps `ux` at `partial` (I3). Per-plane honesty (review finding): `plugins.rules` is
  mounted on the cc preset plane only; consumer environments outside preset/cc get the
  seam's documented absent-behavior (skipped tally), and the row says so.
- `plugins.management` gains a dialect-tolerance note without changing byte-shape claims.

### 3.8 Naming

Package and seam names stay (`cc-plugin-loader`, `cc-plugin-manager`) — "cc" here means
the Claude-Code-compatible lineage the Cursor spec deliberately mirrors; renames are churn
without behavior value. The loader README gains a "Cursor dialect" section in PR-A.

## 4. Rejected alternatives

- **A separate `cursor-plugin-loader` package.** The dialect delta is ~manifest candidates
  + one component + small normalizations. Two loaders guarantee skew between dialects; a
  single tolerant parser with flavor-keyed branches keeps ~95% shared and every delta
  greppable.
- **Translating cursor plugins into `.claude-plugin` layout at install time.** Mutates user
  content, loses provenance, and fights marketplace update flows (cache rewrites).
  Pass-through loading is strictly better on every axis.
- **Runtime glob-activated rules in v1** (file-open/edit watch injecting rules). Real value
  but a distinct subsystem (file-event subscriptions, per-turn prompt budgeting). The v1
  conditional-instruction rendering preserves author intent textually; the follow-up is
  additive.
- **Gating on `minClientVersions`.** dsh-cc would need a meaningful client-identity story
  ("dsh" vs "cursor" vs "claude" tokens), which is its own design. Warning-only keeps
  behavior honest without inventing an identity format.

## 5. Slices (TDD; each slice lands tests + typecheck green before the next)

PR-A — Dialect discovery & manifest plumbing:

- S0 (moved up by review): hooks dialect probe — inventory Cursor hooks.json event names
  from official shapes, decide pass-through vs mapping table, commit the fixture pack that
  every later slice consumes. No runtime code.
- S1: candidate dirs + symmetric marketplace overlay + flavor recording in
  discovery.ts / resolve-manifest.ts (shared helper exported for the manager);
  fixtures: minimal cursor plugin, dual-manifest precedence with the report warning,
  top-level fallback unchanged, and enable/disable/rescan round-trips under both homes.
  (The precedence-warning fixture asserts the warning as carried on the parsed manifest in
  S1; report-level assertions follow in S2 once the `warnings` array exists.)
- S2: manifest.ts `rules` field, mcpServers array form, `minClientVersions`/`variables`
  warnings, unresolved-`${VAR}` server-failure semantics, `/**`-globs + skip-warning
  policy, command `.txt` acceptance on cursor flavor — PLUS the §3.5 hooks mapping table
  in `hooks.ts` keyed by flavor (unmapped events → skipped warnings), and the new
  per-plugin `warnings: string[]` on the load report and its downstream consumers
  (cc-shell aggregation, `/plugin` rendering incl. flavor display).
- S3: e2e fixture pack mirroring cursor/plugins official shapes (a
  skills+agents+commands plugin; the github MCP plugin shape) mounted via a directory
  source in isolated homes; report tallies, warnings, and `/plugin` output asserted.

PR-B — Rules component:

- S4: seams.ts `rules` guest seam + src/rules.ts + tally/report wiring; frontmatter helper
  typed-field extension (or the single shared typed parser).
- S5: preset/cc bridge renders segments (alwaysApply + conditional), anchored in
  agent.cordis.yml; disposal/merge semantics copied from the hooks seam tests
  (copy-on-write variant, intra-group order).

PR-C — Manager dialect:

- S6: manager switches to the shared candidate-dir helper; marketplace
  add/update/install/enable flows over a cursor-flavored test marketplace; byte-shape
  invariance asserts on all state files.

Each PR carries its capability-manifest update and regenerated parity docs in the same
commit set. Loader README gains the Cursor dialect section in PR-A.

## 6. Verification plan

- Slice level: the fixtures named above; package test suites + typecheck green per slice.
- End-to-end: register a directory marketplace backed by a fixture repo in cursor/plugins
  layout; `/plugin marketplace add` → install → enable → rescan; assert mounts (skills
  usable, command runnable, MCP server registered via the deferStartupConnect idiom, rules
  segments present in the composed system prompt, hooks merged or skipped-with-warning per
  the S0 outcome). cc-shell tests seed BOTH `CLAUDE_CONFIG_DIR` and `DSH_HOME` to tmp.
- Capability gates: `pnpm docs:parity` regen is clean; `pnpm check:capabilities` /
  `check:parity` stay green in presubmit.
- Behavioral honesty: every degraded or ignored Cursor field appears in report warnings,
  and the capability rows claim only what tests prove — the plugins.loader mcp
  over-claiming lesson (PR #8) applies to the whole cursor surface.

## 7. Risks

- The Cursor hooks vocabulary probe surfaces divergence: contained by S0 running before any
  hook-bearing fixture exists; worst case is a small mapping table.
- Rules prompt-budget bloat from alwaysApply-heavy plugins: segment sizing guard plus report
  counts; the follow-up glob activation reduces noise.
- Marketplace name collisions across dialects: documented precedence; no cross-dialect state
  mixing.
- Capability validator invariants (I3/I4/I7) bite on the new `plugins.rules` row:
  mitigated by §3.7 planning and a local validator run before each PR.
- Spec staleness: Cursor's spec is recent and moving; fixtures pin the observed shapes and
  the S0 probe re-diffs the vocabulary at implementation time, so drift fails loudly instead
  of silently.

## 8. Open questions — confirm in slice

1. Whether the existing frontmatter helper extends cleanly to typed fields (boolean/list)
   or the shared parser migration happens instead (S4 budgets both paths).
2. Whether Cursor's command `.txt` files carry frontmatter or are pure text (S2 fixture
   decides; CC's txt convention is plain text).
3. Whether dsh-cc ever publishes a `clientId` concept ("dsh" vs "cursor" vs "claude") —
   deferred; the v1 behavior is warning-only.

## 9. Review log

- 2026-09-15 draft v0 (orchestrator) → dsh-cc-agents:critic cold review:
  APPROVE-WITH-AMENDMENTS. Amendments baked: report `warnings` decided up front with
  downstream-consumer updates in S2 and warnings attached at parse time (not post-lift);
  dual-manifest precedence made loud via report warning; `/**`-form globs expanded cheaply,
  remaining glob forms surfaced prominently in `/plugin`; unresolved-`${VAR}` MCP config
  fails that server with a named warning; hooks probe promoted to S0 ahead of all
  hook-bearing fixtures; enable/disable/rescan round-trip fixtures added to S1; `.mdc`
  frontmatter typed-field work budgeted in S4; `/plugin` flavor display added;
  `plugins.rules` marked cc-preset-plane-only; line anchors corrected against source.
- 2026-09-15 second pass (blocking-only, fresh critic): **CONFIRM**. One implementer note
  folded into §5 S1 (precedence-warning assertion binds at manifest level in S1, at report
  level in S2).
