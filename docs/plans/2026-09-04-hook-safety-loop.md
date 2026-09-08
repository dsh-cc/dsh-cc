# Hook Safety Loop (v0.4.1)

Date: 2026-09-04 · Status: Implemented — PR #99 (merged 2026-09-04); originally reviewed and approved with amendments · Target release: v0.4.1

## Goal

Close the safety loop for Claude Code hook semantics in dsh-cc: every hook
outcome that today is silently dropped, endlessly effective, or invisible must
become either **honored** or **visibly degraded**. This release deliberately
does NOT broaden event coverage — it fixes only semantics that cause wrong
behavior.

Review: cold Staff-Engineer review completed 2026-09-03; verdicts were
F3/F4/F6/F7/S1 APPROVE as designed, F1/F2/F5/S2 approved with the amendments
folded into the sections below.

## Scope

### Must-fix

| # | Item | Today (verified) |
|---|---|---|
| F1 | Stop-hook consecutive-block cap of 8; truthful `stop_hook_active` payload | block steers forever (`index.ts:306`, `TODO(stop-loop-guard)`); `stop_hook_active` hardcoded `false` (`payloads.ts:81-83`) |
| F2 | `continue:false` halts the current run | recorded as decision `'stop'` on the log-only `hook/result` event, never acted on (`TODO(hook-continue-false)`, `index.ts:197`) |
| F3 | `systemMessage` displayed in the TUI | warn-logged "not yet surfaced (ignored)" (`run-point.ts:120-122`) |
| F4 | PreToolUse `allow` pre-approves | merged `allow` falls through to `next()` → the permission prompt still appears (`index.ts:266-269`) |
| F5 | Hook timeout / non-zero exit / JSON parse failure visible in `/doctor` | `timedOut` dropped by `runner.ts:91`; malformed JSON swallowed (`codec.ts:78-83`); `hook/result` is log-only and not rendered |
| F6 | Startup warning for unsupported hook handler options | unknown handler keys silently dropped (`config.ts:97-136`); unknown event names silently ignored pre-parse (`config.ts:160`) |
| F7 | Fix supported-count vs unsupported-list inconsistency | `README.md:112` / `README.zh.md:102` claim "18 of 30" + "Unsupported (12):" but enumerate 13 and additionally name UserPromptCancel; stale comment `index.ts:335` ("9 of Claude Code's 30") |

### Suggested (implement — no upstream seam blocks them)

| # | Item | Note |
|---|---|---|
| S1 | PreToolUse `hookSpecificOutput.additionalContext` | codec already parses it; inject via `agent.inject` |
| S2 | PostToolUse `updatedToolOutput` (+ `updatedMCPToolOutput` for `mcp__*` tools) | map to `PostToolDecision` content-projection replacement |

### Explicitly deferred (document, do not implement)

`updatedInput` (input rewrite), `terminalSequence`, `mcp_tool` handler,
per-session hook-config cascade (`TODO(per-session-hook-config)` stays),
all remaining hook events, `suppressOutput`, parsing structured stdout JSON on
non-zero exit codes, CC's event-specific 30 s UserPromptSubmit timeout.

## Claude Code reference semantics (pinned, from code.claude.com/docs/en/hooks*)

- **Stop**: after **8 consecutive blocks** Claude Code overrides the hook and
  forces the turn to end. Input carries `stop_hook_active` (true while the
  agent is already continuing because of a Stop hook). `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`
  overrides the cap.
- **`continue:false`**: halt processing entirely; `stopReason` is shown to the
  user. Valid from any event.
- **PreToolUse**: `hookSpecificOutput.permissionDecision` = `allow` (bypass the
  permission prompt) / `deny` (block, reason to the model) / `ask` (prompt).
- **`systemMessage`**: warning text shown to the user.
- **Exit codes**: 0 = clean (stdout JSON parsed); 2 = block (stderr is the
  reason); other = non-blocking error.

