/**
 * Bundled CHANGELOG for `/release-notes`, seeded at author time from the
 * repository's tracked history and README. The full changelog rides a TS string
 * constant so the command is offline-safe and deterministic — no filesystem or
 * network at call time.
 *
 * The newest section's version MUST equal this package's `package.json`
 * version; `tests/command-release-notes.spec.ts` pins that pairing so the
 * snapshot cannot silently age into a wrong report again. `scripts/release.mjs`
 * prepends that section (user-facing commit subjects since the previous
 * section's tag) in the same commit as the version bump; edit it in the
 * release PR when the subjects need a rewrite.
 *
 * @module @dsh-cc/command-release-notes/release-notes
 */

/** The bundled changelog, newest section first. */
export const CHANGELOG = `# Release notes

## 0.9.6 — a mathematical research harness and two writing-citation repairs

- **Math harness** — a new marketplace plugin, \`dsh-cc-math\`, adds a
  Lean 4 formalization layer on top of the harness: receipt-disciplined
  mathlib provisioning, a SQLite FTS5 search index with dependency
  reachability, kernel-checked proof binding behind an axiom whitelist,
  and a fidelity gate that grades a claim before any search budget is
  spent. Claim, budget and search state each carry their own ledger, and
  discovery rides a verifier-gated experience store that records nothing
  it could not check. The Mathlib pin ships unfilled on purpose (filling
  it needs one networked session); CI reports that as a notice and keeps
  cold provisioning dormant rather than passing silently.
- **Math evaluation** — a paired \`math-eval\` package carries a strict
  run-manifest schema, a nine-config ablation matrix and four
  attribution contrasts, so a technique's contribution is read off a
  contrast instead of a single arm. The two new packages' 195 tests are
  fixture- and mock-driven: no network, no Lean toolchain, no model
  calls in CI.
- **Writing citations** — the \`engineering-strategy\` profile cited a
  book under the wrong title in five places and hung a chapter citation
  on a rule that chapter does not support. The title is corrected to
  *The Engineering Executive's Primer*, and *Crafting Engineering
  Strategy* Ch. 11 — whose actual subject is that writing order is not
  reading order — now backs its own rule, leaving \`show-your-work\` with
  the source it really came from.

## 0.9.6-rc.3 — a new harness line and a name-addressed subagent surface

- **Harness 0.2.2-rc.5** — the verified dsh line moves from \`0.2.2-rc.1\`
  to \`0.2.2-rc.5\`, and the launcher's minimum requirement rises with it:
  an older dsh stops at startup with an upgrade message. The peer floors
  across 78 packages, the CI harness ref and the ACP pin follow the same
  line.
- **Subagents address by name** — \`send_message\` and \`interrupt_agent\`
  now take the model-facing name (\`lead\`, a slash path, or a bare token
  that falls back to session-id semantics) instead of an id. The resume
  gates resolve that name before comparing, so pins, tombstone release and
  the delegation advisory keep working, and a name that cannot be
  attributed passes through instead of blocking. The new \`wait_agent\`
  tool joins the CC surface (inbox wait, not delegation control).
- **Release evicts one child** — \`/agents release\` and the
  \`release_agent\` tool ride parent-scoped retained dispose receipts:
  releasing a child leaves its own delegates resident (each is released by
  its creating session), and an execution restored by a later
  \`send_message\` refuses with a remedy instead of reporting success.
  Plugin agents are discovered from a root-realm registration snapshot,
  because upstream removed the seam's provider enumeration.
- **Routing criteria, domain-neutral** — the tier classifier states its
  complexity axis in data-analysis terms alongside the coding ones, so a
  multi-source reconciliation reads as \`blueprint\` rather than a one-step
  aggregation, and every route row carries a criteria revision for
  slicing traffic across the change.
- **Four more writing genres** — \`technical-essay\`, \`academic\`,
  \`natural-prose\` and \`engineering-strategy\` join the document-type
  profiles, the last with a Rumelt-kernel section skeleton. A profile may
  declare a \`structure\` outline, and check artifacts verify required
  sections and their relative order before finalize.

## 0.9.6-rc.2 — an executor that fails fast and reports honestly

- **Delegated ask rejections** — a permission ask denied by policy
  (approval policy \`never\`, or no channel to ask on) no longer reads as
  a user rejection that invites a retry loop: delegated sessions get
  agent-addressed guidance with three retry classes — underspecified
  earns one narrower retry, transient one identical retry, and
  structural or unknown reasons mean stop and report a Blocker. ASK
  decisions, the approval waterfall and hook \`allow\` are untouched.
- **Executor contract** — \`executor.md\` now fails fast on environment
  and permission blockers instead of improvising symlink or lockfile
  workarounds, forbids scripted repo-file edits (dispatch-named
  generators stay exempt), asks for serena-first bounded read bursts,
  and requires non-empty Final verification and Gates-not-run sections.
- **Delegation pre-flight** — the orchestration skill gains a pre-flight
  checklist for mutating delegations: declarative target-repo bootstrap
  and an explicit parent/child split of command ownership. Both contract
  changes come from a two-week audit of 95 executor runs.

## 0.9.6-rc.1 — MCP permissions, VWA renders and a stricter completion gate

- **MCP permissions** — a bare \`mcp__<server>\` rule now releases every
  tool on that server with Claude Code semantics, over a public MCP name
  decomposition that is contract-unique. MCP calls in \`auto\` mode resolve
  a deterministic class before the gauge: a curated read-only table
  (serena, pinned to its live tool list) and settings-declared
  workspace-write classes, screened so a protected-path argument forces an
  ask. Annotation trust stays opt-in and never amplifies plan mode.
- **VWA renders** — the autonomous render pipeline lands: drafts are the
  editable source and a bind renders the marker-free deliverable,
  \`gr:\` citations cover corpus-registered sources, state moves under
  \`.dsh/vwa/<id>/{sources,reports,renders}\`, \`schemaVersion\` 2 adds
  \`/vwa repair --migrate\`, and dispute judgments key on input hash plus
  stage so a cached run can never expire one.
- **Completion gate** — an opt-in \`enforce\` mode re-opens a turn whose
  final message carries unmatched completion claims and, when the cycle
  budget is spent, records a terminal \`completion-gate/unverified\` marker
  at turn end. The default stays \`nudge\`; enforce needs
  \`cc-completion-gate.mode: 'enforce'\`.
- **Review contracts** — the critic agent gains a design-review mode: walk
  a failure-class taxonomy, anchor every finding to a \`file:line\` read in
  this run, open with \`VERDICT\` and P0–P2 findings. The orchestration
  skill documents the four-part review brief shared by the critic and the
  bridge lanes.
- **Docs and models** — root and package READMEs are trued up against the
  implementation, and the render pipeline ships with TLA+ models for the
  render-commit and adjudication paths under \`specs/tla\`.

## 0.9.5 — governed model input, skill routing and one memory catalog

- **Input ledger** — every model step now records what it actually received
  (system sections, injected context, tools) as a sidecar row, so input cost
  can be read per step instead of reconstructed after the fact. On by default.
- **Input budget** — a governor arbitrates the same input before it is sent:
  per-class caps, a duplicate window and a defer backlog, with protected
  classes that are never trimmed. On by default in \`observe\` mode, which
  accounts for what it would cut without cutting yet.
- **Compaction pinning** — governance messages (turn rules, edit-recovery
  hints) are restored verbatim across summarization compaction, gated on a
  checkpoint that actually committed; a turn without one still falls back to
  the old belt. \`cc-compaction-pinning\` is on by default.
- **Prompt sections** — the memory topic index and the subagent catalog are
  byte-capped under a shared budget, and the memory section renders one
  scope-tagged catalog instead of per-scope lists. Dropped entries leave a
  count and a grep hint, so nothing becomes unreachable.
- **Reducer gate** — the context reducer asks a decision model for a
  pre-generation feasibility verdict and skips attempts that are clearly not
  worth a receipt. Receipt validity stays with the deterministic verifier.
- **Skills** — a new read-only \`recommend_skill\` tool ranks skills for a
  task using packed, token-budgeted batches with route-aware budgets and
  deadline-partial coverage. It is mounted in the \`cc\` and \`vwa\` presets
  and dark by default (\`mode: off\`); shadow and active are separate opt-ins.
- **Memory fixes** — extraction write-backs can no longer destroy the topic
  index, and Chinese no-relevant recall queries stay off the corpus
  vocabulary.
- **Routing** — moa gains context-routing v2 with a tail-risk tier policy.
- **Tool discovery** — an activation eval harness (judge-stub gate plus a
  live runtime arm) decides whether semantic tool discovery may leave shadow
  mode. No default changed.
- **Tooling** — \`/release-notes\` is written in the same commit as the
  version bump, so a release can no longer ship a stale newest section.

## 0.9.5-rc.1 — defaults, SystemOne decisions and fixes

- **Defaults** — the completion gate, turn rules (judged and repeat
  reminder), LSP diagnostics-on-write and post-edit auto-verify are now on
  by default; each keeps an explicit \`enabled: false\` opt-out. Context
  compression is on in measurement-only (dry-run) posture.
- **Prompt suggestions** — still off by default; when enabled they run on
  top-level turn stops only, and an unconfigured cheap-lane alias is skipped
  instead of billed to the parent route.
- **SystemOne decisions** — a decision runtime with contract validation,
  budget and metering, routed through the \`gauge\` lane alias. It backs
  optional memory recall selection, a memory extraction gate and semantic
  tool discovery, all off by default.
- **Memory** — recall preselection and admission planning for large corpora,
  plus fixes to recall tie-breaking, grey-zone rows and consolidation.
- **Permissions** — the auto-mode underspec criteria are retuned so
  read-only compound shell commands no longer escalate to ask.
- **Settings** — secret redaction now covers union, intersect and transform
  nodes; frozen cascade sections parse without mutation faults; provider,
  namespace and cascade merge into @dsh-cc/settings.
- **Fixes** — ACP resolves the preset roster per use (no more stock-plugin
  fallback under load) and reports the current version; moa writes
  automatic escalation rows in chain order; /compact resolves its zh alias.
- **Packaging** — serena-first and output-styles merge into
  @dsh-cc/prompt-extras; Node 24 is the primary line and 22 the engines floor.

## 0.9.4 — Claude Code compatibility layer

- **Commands** — 21 human-facing slash commands spanning session inspection
  (/status, /cost, /stats, /export, /diff, /transcript), diagnostics (/doctor),
  configuration (/config, /permissions, /preset, /mcp, /skills, /agents,
  /tasks, /memory, /plugin), workflow (/commit-split, /branch, /resume,
  /rename, /compact, /init) and metadata (/version, /release-notes, /help).
- **Hooks** — a Claude-Code hook bridge over the harness hook protocol,
  covering lifecycle, permission, tool and subagent events, with command and
  http executors plus Stop-block capping.
- **Permissions** — a CC-shaped allow/deny/ask rule engine with modes,
  session-scoped grants, and an auto mode that decides low-risk calls through
  a classifier.
- **Memory** — CLAUDE-style file memory with a project index, sidecar recall
  and background consolidation.
- **Skills and plugins** — SKILL.md discovery across the CC roots, a plugin
  marketplace loader, and deferred tool-name resolution via ToolSearch.
- **MCP** — an MCP client with resources, prompts and deferred startup, plus a
  .mcp.json/.claude.json parser and a migration command.
- **Compaction** — a CC-aware compaction engine with optional cost gating,
  tool-use summaries and staleness microcompaction.
- **Subagents** — a task tool with worktree isolation, resume pins, a handoff
  store and a background-capacity release valve.
- **ACP** — an Agent Client Protocol session surface so external editors can
  drive dsh-cc over stdio.
- **Session plumbing** — a 5-level settings cascade, session projections,
  statusline rendering and a working-directory facade.

See per-package READMEs for detailed contracts.
`

/**
 * Render the release notes, trimming to at most `maxLines` from the top.
 * @param markdown - the changelog markdown (defaults to {@link CHANGELOG}).
 * @param maxLines - maximum number of lines to show (default unlimited), used
 *   to keep the on-screen report short while retaining the newest section.
 * @returns the rendered release notes text.
 */
export function renderReleaseNotes(markdown: string = CHANGELOG, maxLines?: number): string {
  const lines = markdown.replace(/\r\n/gu, '\n').split('\n')
  if (maxLines === undefined || maxLines <= 0) return lines.join('\n')
  return lines.slice(0, maxLines).join('\n')
}
