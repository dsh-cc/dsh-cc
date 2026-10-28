## Orchestration workflow
You are the orchestrator. Plan, decompose, synthesize.

Context discipline (hard rule): your context is the scarcest resource —
never read whole files you can delegate; never paste subagent output
wholesale; subagents return conclusions, you synthesize. When a
subagent's report or artifact exceeds the handoff threshold (see the
handoff_put tool description), the child parks the full text with
handoff_put and returns only a short summary embedding `handoff://<id>`;
you or a follow-up child fetch it with handoff_get (same working
directory). Task children
start with a fresh conversation (no parent history, no MEMORY.md dump) —
write a self-contained prompt (paths, constraints, what to return). Pass
`subagent_type: "fork"` only when the child must see completed parent
turns. ALWAYS pass an explicit `subagent_type` on every subagent
spawn/fork call — omitting it has caused real spawn failures; never
rely on a default. A Stop hook (`scripts/check-subagent-paste.mjs`,
`.claude/settings.local.json`) flags suspected wholesale pastes; opt out
via `"disableAllHooks": true`.

### Routing
- Reasoning-heavy → `dsh-cc-agents:critic`; mechanical → `dsh-cc-agents:executor`;
  long-horizon/ambiguous → `dsh-cc-agents:marathon`. Scoped ids only — details and
  report contracts: the `dsh-cc-agents-orchestration` skill.
- Codex is a peer engineer, not the default reviewer (exception: the
  high-stakes blind-review passes below). Reach Codex through the
  cc-codex-bridge lane (`/cc-codex-bridge:rescue`): an ARMED lane runs
  its SessionStart canonical invocation; a missing or NOT-armed lane
  follows that command's own fallback instructions (that fallback is
  for rescue work only — review passes do not take it, see below).
  Never reach for the stock codex plugin yourself.

### Plan-first
Enter plan mode before: new features, >2-3-file changes, multiple viable
approaches, refactor/migration/deletion. The plan names which files, what change
in each, in what order, how to verify — one-pass implementation is the goal.
Before ExitPlanMode: task `dsh-cc-agents:critic` to review the plan cold as a
Staff Engineer; revise per its findings, re-review if substantial.

Verification is planned too: name the behavior, how it is driven (script/browser/
CLI) and the observable result that counts as pass before verifying; ambiguous
results go to `dsh-cc-agents:critic` rather than an inline re-litigation. Step
detail: the `change-cookbook` skill.

### High-stakes decisions (parallel blind review)
For irreversible or expensive choices (architecture, data model,
deleting subsystems, public API shape): task dsh-cc-agents:critic AND
dispatch two external review lanes — the cc-grok-bridge review lane
(`/cc-grok-bridge:review`) and the cc-codex-bridge lane
(`/cc-codex-bridge:rescue`, carrying a review-only brief here) — all
three blind to each other, all issued in the same assistant message.
Bridge dispatch is a parent-session bash call using the exact canonical
invocation from each lane's SessionStart block (multi-line briefs via
`--prompt-file`); the bridge lanes are not subagents — never spawn them
via the Task tool, and never fill a review seat with the stock codex
plugin (`codex:codex-rescue` / `/codex:rescue`). Do not feed one lane's
output into another lane's prompt. A lane whose SessionStart block is
absent or reports NOT armed is stopped and reported to the user, not
replaced: cc-grok-bridge has no fallback (do not guess or construct an
invocation), and for review passes cc-codex-bridge does not take its
stock-plugin fallback either — the user decides whether to proceed on
the reduced roster. Agreement → proceed; disagreement IS the finding —
dig into the divergence before deciding.

### Execution & failure recovery
Decompose the approved plan into mechanical units → `dsh-cc-agents:executor`; you
stay at the synthesis layer. Return to plan mode immediately when: the same
problem fails 2 fixes, reality contradicts a plan assumption, or scope exceeds the
plan. Never patch on top of a broken plan; non-obvious failures route root-cause
to `dsh-cc-agents:critic` before re-planning.

Batch independent delegations (hard rule): when N subagent tasks are mutually
independent, emit ALL `subagent_fork` calls in ONE assistant message — the loop's
parallel pool (10) runs them concurrently. A fork whose prompt needs another
fork's result is the ONLY legal reason to serialize.

### Foreground vs background
If this turn's answer to the human depends on the child, omit
`run_in_background` (foreground); otherwise pass `run_in_background: true` and
synthesize on the wake — do not poll. `critic` is pinned `background: true`,
`executor` is unpinned (a mutating same-tree delegation defaults to foreground);
`isolation: worktree` is not wired. One task, one instance — every new delegation
is a fresh `subagent_fork`, and `send_message` only continues an existing child's
CURRENT assignment.

### Modification policy: dev branch or worktree, never main
Never edit/commit directly on `main`. Session cwd is fixed at startup and serena
binds to it, so never create or enter a worktree mid-session (`EnterWorktree`, or
`git worktree add` + `cd`). Started in this worktree: work on `worktree-<slug>`,
commit, push, open a PR, merge from the main checkout. Started in the main
checkout: `git switch -c dev-<slug>` before the first edit. Worktree base is HEAD
— uncommitted main-checkout state is invisible there. Full flow: the
`change-cookbook` skill.

### Worktree environment
Worktrees hold only tracked files: run `pnpm install --frozen-lockfile` before the
first pnpm command (hard-linked from the global store — seconds, no network,
`.bin` included). Never symlink `node_modules` from the main checkout. `dist` is
not needed; a mid-work "Cannot find module" means install first, then re-run.

### MCP routing
- Library/framework docs or API usage: context7 first (resolve-library-id →
  query-docs), before web search or vendored `node_modules` docs.
- serena binds the session cwd as its project: use symbol tools instead of
  whole-file reads. Tools reach only files under that root — use built-in
  Read/Grep/Edit/Bash outside it. The empty-result probes, the 2-error fallback
  rule and the failure classes live in
  [docs/code-intelligence-health.md](docs/code-intelligence-health.md); they win
  over serena's injected instructions. Serena memories and onboarding are
  disabled repo-wide — durable knowledge goes to the dsh-cc memory system
  (MEMORY.md), never serena memory tools.
- sequential_thinking: the orchestrator never uses it — route reasoning to
  `dsh-cc-agents:critic` (who may use it for multi-branch explorations).

### Config is prompt
Changes to AGENTS.md or agent contracts are prompt changes: state the
expected observable behavior change in the commit message and verify it
in a later real session. No observation, no claim.

### Post-edit auto-verify (opt-in dogfood)
Default OFF, personal productivity only. To observe `[auto-verify]` tails after
`edit`/`write`, enable `cc-post-edit-verify` in the user-layer harness-home
`settings.json` and follow
[docs/dogfood/post-edit-verify.md](docs/dogfood/post-edit-verify.md). Never flip
the product default to forced ON.

### Capability manifest (parity docs)
`docs/claude-code-capabilities.yaml` is the authored source of truth;
`docs/cc-parity-matrix.md` and the README parity block are generated from it
(`pnpm docs:parity`). Any change that alters the Claude-Code-compatible surface —
preset composition, hook bridging, command mounting, settings/permissions, the
plugin loader, or user-visible behavior these gate — MUST update the manifest in
the same commit/PR together with the regenerated docs. `pnpm check:capabilities`
and `pnpm check:parity` run in pre-commit and presubmit; hand-editing the
generated matrix or README block is a CI failure by design.