## Architecture map (current state)

- `packages/hooks/hooks-claude-code` — the bridge: config parsing
  (`src/config.ts`), dispatch (`src/dispatch.ts`), point runner
  (`src/run-point.ts`), CC decision mapping (`src/index.ts`), payload
  builders (`src/payloads.ts`).
- `packages/hooks/hook-protocol` — shared dialect-neutral lib: `runner.ts`
  (exec via `ctx.shell`, `ShellRunResult.timedOut` exists upstream),
  `codec.ts` (exit-code + JSON decode), `merge.ts` (folded outcome),
  `events.ts` (log-only `hook/invoked`/`hook/result`), `types.ts`.
- `packages/interaction/command-doctor` — `/doctor`: pure renderer
  (`src/doctor.ts`) + service gather (`src/index.ts`).
- `packages/ui/tui/src/transcript.ts:293-299` — a session `user/message`
  whose `source` is `{kind:'plugin', form:'notice', summary:string}` renders
  as a durable one-line dim status row (precedent: compaction plugin).
- `packages/core/tools` — tool pipeline: `PreToolDecision` already has
  `{kind:'allow'}`; the pre-execute waterfall terminates in
  `Promise.resolve({kind:'allow'})` (`runtime-execute.ts:170-173`); `ask`
  goes to the approval service; monotonic guards run **after** pre-execute
  and can still deny on `allow` (`runtime-execute.ts:180-183`).
- `packages/interaction/permission-rules/src/index.ts:283-289` — the
  permission pipeline is a plain `tools/pre-execute` listener (pure
  `decideCall`, no side effects).
- `packages/workspace/session-cwd/src/listener.ts:128-141` — precedent for
  registering a pre-execute listener with `{prepend:true}` to run ahead of
  permission-rules.
- Harness (external `@deepseek-ai/*`): `agent.steer(msg)` injects steering
  observed at the stopping boundary; `agent.cancel(cause)` clears queued +
  steering work and aborts the active turn (no-op when idle);
  `AgentCancelCause` includes `{kind:'hook', reason:string}`
  (dsh-session `types.ts:143-148`).
- Composition constraint: the `hooks-claude-code` preset row lives INSIDE the
  `cc-services` isolate group (`packages/preset/cc/agent.cordis.yml:314-365`)
  and the preset mount rejects any row that publishes a cordis Service
  (`PresetMountError` / leakedServices). `/doctor` sits OUTSIDE the group.
  **Therefore hook diagnostics must not be a cordis service provided by the
  bridge** — see F5.

## Design

### F1 — Stop-hook block cap (8) + truthful `stop_hook_active`

Bridge-local state in `apply()`:

```ts
const stopBlocks = new Map<string, number>()        // agentId -> consecutive block count
const agentSession = new Map<string, string>()      // agentId -> sessionId (for disposal cleanup)
```

- `stopPayload(ctx, agent, stopHookActive)` gains the third parameter;
  `stop_hook_active = (count > 0)` and is computed **before** incrementing, so
  block #1 observes `false` and exactly `cap` steers occur before override.
  The SubagentStop payload keeps `stop_hook_active:false` (the bridge never
  blocks there today; documented).
- In the `agent/turn-stopping` listener, on `merged.decision === 'deny'`:
  - `count >= cap` → do **not** steer. Surface the F3 notice
    `Stop hook overridden after ${cap} consecutive block(s); the turn is ending`,
    `logger.warn`, record a `'stop-cap'` diagnostic (F5). Reset the counter to 0.
  - otherwise → steer (unchanged message) and increment **only along the steer
    path** (no increment when no steer was issued).
- Cap resolution once at `apply()`: positive integer
  `process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` else `8`. `0`/garbage → 8.
