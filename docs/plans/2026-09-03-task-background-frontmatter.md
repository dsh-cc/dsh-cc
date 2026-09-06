# Honor `background:` and teach the human-facing Task heuristic

Status: approved — deep-reasoner cold Staff-Engineer review returned
**ship-with-changes**; A.1 cut to three bullets, mutating same-tree
backgrounding forbidden until `isolation: worktree` is wired, pin escape
hatch (`run_in_background: false`) documented. Product north star is
Claude Code's human heuristic, not flipping the tool-schema default.
Date: 2026-09-03
Scope: `@dsh-cc/subagent-task` (CC `Task` tool), orchestrator
`CLAUDE.md`, task-package READMEs, `docs/cc-parity-matrix.md`, and one
clause in `@dsh-cc/claude-code-agents` READMEs. No harness
(`@deepseek-ai/dsh-*`) changes. No TUI Ctrl+B promote (follow-up).

## 1. Problem

Claude Code's interactive session is a human chat window. Subagent
scheduling there is three layers:

1. **Spawn-time model choice.** Optional `run_in_background` on `Agent`/`Task`.
2. **Definition pin.** Agent-markdown `background: true` forces background
   unless the caller overrides.
3. **In-flight user promote.** Ctrl+B (or `Ctrl+X Ctrl+B` under tmux)
   backgrounds a *running* task so the human can keep typing. Out of
   scope for this change.

