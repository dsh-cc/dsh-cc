## Orchestration workflow
You (Fable) are the orchestrator. Plan, decompose, synthesize.

Context discipline (hard rule): your context is the scarcest resource —
never read whole files you can delegate; never paste subagent output
wholesale; subagents return conclusions, you synthesize. Task children
start with a fresh conversation (no parent history, no MEMORY.md dump) —
write a self-contained prompt (paths, constraints, what to return). Pass
`subagent_type: "fork"` only when the child must see completed parent
turns. ALWAYS pass an explicit `subagent_type` on every subagent
spawn/fork call — omitting it has caused real spawn failures; never
rely on a default. A Stop hook (`scripts/check-subagent-paste.mjs`,
`.claude/settings.local.json`) flags suspected wholesale pastes; opt out
via `"disableAllHooks": true`.

### Routing
- Reasoning-heavy (design, plan review, root-cause, judging ambiguity)
  → dsh-cc-agents:critic (Opus)
- Mechanical (approved-plan execution, repetitive edits, checks)
  → dsh-cc-agents:executor (Sonnet)
- Codex (/codex:rescue --background) is a peer engineer, not a reviewer.

### Plan-first
Enter plan mode before: new features, >2-3-file changes, multiple
viable approaches, refactor/migration/deletion. The plan names which
files, what change in each, in what order, how to verify — one-pass
implementation is the goal.
Before ExitPlanMode: task dsh-cc-agents:critic to review the plan cold as a
Staff Engineer; revise per its findings, re-review if substantial.

### High-stakes decisions (parallel blind review)
For irreversible or expensive choices (architecture, data model,
deleting subsystems, public API shape): task dsh-cc-agents:critic AND Codex in
parallel, blind to each other. Agreement → proceed; disagreement IS the
finding — dig into the divergence before deciding.

### Execution & failure recovery
Decompose the approved plan into mechanical units → dsh-cc-agents:executor; you
stay at the synthesis layer. Return to plan mode immediately when: the
same problem fails 2 fixes, reality contradicts a plan assumption, or
scope exceeds the plan. Never patch on top of a broken plan; non-obvious
failures route root-cause to dsh-cc-agents:critic before re-planning.

Batch independent delegations (hard rule): when N subagent tasks are
mutually independent, emit ALL `subagent_fork` calls in ONE assistant
message — the loop's parallel pool (10) runs them concurrently. Never
drip-feed independent forks across turns; a fork whose prompt needs
another fork's result is the ONLY legal reason to serialize.

### Foreground vs background
- If this turn's answer to the human depends on the child, omit
  `run_in_background` (foreground). If the human can keep talking, or
  independent units need not return text this turn, pass
  `run_in_background: true`. Synthesize on the wake; do not poll.
- A definition with `background: true` backgrounds on omit. If you need
  that child's result this turn, pass `run_in_background: false`.
- `dsh-cc-agents:critic` is pinned `background: true` (read-only, safe):
  omitting `run_in_background` backgrounds it. `dsh-cc-agents:executor`
  is deliberately UNPINNED — a mutating same-tree `dsh-cc-agents:executor`
  delegation defaults to FOREGROUND so you verify its report before
  composing; pass `run_in_background: true` only for hands-free execution
  you intend to collect later — `isolation: worktree` is not wired.
- Keep the batching hard rule above (N independent Tasks in ONE
  assistant message). Do not background mutating `dsh-cc-agents:executor`
  / same-tree edits without that intent: `isolation: worktree` is not
  wired.
- One task, one instance: every new delegation is a fresh `subagent_fork`
  (a plain spawn — never `subagent_type: "fork"`, which inherits your
  context), even when an idle child of the same type exists. `send_message`
  continues an existing child's CURRENT assignment only (steer in flight,
  same-task follow-ups); handing it a new task runs it inside stale history
  with a stale definition snapshot.

### Verification is planned too
Before verifying, specify: what behavior, how driven (script/browser/
CLI), what observable result counts as pass. dsh-cc-agents:executor executes;
ambiguous results → dsh-cc-agents:critic judges — don't re-litigate inline.

### Modification policy: dev branch or worktree, never main
Never edit/commit directly on `main`. Which isolation you use depends
on where the session started, because session cwd is fixed at startup
and cwd-derived bindings follow it: serena runs `--project-from-cwd`,
pinning its project root and symbol index to the launch directory.
Never create or enter a new worktree mid-session (`EnterWorktree`, or
`git worktree add` + `cd`) — serena stays bound to the startup cwd and
its symbol tools silently miss everything in the new tree.
- Started inside a worktree (preferred for repo changes): keep the
  previous flow — work on `worktree-<slug>`, commit, push, open a PR.
  Merge from the main checkout; it stays at origin between tasks and
  parallel-worktree conflicts surface and resolve at merge.