- Reset to 0 inside the existing `agent/pre-step` listener when any incoming
  message has `source.kind === 'user'` (a real user turn breaks the chain;
  plugin-source steering/notices must NOT reset). Plugin-source messages from
  this bridge all use `PLUGIN_SOURCE` = `{kind:'plugin', …}`, so no reset.
- Cleanup: on `session/disposed` delete every `stopBlocks`/`agentSession`
  entry whose recorded sessionId matches. Keying by `agent.id` (not session
  id) prevents a subagent Stop block from corrupting the root agent's count —
  `agent/turn-stopping` carries `{agent}` and fires per-agent.
- Tests: 8 blocks then override; payload flag sequence `false,true,…`;
  env override honored, `0`/invalid → 8; user message resets; subagent block
  does not touch root counter; session disposal frees entries.

### F2 — `continue:false` halts the run

Add one bridge helper and call it at the top of the five in-run listeners:

```ts
/** Returns true when a halt was applied (caller returns the given decision). */
function applyHalt(point: string, merged: MergedHookOutcome, agent: Agent | undefined): boolean
```

- If `!merged.stop` → false. Otherwise: surface a notice
  `Halted by <point> hook: <stopReason | 'continue:false'> — any queued input was discarded`
  (the inbox-drop sentence is mandatory: `agent.cancel` discards queued and
  steering work), record nothing in diagnostics (a halt is a decision, not an
  error), and call
  `agent.cancel({ kind: 'hook', reason: merged.stopReason ?? `${point} hook requested continue:false` })`
  when an agent handle exists.
- Per-listener return values after halt (so nothing proceeds under a racing
  cancel):
  - `agent/pre-step` (UserPromptSubmit): also `return { kind: 'reject' }`.
  - `tools/pre-execute` (PreToolUse): `return { kind: 'deny', reason: stopReason ?? 'halted by PreToolUse hook' }`
    — the tool must never dispatch after a halt.
  - `tools/post-execute` (PostToolUse): `return { kind: 'block', feedback: [{type:'text', text: stopReason ?? 'halted by PostToolUse hook'}] }`.
  - `agent/turn-stopping` (Stop): no return; the cancel clears pending
    steering, defeating the continuation machine.
  - `approval/request` (PermissionRequest — 5th in-run seam, review amendment):
    `return 'rejected'` and cancel.
- Detached/emit points (SessionStart, Setup, SessionResume, PermissionDenied,
  Notification, PostCompact, SessionEnd, StopFailure, TaskCreated,
  SubagentStop, TeammateIdle): halt has no in-flight run — log the
  `stopReason` only (documented partial).
- Remove `TODO(hook-continue-false)` and rewrite the coverage-cases test that
  asserts "does not halt" (`tests/coverage-cases.ts:~513`) to assert halting.
- Tests: per-seam halt behavior incl. post-execute; cancel raced with the
  stopping transition (Stop hook halts while steering pending → run ends
  canceled, cause `{kind:'hook'}`); detached point does not cancel; the notice
  contains the discarded-input warning.

### F3 — `systemMessage` surfaces in the TUI

- New bridge helper:

```ts
function surfaceNotices(point: string, merged: MergedHookOutcome | { systemMessages: string[] }, agent: Agent | undefined): void
```

  For each non-empty message, after shaping
  (`replace(/\s+/g,' ').trim()`, truncated to 200 chars, fallback
  `(<point> hook message)` when empty): `agent.inject(createUserMessage({
  content: [{type:'text', text}], source: {kind:'plugin', plugin:'hooks-claude-code', form:'notice', summary} }))`
  when an agent handle exists, else `logger.warn` only.
- Applied at every `runPoint` call site (synchronous and detached `.then`)
  using the shared helper; remove the per-output "not yet surfaced" warns in
  `run-point.ts:120-122`. The F1 stop-cap override and F2 halt messages flow
  through the same helper (they are bridge-synthesized notices added to
  `merged.systemMessages` before surfacing).