dsh-cc's TUI is also a human chat window (`/agents`, `subagent/start|end`
folding). Continuable background dispatch already exists
(`run_in_background: true` → `startContinuable`, shipped in #87). Two
gaps remain:

- The loader parses `AgentDefinition.background`
  (`packages/preset/claude-code-agents/src/parse.ts`) but Task never
  reads it. The field is inert.
- Prompt surfaces still teach "foreground by default; pass true for
  long-running or parallelizable work." That is the wrong heuristic for
  a human-facing window. Claude Code's rule is: if *this turn's answer
  to the human* depends on the child, stay foreground; if the human can
  keep talking, background. Parallelism among workers is a separate
  axis — N independent foreground Tasks in one assistant message already
  run concurrently (`isConcurrencySafe: () => true`, CLAUDE.md batching
  hard rule, pool of 10). Backgrounding is what unblocks the *human*,
  not what makes workers parallel.

This change closes the first two gaps. It does **not** flip
`execute()` so omit means background, does **not** pin bundled `explore`
or workspace `deep-reasoner` / `fast-worker`, and does **not** add
Ctrl+B in-flight promote (TUI + running-Task lifecycle; follow-up).

## 2. Goals and non-goals

Goals:

- Consume `definition.background` with explicit `run_in_background`
  always winning.
- Teach the human-facing heuristic on the three prompt surfaces the
  model actually sees at call time (`CLAUDE.md`,
  `cc:subagent-background` section, Task tool + parameter descriptions).
- Make the task-package READMEs and the parity-matrix Subagents row
  match shipped continuable behavior (they still claim "Foreground only"
  / list `run_in_background` as a non-goal).

Non-goals (must stay out):

- `execute()` treating omit as background (interactive session policy;
  later, once continuable drain / parent-only `send_message` / cold
  resume are as reliable as Claude Code).
- Pinning `background: true` on bundled `explore` or workspace
  `deep-reasoner` / `fast-worker`.
- Consuming `isolation: worktree`.
- Fork + background (upstream harness issue #2124; keep the rejection).
- `outputFile` / `TaskOutput`.
- Shrinking the background built-in toolset.
- TUI Ctrl+B / in-flight promote of a running foreground Task.
- Rewriting `docs/plans/2026-09-03-background-agent-runtime.md`
  (historical).

## 3. Precedence (the whole runtime change)

```
run_in_background === true                → background
run_in_background === false               → foreground   # wins over a pin
omitted && definition.background === true → background
otherwise                                 → foreground
```

`general-purpose` / omitted type / `fork` have no definition, so omit
stays foreground. `fork` + explicit true still throws naming #2124.

Private helper colocated with `execute()` in
`packages/subagent/task/src/tool.ts` — do **not** export unless a second
consumer appears:

```ts
function wantsBackground(args: TaskArgs, definition?: { background?: boolean }): boolean {
  if (args.run_in_background === true) return true
  if (args.run_in_background === false) return false
  return definition?.background === true
}
```

The agents parser already rejects a non-boolean `background`
(`optionalBoolean`; test: `background: nope` throws). No production
agent markdown in this repo currently sets `background: true` (only a
parse fixture), so consuming the field is not a silent behavior change
on shipped agents. Bundled `explore` has no `background:` field.

## 4. Implementation

### 4.1 Runtime — `packages/subagent/task/src/tool.ts`

In `registerTaskTool` `execute()`:

- After `registry.resolve`, pass the definition into `wantsBackground`.
- `general-purpose` / blank type: `wantsBackground(args)` only.
- `fork`: keep the existing throw on true; omit/false stay
  `seam.start(fork)`.
- Named definition: `wantsBackground(args, definition)` then the
  existing `startBackground` vs `seam.start` fold (persona / toolFilter /
  agentOptions unchanged).

Replace the tool `description` paragraph that currently says "By default
the call is FOREGROUND … For long-running or parallelizable work, pass
`run_in_background: true`" with the human heuristic + pin rule, ≤ the
current length. Parameter `run_in_background` description, ≤2 sentences:
explicit true/false always win; otherwise omit uses the definition pin;
otherwise foreground. Parameter stays optional.

### 4.2 Prompt section — `packages/subagent/task/src/index.ts`

Replace `BACKGROUND_SECTION_TEXT`. Keep the heading
`## Background subagents`. New bullets:

- Two-line heuristic (need-this-turn → omit / foreground; human can keep
  talking → `run_in_background: true`). Synthesize on the wake; do not
  poll.
- Pin escape hatch: a definition with `background: true` backgrounds on
  omit; pass `run_in_background: false` when this turn needs the result.
- Keep operational bullets: wake, `list_agents` / `send_message` /
  `interrupt_agent`, fork rejected (#2124), parent-exit drains.

Export `BACKGROUND_SECTION_TEXT` (and `BACKGROUND_SECTION_NAME` if
useful) so tests can lock the contract the same way `catalog.ts` exports
`CATALOG_SECTION_NAME`.

### 4.3 Orchestrator prompt — `CLAUDE.md`

After the "Batch independent delegations" paragraph (before
`### Verification is planned too`), add a `### Foreground vs background`
subsection of **exactly three bullets**:

1. This turn's answer to the human depends on the child → omit
   `run_in_background` (foreground). The human can keep talking, or
   independent units need not return text this turn →
   `run_in_background: true`. Synthesize on the wake; do not poll.
2. A definition with `background: true` backgrounds on omit. If you need
   that child's result this turn, pass `run_in_background: false`.
3. Keep the existing batching hard rule (N independent Tasks in **one**
   assistant message). Do not background mutating `fast-worker` /
   same-tree edits: `isolation: worktree` is not wired.

Do not add per-agent carve-outs for explore / deep-reasoner, and do not
write a foreground-parallel vs background-parallel essay.

Config-is-prompt: the commit message must state the expected observable
(independent scouts the human is not blocked on are launched with
`run_in_background: true`; plan-review / need-this-turn stays omitted).
No claim of prompt effectiveness without a later real session.

### 4.4 Docs honesty

`packages/subagent/task/README.md` and `README.zh.md`:

- Dispatch paragraph currently "The run is **foreground one-shot**" /
  「运行是**前台一次性**」: foreground unless explicit true **or**
  definition pin; explicit false wins; foreground still awaits
  completion and concatenates `text` blocks; background returns
  `async_launched` + durable id.
- Known limits: drop "**Foreground only.**" / 「**仅前台。**」 Keep
  drain / no `outputFile` / fork+bg rejected / cold-resume drops extra
  `agentOptions` (those live in the parity matrix; a short pointer is
  enough).
- Non-goals: remove `run_in_background` / continuable Task. Keep
  `isolation` / `permissionMode` / `memory` / `effort` unconsumed. Add
  "omit means background as a session policy" as a non-goal. Mention
  in-flight Ctrl+B promote as a follow-up, not a non-goal of the
  package's existence — one line under non-goals is fine.

`docs/cc-parity-matrix.md` Subagents row: replace "Foreground remains
the default and the cheap-lane recommendation" with: omit is foreground
unless the definition pins `background: true`; explicit
`run_in_background` always wins; prompt teaches the Claude Code human
heuristic. State that honoring the pin is a dsh-cc extension of the
parsed field (Claude Code documents it; Task now consumes it). Still a
deliberate deviation from Claude Code interactive omit=background.

`packages/preset/claude-code-agents/README.md` and `README.zh.md`: one
clause on the field-translation bullet that Task now honors `background`
(the parsed field is no longer inert).

Do not rewrite `docs/plans/2026-09-03-background-agent-runtime.md`.

## 5. Tests (TDD — write these first, confirm they fail, then implement)

File: `packages/subagent/task/tests/tool.spec.ts`. Helpers
`writeAgent` / `freshWorkspace` / `mount` / `call` already exist. Add a
nested `describe` under `run_in_background` (or a sibling
`describe('definition.background pin')`).

| Case | Expect |
|---|---|
| agent `background: true`, omit arg | `startContinuable`, no `seam.start`; folding (persona) still applied |
| same + `run_in_background: false` | `seam.start`, no continuable |
| same + `run_in_background: true` | continuable (already covered in spirit; keep an explicit pin+true case) |
| agent without the field, omit | `seam.start` (today's path) |
| bundled `explore`, omit | still `seam.start` |
| general-purpose / omitted type, omit | still `seam.start` |
| fork + explicit true | existing rejection, unchanged |
| pin + fork is N/A (sentinel has no definition) | do not invent a case |

Rename the existing test
`keeps the foreground path byte-identical when run_in_background is absent or false`
so it does not lie after pins exist, e.g.
`keeps the foreground path byte-identical when run_in_background is absent or false and the definition does not pin background`.

Prompt-contract tests (same file, or a small `index`/`section` describe
if importing from `../src/index.ts` is cleaner):

- `BACKGROUND_SECTION_TEXT` contains the need-this-turn heuristic and
  the pin escape hatch (`run_in_background: false` / `background: true`).
- It does **not** say "foreground by default" as the only rule, and does
  **not** recommend background solely for "long-running or parallelizable
  work".
- After `registerTaskTool`, the registered tool's `description` and the
  `run_in_background` parameter description carry the same contract
  (heuristic + pin). Inspect via the tools registry the same way other
  tests already reach `ctx.tools`.

Skip:

- A `"true"`-string pin test — the agents parser already throws
  `background must be a boolean`.
- Dedicated pin-vs-arg telemetry.

## 6. Verify

1. Worktree: `bash scripts/link-worktree-deps.sh` if `node_modules` is
   missing (idempotent; no-ops in a main checkout).
2. `pnpm exec vitest run packages/subagent/task/tests/tool.spec.ts`.
3. Grep the task READMEs: no remaining "Foreground only" /
   "仅前台" / "`run_in_background` / continuable Task (follow-up)" as a
   non-goal.
4. `CLAUDE.md`: no unit test. Later real session is the observation.

## 7. Files

- `docs/plans/2026-09-03-task-background-frontmatter.md` (this file)
- `CLAUDE.md`
- `packages/subagent/task/src/tool.ts`
- `packages/subagent/task/src/index.ts`
- `packages/subagent/task/tests/tool.spec.ts`
- `packages/subagent/task/README.md`
- `packages/subagent/task/README.zh.md`
- `docs/cc-parity-matrix.md`
- `packages/preset/claude-code-agents/README.md`
- `packages/preset/claude-code-agents/README.zh.md`

## 8. Commit message (expected observable)

Prompt change + runtime pin. The commit message must name the expected
observable for the CLAUDE.md heuristic (independent scouts the human is
not blocked on use `run_in_background: true`; plan-review / need-this-turn stays
omitted) and must not claim that observable was seen in this change.
