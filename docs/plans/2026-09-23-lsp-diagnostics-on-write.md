# LSP diagnostics-on-write via the running serena language servers

**Status:** **Proposed** — critic cold review round 1 (2026-09-23)
incorporated: design now owns the mcp-client passthrough addition (callTool
on McpConnectionsService), serena arg schema pinned with runtime-verified
citation, recursion pin made constructional, twelve-key pin corrected + new
ordering assertion, server-name dependency documented with debug line.
**Date:** 2026-09-23
**Worktree:** `.claude/worktrees/oh-my-pi` (branch `worktree-oh-my-pi`)

## 1. Problem

Edit/write errors surface late. dsh-cc already has post-edit-verify
(opt-in, PR #93): after an edit lands, a *user-configured shell command* runs
and its tail is appended into the same tool result. That works but is
zero-value out of the box — nothing is configured until the user writes rules.

Meanwhile serena, when connected, already runs real language servers for the
workspace (`docs/code-intelligence-health.md`). oh-my-pi demonstrates the
product shape of exploiting that: every write/edit goes through an LSP
writethrough that can pull diagnostics for the touched file immediately
(`oh-my-pi/packages/coding-agent/src/lsp/writethrough.ts`, settings
`lsp.formatOnWrite` / `lsp.diagnosticsOnWrite`; verified 2026-09-23). The
agent sees "argument of type X is not assignable" in the *same* tool result as
its edit and self-corrects next step, instead of finding out at test time or
never.

## 2. Goal

After a successful mutating file tool call (edit, write, notebook edit), append
the touched file's current diagnostics (errors first, warnings optionally)
into the same tool result, sourced from serena's language servers, with:

- hard latency budget per call (default 1500 ms), best-effort: timeout or any
  error degrades to "no diagnostics appended", never to a failed tool result;
- zero recursion: the diagnostics request never re-enters the tools waterfall;
- zero noise when serena is absent, disconnected, or has no server for the
  file's language;
- the whole feature dark by default (settings-gated), graduated by dogfood
  evidence.

## 3. Non-goals

- format-on-write and `workspace/willRenameFiles` semantics (omp has both;
  formatting mutates content, willRenameFiles needs edit-time orchestration —
  separately reviewable, not bundled here).
- Starting or managing language servers ourselves. If serena isn't running a
  server for the language, there is nothing to report. This feature is a
  consumer of the existing serena connection, not an LSP client.
- Diagnostics for read-only tools, subagent isolation differences, or TUI
  display changes (diagnostics ride inside the tool result text; the card
  renderer needs no change).

## 4. Design

### 4.1 Seam and ordering

A `tools/post-execute` listener registered **without** `prepend`, composed like
post-edit-verify so the context-crusher remains the outermost listener
(contract documented at `packages/preset/cc/agent.cordis.yml:517,527`;
crusher's own prepend registration at
`packages/context/context-crusher/src/index.ts:4`). The diagnostics block is
appended **inside** the crusher/defer machinery's view of the same result, so
an appended block participates in the same accept-decision rewriting rules
recorded in §4.2 of the turn-rules doc (value/content accept shapes; harness
`@deepseek-ai/dsh-tools tool-types.ts:310-312`, `runtime-results.ts:56,67-68`).

Tool matcher: canonical names for `edit`, `write`, `notebook edit` in both the
CC-facing and harness-native spellings (the alias/matcher tables exist for
rule/matcher matching per the `engine.agent-loop` capability summary);
precedent for tool-name matching at this seam:
`packages/interaction/edit-recovery-hint`. The matcher explicitly excludes any
`mcp__…`-prefixed name (§4.4).

### 4.2 Diagnostics source: direct MCP call, never the waterfall

This design **owns a scope change to `packages/mcp/mcp-client`**:
`McpConnectionsService` (`packages/mcp/mcp-client/src/registry.ts:64`) today
exposes only `onDidChange/register/unregister/report/setToolCount/
setToolBreakdown/entries/disconnect/reconnect` — there is no tools/call
passthrough. A new method is added, e.g.
`callTool(serverName, rawName, args, { timeoutMs, signal })`, wired from the
connection supervisor's live client and reusing the raw uncached `tools/call`
pattern already owned by the executor factory (`packages/mcp/mcp-client/src/tools.ts:156,410`
area: the executor closes over the raw MCP tool name and sends an uncached
`tools/call`, mapped to harness ContentBlocks; an MCP `isError: true` surfaces
as a throw). This explicitly widens the registry's public contract and ships
with its own specs inside the mcp-client package. The previous wording
claiming the executor contract is directly consumable is withdrawn.

The listener consumes `ctx.get('mcpConnections')`
(`packages/mcp/mcp-client/src/index.ts:235-237`) and that new `callTool`
method: it resolves the connection named `serena` and issues an **uncached**
`tools/call` with the raw tool name `get_diagnostics_for_file`. Arguments:
`relative_path` (session-cwd relative), `start_line` 0-based (default 0),
`end_line` default -1, `min_severity` where 1=Error, 2=Warning per settings
(verified against the live serena MCP tool schema at runtime, 2026-09-23; not
pinned in-repo). A schema-drift smoke spec covers this: a mismatched-argument
call must degrade to a drop (debug counter), never throw into the tool result.

Pull-based lookup matters here: serena's `get_diagnostics_for_file` queries
the language server on demand, so a fresh edit is reflected without waiting
for a publish-diagnostics push cycle (behavior consistent with the runbook's
"cheap probe" usage, `docs/code-intelligence-health.md`).

### 4.3 Latency budget (cold-review gate)

Async work inside a post-execute listener with a clamped timeout is
precedented by post-edit-verify's runner
(`packages/interaction/post-edit-verify/src/runner.ts:93-112`), so the
mechanics below carry no new concurrency model.

The cold review's condition: this feature must never tax every edit with
language-server lag. Mechanics:

- the tools/call is raced against `settings.timeoutMs` (default 1500);
- on timeout or error: drop, increment a debug counter (debug-channel
  precedent: PR #123 auto-classifier debug channel), append nothing;
- diagnostics are *not* awaited when the language server has crashed-loop
  signatures: after 3 consecutive dropped calls for one language server, the
  listener auto-disables for the rest of the session (one debug line),
  mirroring the circuit-breaker posture of our auto classifier
  (`packages/interaction/permission-rules/src/auto-stage.ts`);
- phase-2 option (documented, not built): deferred delivery — a timed-out
  query is remembered and its result prepended into the *next* tool result,
  the shape omp ships as `deferred-diagnostics.ts`. Only pursued if dogfood
  shows meaningful timeout drop rates.

### 4.4 Recursion ban (cold-review gate)

Dispatching through `ctx.tools` would re-fire post-execute for the diagnostics
call itself. The call therefore must **not** pass through `ctx.tools` **by
construction**: direct service call only (the `callTool` method of §4.2), and
the listener's own matcher ignores `mcp__…` tool names even if some
other path runs them through the waterfall. A spec pins this at the real
registry path: the §5 spec asserts the actual registry-path invocation count
(one MCP call per edit at the service boundary), not merely a fake waterfall.

### 4.5 Output shape, caps, filtering

Rendered inside the tool result as a compact block, e.g.:

```
[lsp] src/foo.ts: 2 problems
  E2345 12:7 argument of type 'string' is not assignable to parameter of type 'number'
  W6133 40:11 'ctx' is declared but its value is never read
```

Rules: errors before warnings; `maxDiagnostics` default 8; total block cap
4 KB (truncate with `… (N more)`; counts reconcile); path rendered
relative to cwd; severity filter `errors-only | errors+warnings`
(default errors+warnings).

### 4.6 Settings

New kebab namespace `cc-lsp-on-write` (`registerNamespaceSafe` precedent,
`packages/interaction/post-edit-verify/src/settings.ts`):

- `enabled` default **false** (ships dark; dogfood opt-in at user layer,
  same graduation posture as post-edit-verify, `docs/dogfood/post-edit-verify.md`);
- `serverName` default `'serena'`; connection names come from the user's MCP
  config key, so a renamed serena mount yields zero diagnostics — the listener
  emits one explicit debug line `no server named <serverName> registered` at
  session start when absent;
- `timeoutMs` default 1500; `maxDiagnostics` default 8;
- `minSeverity` default `'warning'`; `toolNames` override list.

### 4.7 Packaging

Plain plugin `packages/interaction/lsp-on-write` (`@dsh-cc/lsp-on-write`),
`apply(ctx)` + no Service (isolate-map pin untouched, per the twelve-key
`toEqual` in `packages/preset/cc/tests/composition.spec.ts:~188`). One preset
row beside post-edit-verify with an ordering comment; the preset composition
spec gains the house-standard `toContain` + ordering assertion pinning the new
`lsp-on-write` row after the post-edit-verify / edit-recovery-hint rows.

### 4.8 Capability manifest impact (implementation PR, same commit)

`engine.ide-lsp` currently reads `mounted: false`, `behavioral: partial`
(`docs/claude-code-capabilities.yaml:409` block; read 2026-09-23). On ship:
flip `mounted: true`, re-evaluate behavioral/ux (plausibly still `partial`
— diagnostics only, no navigation surface), attach source+test evidence, and
record the serena-dependency deviation. Regenerate parity docs.

## 5. Verification

- **Unit specs**: fake `McpConnectionsService` (injected via the same
  `ctx.get('mcpConnections')` lookup against a bare cordis Context — the
  real-shell insertion precedent from PR #93 applies) covering:
  args shape, severity mapping, cap/truncate math, timeout→drop,
  error→drop, crash-loop auto-disable at 3, matcher name tables
  (incl. mcp__ exclusion), one-MCP-call-per-edit-at-the-service-boundary
  recursion pin, schema-drift smoke (mismatched-argument call degrades to a
  drop, never throws into the tool result).
- **Preset composition**: `composition.spec.ts` passes unchanged, plus the
  new `toContain` + ordering assertion for the `lsp-on-write` row (§4.7).
- **Smoke (spec)**: in-process preset session; a scripted edit to a fixture
  file with a fake registry returning canned diagnostics produces a tool
  result whose text ends with the `[lsp]` block; with the registry absent the
  result is byte-identical to baseline.
- **Dogfood (pre-merge, recorded in PR)**: user-layer enable
  (`cc-lsp-on-write.enabled`) on a real TS repo with serena connected; edit a
  file to introduce a type error; capture the tool result containing the
  `[lsp]` block on the same call; measure added latency over 20 edits and
  state p50/p95 against the 1500 ms budget in the PR body.

## 6. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Serena adds tail latency to every edit | §4.3 budget + crash-loop breaker + ships dark |
| Diagnostics stale for just-written content | pull-based lookup (§4.2); if dogfood shows staleness, add a version-tag guard |
| MCP connection churn mid-session | registry is optional-seam by contract; every call re-resolves and degrades silent |
| Firehose bloat of context | caps in §4.5; crusher ordering keeps externalization intact |
| Engine differences across languages | severity mapping is serena-uniform (LSP 1–4); per-language quirks stay serena's problem |

## 7. Open questions

- Should the feature also fire on `multi-edit`-style batch tools if/when the
  preset exposes one (matcher list is the only delta)?
- Is a command (`/lsp on|off|status`) wanted for in-session control, or is
  settings-only enough for a dark feature (lean: settings-only, revisit after
  dogfood)?

## 8. DoD

1. Package mounted in the cc preset; §5 specs green incl. the recursion pin.
2. Dogfood capture: one real type error surfaced inside the edit tool result,
   with p50/p95 added-latency numbers in the PR body.
3. `engine.ide-lsp` manifest entry updated with evidence in the same PR;
   `pnpm check:capabilities` + `pnpm docs:parity` green.
4. Session auto-disable behavior exercised once in dogfood or forced in spec.