- Accepted degradation (documented in both READMEs): notice-form messages are
  model-facing in dsh (they enter session history), whereas CC's
  `systemMessage` is user-only. Ratio: this is the only durable rendered
  channel. Notices use `source.kind:'plugin'`, so they never look like user
  input to the TUI and never reset the F1 counter.
- Tests: TUI transcript fold already covered by the existing contract spec;
  bridge specs assert the injected message shape (form/summary/text) per
  point; empty/whitespace-only messages produce the fallback label; no-agent
  path warns and never throws.

### F4 — PreToolUse `allow` pre-approves

Register the listener first and re-map decisions:

```ts
ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
  // … runPoint …
  if (halted) return { kind: 'deny', reason: … }            // F2
  if (merged.decision === 'deny') return { kind: 'deny', reason: merged.reason ?? 'blocked by PreToolUse hook' }
  const downstream = await next()
  if (downstream.kind === 'deny') return downstream         // hard boundaries beat hooks
  if (merged.decision === 'ask') return { kind: 'ask', …reason }
  if (merged.decision === 'allow') return { kind: 'allow' } // suppress the permission prompt
  return downstream
}, { prepend: true })
```

- `{ prepend: true }` follows the session-cwd precedent so hooks are consulted
  before permission-rules regardless of compose order.
- Deny keeps short-circuiting exactly as today (no new downstream effects on
  hook-denied calls).
- Ask/allow delegate first so a downstream boundary **deny** still wins
  (rule denies, the cwd boundary guard); a hook `ask` on that call becomes
  deny — stricter than today and the safety loop this PR exists for.
- Guards already re-check `allow` (`runtime-execute.ts:180-183`), so a hook
  allow cannot bypass runtime integrity guards.
- Tests: allow suppresses the prompt (no approval request fired, tool runs);
  hook allow + downstream deny → denied; hook deny → tool never runs; hook ask
  + downstream deny → deny; no hook decision → downstream untouched. The
  allow-vs-boundary invariant is exercised with the boundary listener
  registered both before and after the bridge (both load orders).

### F5 — Hook issues visible in `/doctor`

New module `packages/hooks/hook-protocol/src/diagnostics.ts`:

```ts
export type HookIssueKind = 'timeout' | 'exit-code' | 'parse-failure' | 'spawn-failure' | 'stop-cap' | 'config'
export interface HookIssue { ts: string /* ISO */; dialect: HookDialect; point: string; kind: HookIssueKind; detail: string; handlerId?: string }
export function hookDiagnosticsWriter(path: string): (issue: HookIssue) => void   // best-effort, never throws
export function readHookDiagnostics(path: string, limit: number): HookIssue[]      // last N valid lines, malformed lines skipped
```

Writer rules: `detail` hard-capped at 500 chars; append one JSON line; before
appending, if the file exceeds 256 KB, rewrite it keeping the last 100 valid
lines plus the new entry. All fs errors swallowed (diagnostics must never
break a hook). Concurrency posture (documented): append+truncate is
best-effort across processes; readers skip torn lines.

Detection and recording:

| Kind | Detector |
|---|---|
| `timeout` | `runner.ts` threads `result.timedOut` onto `output.timedOut`; run-point records with the effective timeout in `detail` |
| `spawn-failure` | `runHook` catch path / signal-death (`exitCode === undefined`) |
| `exit-code` | recorded when `exitCode ∉ {0, 2}` (2 is an intentional block, not an error); `detail` = `exit N: <stderr summary>` |
| `parse-failure` | `codec.ts` sets `output.parseFailure = true` when exit is 0 and trimmed stdout starts with `{` but JSON.parse throws **or the result is not a plain object** (review amendment) |
| `stop-cap` | F1 override site |
| `config` | F6 warnings at load |

Storage: `ctx.dshHomePath('hooks', 'diagnostics.jsonl')`; when
`ctx.dshHomePath` is absent the writer is a no-op. Rationale for a file over
a cordis service: the leakedServices gate forbids service publication from
inside `cc-services`, `/doctor` lives outside the isolate realm, and a dsh-home
file is process- and realm-agnostic.