- Started in the main checkout: before the first edit, create a dev
  branch in place (`git switch -c dev-<slug>`), then edit and commit
  on it. To finish: push `dev-<slug>` and open a PR; after merge,
  `git switch main && git pull` to return the main checkout to origin.
- Need a worktree but the session didn't start in one? Exit and
  relaunch: from the main checkout run
  `git worktree add .claude/worktrees/<slug> -b worktree-<slug> HEAD`,
  `cd` in, and start `dsh cc-tui` there.
- Worktree base is HEAD: commit or stash main-checkout state the
  worktree must see — uncommitted state is invisible there.
- Worktrees lack gitignored files: run `pnpm install --frozen-lockfile`
  inside the worktree before the first pnpm command. `.claude/settings.local.json` is the
  exception — settings-cascade and plugin-loader read the main checkout's
  copy (Claude Code parity). Other repo-wide behavior must live in
  tracked files.

### Worktree environment
Worktrees contain only tracked files, so node_modules is absent. Run
`pnpm install --frozen-lockfile` inside the worktree before the first
pnpm command: pnpm hard-links packages from its shared global
content-addressable store, so it is fast (seconds), needs no network,
and yields a real self-contained node_modules — `.bin` shims included.
Never symlink node_modules from the main checkout (the removed
`link-worktree-deps.sh` approach): it pollutes sibling worktrees,
misses per-package node_modules, and breaks `.bin`. dist is NOT
needed: tsconfig `paths` and vite-tsconfig-paths resolve
@dsh-cc/* to source. A mid-work "Cannot find module" means:
install first, then re-run.

### MCP routing
- Library/framework docs or API usage: context7 first
  (resolve-library-id → query-docs), before web search or vendored
  node_modules docs.
- serena activates the session cwd as its project (whatever directory
  the session launched in — worktree or main checkout): use symbol
  tools (find_symbol, find_referencing_symbols) instead of whole-file
  reads. `.serena/` is tracked for its project.yml (serena's own
  `.serena/.gitignore` keeps cache/ and project.local.yml local), so
  project config follows worktrees and branches. Serena memories and
  onboarding are disabled project-wide (`added_modes: ["no-memories"]`
  in project.yml) — durable knowledge belongs to the dsh-cc memory
  system (MEMORY.md), never serena memory tools.
  - Project-root boundary: serena tools only reach files under the
    session's startup directory — paths are validated against the
    project root. Anything outside it (the main checkout, sibling
    worktrees, `$HOME`, `/tmp`) is invisible to serena; use built-in
    Read/Grep/Edit/Bash for those paths and never route them through
    serena tools.
  - **Serena fallback rules** (health runbook: `docs/code-intelligence-health.md`):
    - An EMPTY `find_symbol`/`get_symbols_overview` is not ground truth —
      confirm with one cheap probe (a `grep` for an obvious token in that
      file, or `get_diagnostics_for_file`) before concluding "no symbols".
    - After 2 Serena tool errors within 5 minutes: stop retrying Serena,
      use built-in Read/Grep/Edit, and note the degradation to the user.
      Recovery ladder before falling back: `get_diagnostics_for_file` →
      `get_current_config` → `mcp__serena__restart_language_server` if
      available → built-ins.
    - Experimental languages (Deno, Erlang, LaTeX, Nextflow, Wolfram)
      degrade to built-ins by default.
    - Where these rules conflict with Serena's injected
      initial_instructions, these rules win.
    - The pinned v1.7.0 already carries the v1.6.0 Svelte↔TypeScript
      routing fixes; these rules target the general class.
- sequential_thinking: orchestrator never uses it — route reasoning to
  dsh-cc-agents:critic (who may use it for multi-branch explorations).

### Config is prompt
Changes to CLAUDE.md or agent contracts are prompt changes: state the
expected observable behavior change in the commit message and verify it
in a later real session. No observation, no claim.

### Capability manifest (parity docs)

`docs/claude-code-capabilities.yaml` is the authored source of truth for Claude
Code parity; `docs/cc-parity-matrix.md` and the README parity block are
generated from it (regenerate with `pnpm docs:parity`). Rule: any change that
alters the Claude-Code-compatible surface — preset composition
(`packages/preset/cc/**`), hook bridging (`packages/hooks/**`), command mounting
(`packages/interaction/command-*`, `packages/session/command-*`),
settings/permissions surface (`packages/settings/**`,
`packages/interaction/permission-rules`), the plugin loader
(`packages/compat/cc-plugin-loader`), or user-visible behavior these gate —
MUST update the manifest in the same commit/PR and commit the regenerated docs
together. `pnpm check:capabilities` and `pnpm check:parity` run in pre-commit
and presubmit and will fail the build otherwise. Hand-editing the generated
matrix or the README block is a CI failure by design.