`hook/result` session events additionally gain optional `timedOut` /
`parseFailure` booleans (additive to `SessionEventMap` in protocol types, in
`appendHookResult`).

`command-doctor`: `DoctorReport` gains
`hooks?: { issues: HookIssue[]; total: number }`; gather reads the file (limit 10
for display, count all valid lines for `total`) via `ctx.dshHomePath` (absent
→ `hooks: { issues: [], total: 0 }` rendering `Hooks: no issues recorded`).
`formatDoctorReport` renders a trailing section:

```
Hooks: 3 issue(s) recorded (~/.dsh/hooks/diagnostics.jsonl)
  [2026-09-03T10:00:00Z] PreToolUse timeout after 600000 ms (claude-code)
  …
```

Adds a workspace dependency `@dsh-cc/hook-protocol` to
`command-doctor`'s package.json (root export only — `check:deep-imports`
stays green).

### F6 — Startup warnings for unsupported handler options (and friends)

`parseClaudeCodeConfig` returns `{ config, skipped, warnings }` where
`warnings: HookConfigWarning[]` = `{ event, matcher?, hookType, keys: string[] }`.
Emit one warning per offending handler for keys outside the allowlist
(base `{type, timeout}`; + `command` for command; + `prompt, model` for
prompt/agent; + `url, headers, allowedEnvVars` for http). Reviewed additions:
- one warning per **unknown event key** in the hooks map (typo'd event names
  are today silently dropped pre-parse);
- one warning per matcher-group carrying unknown group-level keys (only
  `matcher`/`hooks` are read);
- a `type:'command'` hook missing a string `command` now also lands in
  `skipped` (today it vanishes without a trace).
Bridge `apply()` logs each warning via `ctx.logger.warn` and records it as an
F5 `'config'` diagnostic. Malformed-regex `SyntaxError` behavior unchanged.

### F7 — Count/list consistency

- Rewrite the support paragraph in `README.md` and `README.zh.md`: the
  supported enumeration must be exactly the 18 `CLAUDE_EVENTS`; the unsupported
  enumeration lists all 14 names (the current 13 + `UserPromptCancel`) with the
  Notification-subtype and SessionResume-source notes kept as prose. Drop the
  "of Claude Code's current N" global baseline (unverifiable offline; review);
  keep the link to the official reference.
- Export the supported list from `config.ts` (e.g.
  `export const SUPPORTED_CLAUDE_EVENTS: readonly string[] = CLAUDE_EVENTS`).
- New docs-consistency spec in `hooks-claude-code/tests/`: regex-extract
  backticked event names from each README's supported/unsupported sentences
  and assert (a) supported set === `SUPPORTED_CLAUDE_EVENTS`, (b) the stated
  unsupported count equals the enumerated count, for BOTH locales.
- Fix the stale `index.ts:335` comment; `grep -rn "of Claude Code's"` across
  `packages/hooks/**` must be clean afterwards (comment and docs consistent).

### S1 — PreToolUse `additionalContext`

In the PreToolUse listener, when the merged decision is not `deny` and
`merged.additionalContext.length > 0` and an agent exists:
`agent.inject(contextFrom(merged))`. The context lands in the loop's
post-result FIFO, so it is visible from the next model request. Documented
ordering divergence vs CC (CC attaches it to the tool call itself); deny
carries the hook reason instead. No-agent callsites log only.

### S2 — PostToolUse `updatedToolOutput`

- Codec parses `hookSpecificOutput.updatedToolOutput` (any JSON value) and
  `updatedMCPToolOutput`; `HookOutput` gains both fields.
- `merge.ts` gains `updatedToolOutput?: unknown` (and the MCP variant): the
  **last** non-undefined writer wins, documented.
- Bridge PostToolUse mapping: a `block` decision wins over replacement
  (feedback already carries the reason). Otherwise run the existing
  downstream fold; apply the hook replacement only when the downstream
  decision is a plain `accept` with no `content`/`value` of its own
  (downstream/boundaries win). Replacement shape:
  `{ kind:'accept', content:[{type:'text', text}] }` where `text` is the
  string as-is or `JSON.stringify(value)` for non-strings — canonical value
  is preserved, only the model-facing projection is replaced. The MCP variant
  applies only when the tool name starts with `mcp__`; mismatched fields are
  ignored (debug log).
- Documented degradation: non-text (e.g. image) tool content is flattened to
  text on replacement.

## Risks and mitigations (from review)

1. **Dual steer-owners on `turn-stopping`** (dsh-agent itself steers on
   pending steering). Covered by tests: "Stop block + pending steering" and
   "cancel during the stopping transition" (F2 test list).
2. **Halt discards queued user input** — accepted CC parity; mandatory
   discarded-input sentence in the F2 notice; documented.
3. **Notices are model-facing** and re-enter the UserPromptSubmit payload —
   accepted, documented; plugin source keeps them out of the user row and the
   F1 reset.
4. **Diagnostics JSONL is shared mutable state** — capped `detail`,
   skip-malformed-on-read, documented best-effort truncate.
5. **Pre-execute ordering is registration-order dependent** — F4 test pins the
   invariant under both listener orderings; guard re-check on `allow` is the
   backstop.

## Implementation order (TDD, one PR)

1. `hook-protocol`: codec `parseFailure` (+ non-object JSON), runner
   `timedOut`, types + `events.ts` additive fields, `diagnostics.ts` writer/reader — unit specs first.
2. `hooks-claude-code/config.ts`: warnings + `SUPPORTED_CLAUDE_EVENTS` export — `config.spec.ts` first.
3. Bridge `run-point.ts`: diagnostic recording + remove dead warns; bridge
   `payloads.ts`: `stop_hook_active` parameter.
4. Bridge `index.ts`: F3 notices helper; F4 listener rewrite; F1 counter; F2
   halt across the five seams; S1; S2. Failing integration specs per behavior
   first (`coverage-stop.spec.ts`, `coverage-cases.ts`, `bridge.spec.ts` styles).
   The two degraded-behavior specs in `coverage-cases.ts` (`continue:false`
   line ~513, systemMessage line ~822) flip to assert honored behavior.
5. `command-doctor`: report shape + gather + render + spec.
6. README en/zh rewrites + docs-consistency spec; sweep
   `grep -rn "of Claude Code's" packages/hooks`; remove the two resolved TODO
   markers.
7. S2 if it lands cleanly after step 4; otherwise split into a follow-up PR
   (it is the least safety-critical item).

## Verification (the PR must show)

- `bash scripts/link-worktree-deps.sh` once in a fresh worktree.
- `pnpm --filter @dsh-cc/hook-protocol test` and
  `pnpm --filter @dsh-cc/hooks-claude-code test` and
  `pnpm --filter @dsh-cc/command-doctor test` green.
- Repo gates: `pnpm typecheck`, `pnpm test`, `pnpm check:deep-imports`,
  `pnpm check:exports`, `pnpm check:spec-deps`, `pnpm check:size`.
- Manual contract: with a hooks.json that denies Stop 12 times, the 9th
  turn-stopping shows the override notice in the TUI and the run ends.

## Docs to update in the same PR

- `packages/hooks/hooks-claude-code/README.md` + `README.zh.md`: drop the F2/F3/F4
  "partial/not-yet" claims, document each accepted degradation (notice
  model-visibility, halt inbox-drop, S1 ordering, S2 flattening, detached-halt
  no-op), F7 rewrite.
- Remove `TODO(hook-continue-false)` (`index.ts`) and `TODO(stop-loop-guard)`
  (`index.ts`).
