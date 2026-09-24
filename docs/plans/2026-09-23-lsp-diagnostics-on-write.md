# LSP diagnostics-on-write via the running serena language servers

**Status:** **Shipped-candidate** — critic cold review round 2 (2026-09-23)
incorporated (GO-WITH-AMENDMENTS): omp fact drift corrected, harness
citations re-attributed to in-repo @dsh-cc/tools, callTool wiring pinned to
connection.ts/registry seams, runtime tool-name set pinned (incl. capitalized
NotebookEdit), lazy warn-once debug semantics, path-resolution base pinned,
full new-package checklist added.
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
(`oh-my-pi/packages/coding-agent/src/lsp/writethrough.ts`), verified
2026-09-23: omp's settings are `lsp.formatOnWrite` (default false),
`lsp.diagnosticsOnWrite` (default **true**), and `lsp.diagnosticsOnEdit`
(default **false** — the edit path is opt-in; only write defaults on)
at `packages/coding-agent/src/config/settings-schema.ts:3852/3863/3874`;
the inline pull is raced against a 500 ms cap (`INLINE_DIAGNOSTICS_WAIT_TIMEOUT_MS`,
`packages/coding-agent/src/lsp/diagnostics.ts:53`, raced at
`writethrough.ts:278-293`), and stale results are rejected against
pre-captured `expectedDocumentVersions` (`writethrough.ts:355,427`). The
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
recorded in §4.3 of the turn-rules doc (Matching seams, value-accept guard at
`docs/plans/2026-09-23-turn-rules.md:180-182`; value/content accept shapes are
pinned in-repo at `packages/core/tools/src/tool-types.ts:310-313` (three-variant
PostToolDecision union) and `packages/core/tools/src/runtime-results.ts:57-89`
(content+value co-presence guard at `:67-68`) in @dsh-cc/tools — the sibling
harness repo has no such file paths; its equivalent is
`packages/core/tools/src/index.ts:590-593` there).

Tool matcher: the runtime `exec.name` values matched are the harness-native
spellings ONLY — `edit`, `write`, and `NotebookEdit` (capitalized at runtime —
`packages/core/tool-notebook-edit/src/index.ts:130`; this capitalization is a
trap). The file-path argument key is `file_path` for edit/write and
`notebook_path` for NotebookEdit (`:137,:177`).
`packages/core/tools/src/cc-names.ts` is a restrict-surface translation table
and is NOT consulted here. `mcp__…`-prefixed names are excluded inherently by
Set membership — no startsWith guard (§4.4). `toolNames` settings override
replaces this set wholesale. Precedent for tool-name matching at this seam:
`packages/interaction/edit-recovery-hint`.

### 4.2 Diagnostics source: direct MCP call, never the waterfall

This design **owns a scope change to `packages/mcp/mcp-client`**:
`McpConnectionsService` (`packages/mcp/mcp-client/src/registry.ts:64`) today
exposes only `onDidChange/register/unregister/report/setToolCount/
setToolBreakdown/entries/disconnect/reconnect` — there is no tools/call
passthrough. A new method is added,
`callTool(name, rawName, args, options)` (pinned wiring plan below), wired
from the
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
`relative_path` (computed relative to the session cwd via
`getSessionCwd(exec.agent)` from @dsh-cc/session-cwd — post-edit-verify
`wiring.ts:75` precedent; `exec.agent === undefined` → drop silently).
Known-accepted limitation, documented: serena resolves `relative_path` against
its own project root, which normally equals the session cwd; if they differ the
call returns empty or drops — caught by the dogfood recipe (§5) and one spec
asserting cwd-relative computation. Then `start_line` 0-based (default 0),
`end_line` -1 (always — whole file; caps apply at render, no line-windowing
logic), `min_severity` integer 1 for errors-only / 2 for errors+warnings per
settings (verified against the live serena MCP tool schema at runtime,
2026-09-23; not pinned in-repo). A schema-drift smoke spec covers this: a
mismatched-argument call must degrade to a drop (debug counter), never throw
into the tool result.

Response parsing: `get_diagnostics_for_file` returns the grouped map as JSON
text in content block(s); the listener concatenates text blocks and
`JSON.parse` with try — parse failure = drop + debug line. Map shape
(runtime-verified 2026-09-23): `relative_path → severity (string keys
"Error"|"Warning"|"Information"|"Hint") → name_path ("<file>" when unmappable)
→ [{ message, range:{start:{line,character}} (0-based), code, source }]`.

Pull-based lookup matters here: serena's `get_diagnostics_for_file` queries
the language server on demand, so a fresh edit is reflected without waiting
for a publish-diagnostics push cycle (on-demand behavior verified against the
serena runtime probe, 2026-09-23).

Pinned callTool wiring plan:

- (a) `startConnection` (`packages/mcp/mcp-client/src/connection.ts:169`) owns
  the generation-guarded live `Client` (`:193,:332`); the control surface built
  at `index.ts:279-288` gains `callTool(rawName, args, { timeoutMs, signal })`
  implemented over that guard, reusing `callToolUncached`
  (`packages/mcp/mcp-client/src/tools.ts:156-166` — currently module-private;
  export it or move it to a shared module) so `timeoutMs`/`signal` flow into
  the MCP SDK RequestOptions exactly as the executor path already does
  (`:166-169`);
- (b) the `McpConnectionControl` type (`registry.ts`) gains `callTool`;
- (c) `McpConnectionsService` gains
  `async callTool(name, rawName, args, options)`: `require(name)` → delegate to
  `control.callTool` — absent control method or disconnected → throw;
- (d) MCP `isError: true` → throw, preserved from `tools.ts:435-437`;
- (e) the mcp-client package ships its own specs for callTool (present →
  delegates; absent server → throws; absent callTool control → throws).

Architectural posture (record here and in the PR body): callTool deliberately
bypasses the tools waterfall, hence permission gating and the tool-call audit
trail, BY CONSTRUCTION; it is sanctioned for harness-internal read-only
inspection tools, and any future arbitrary use must re-justify against the
permission system.

### 4.3 Latency budget (cold-review gate)

Async work inside a post-execute listener with a clamped timeout is
precedented by post-edit-verify's runner
(`packages/interaction/post-edit-verify/src/runner.ts:93-112`), but that
mechanic (delegated to ShellExecutor via `request.timeoutMs`) can **not** be
reused for an MCP call: instead, the listener derives an effective signal from
`exec.signal` combined with `AbortSignal.timeout(timeoutMs)` and threads it
through callTool (RequestOptions timeout aborts — the catch treats AbortError
identically to any reject: drop). No new concurrency model.

The cold review's condition: this feature must never tax every edit with
language-server lag. Mechanics:

- the tools/call is raced against `settings.timeoutMs` (default 1500;
  rationale: omp's 500 ms inline cap buys promptness for an on-by-default
  feature, ours is opt-in dark and the real failure mode at too-tight budgets
  is silent drops on cold language servers, misread as "serena doesn't work";
  dogfood will report drop rate and p50/p95 (see §5), tighten later if
  p95 ≪ 500);
- on timeout or error: drop, increment a debug counter (debug-channel
  precedent: PR #123 auto-classifier debug channel), append nothing;
- diagnostics are *not* awaited when the MCP connection crash-loops: after
  3 consecutive dropped calls keyed by serverName (closure-scoped counter —
  serena's internal LSP servers are invisible to us, so the breaker watches
  the MCP connection, not the language server), the listener auto-disables
  for the rest of the session (one debug line), mirroring the
  circuit-breaker posture of our auto classifier
  (`packages/interaction/permission-rules/src/classifier-breaker.ts:15`);
- phase-2 option (documented, not built): deferred delivery — a timed-out
  query is remembered and its result prepended into the *next* tool result,
  the shape omp ships as `deferred-diagnostics.ts`. Only pursued if dogfood
  shows meaningful timeout drop rates.

### 4.4 Recursion ban (cold-review gate)

Dispatching through `ctx.tools` would re-fire post-execute for the diagnostics
call itself. The call therefore must **not** pass through `ctx.tools` **by
construction**: the call goes through the service method directly (the
`callTool` method of §4.2) and therefore never enters the waterfall — recursion
is banned by construction. The matcher's Set membership inherently excludes
`mcp__…` tool names even if some other path runs them through the waterfall.
A spec pins this at the real registry path: the §5 spec asserts exactly one
MCP call per edit at the service boundary, not merely a fake waterfall.

### 4.5 Output shape, caps, filtering

Rendered inside the tool result as a compact block, e.g.:

```
[lsp] src/foo.ts: 2 problems
  E2345 12:7 argument of type 'string' is not assignable to parameter of type 'number'
  W6133 40:11 'ctx' is declared but its value is never read
```

Rules: errors before warnings; line:col shown 1-BASED (runtime ranges are
0-based → +1); `E`/`W` prefix + diagnostic code (e.g. `E2345`);
`maxDiagnostics` default 8; total block cap 4 KB — whenever entries are
hidden (by either knob), a reconciled `… (N more)` suffix follows (counts
always reconcile: header total == shown + N); path rendered relative to cwd; severity filter
`errors-only | errors+warnings` (default errors+warnings). Request args cap at
render time only (`start_line` 0, `end_line` -1 always — no line-windowing
logic).

Compose mechanics (content-accept decisions only): base =
`downstream.content ?? result.content`; return
`{ kind: 'accept', content: [...base, lspBlock], ...preserve downstream.additionalContexts }`.
Value-accept / block / passthrough downstream → return downstream untouched
(the runtime throws on content+value co-presence). The whole listener body is
wrapped in try/catch → `ctx.logger.warn` + return downstream (a throw would
turn the user's tool result into an error — data loss).

### 4.6 Settings

Settings mechanism: new kebab namespace `cc-lsp-on-write` via
`registerNamespaceSafe('cc-lsp-on-write', schema)` for the
settings surface plus a local minimal raw reader (fs + `JSON.parse`, fail-soft)
of the USER-layer settings.json read per event (hot reload for free; project
scope invisible by design — settings-cascade's `readUserFile` is not
package-exported; post-edit-verify `settings.ts:110-114` + `wiring.ts:72`
precedent). Debug output is plain ungated `ctx.logger.debug`
(post-edit-verify precedent, `wiring.ts:50` etc.), no env gate; drop counters
are included in the debug line.

- `enabled` default **false** (ships dark; dogfood opt-in at user layer,
  same graduation posture as post-edit-verify, `docs/dogfood/post-edit-verify.md`);
- `serverName` default `'serena'`; connection names come from the user's MCP
  config key, so a renamed serena mount yields zero diagnostics — the
  "no server named <serverName> registered" line (logger.warn) is LAZY: emitted
  warn-once, at most once per session, on the FIRST matched edit whose registry
  lookup fails — service absent OR server not registered (there is no
  session-start hook at this seam; serena may connect later than session start
  anyway). Server-missing is warn-once, NOT a drop: it must not charge the
  §4.3 breaker;
- `timeoutMs` default 1500; `maxDiagnostics` default 8;
- `minSeverity` default `'warning'` (errors+warnings);
- `toolNames` override list, default undefined (override replaces the §4.1
  set; keep this the last knob — no per-tool severity).

Config-file keys are kebab (context-crusher convention): `server-name`,
`timeout-ms`, `max-diagnostics`, `min-severity`, `tool-names` — the schema
maps them onto the camelCase internal shape.

### 4.7 Packaging

Plain plugin `packages/interaction/lsp-on-write` (`@dsh-cc/lsp-on-write`),
`apply(ctx)` + no Service (isolate-map pin untouched, per the twelve-key
`toEqual` in `packages/preset/cc/tests/composition.spec.ts:~188`). One preset
row beside post-edit-verify with an ordering comment; the preset composition
spec gains the house-standard `toContain` + ordering assertion pinning the new
`lsp-on-write` row after the post-edit-verify / edit-recovery-hint rows.

New-package registration checklist (verified 2026-09-23):

1. Create `packages/interaction/lsp-on-write` with `README.md` +
   `README.zh.md` + `README.i18n.yaml` (record hashes via
   `pnpm check:readme --write`).
2. Add `"@dsh-cc/lsp-on-write": "workspace:^"` to
   `packages/preset/cc/package.json` dependencies and run pnpm install
   (lockfile).
3. Add `{ "path": "./packages/interaction/lsp-on-write" }` to
   `tsconfig.packages.json` (`tsconfig.base.json` paths need NO entry).
4. Preset row in `agent.cordis.yml` after the post-edit-verify /
   edit-recovery-hint rows with an ordering comment (no isolate key needed —
   plain plugin; the twelve-key isolate `toEqual` at
   `packages/preset/cc/tests/composition.spec.ts:188-201` stays untouched).
5. Composition spec gains the house-standard `toContain` + ordering assertion
   (precedents `:214-230`).
6. `pnpm-workspace.yaml` glob `packages/*/*` already covers it — no change.
7. `check:spec-deps` — every package the specs import must be declared in the
   new package's devDependencies.

Implementation order:

1. mcp-client callTool + specs;
2. new package (settings, wiring, compose/parse/render, specs);
3. preset row + composition pin + tsconfig ref + package.json dep + README
   trio;
4. manifest + parity regen;
5. full gates: package tests, preset composition spec,
   `node_modules/.bin/tsc -b tsconfig.packages.json`, `check:spec-deps`,
   `check:capabilities`, `check:parity`, `check:readme`.

### 4.8 Capability manifest impact (implementation PR, same commit)

`engine.ide-lsp` currently reads `mounted: false`, `behavioral: partial`
(`docs/claude-code-capabilities.yaml:409` block; read 2026-09-23). On ship:
flip `mounted: true` with preset-row anchor evidence
`anchor: "- id: lsp-on-write"` (validator rule I4: mounted+plane:preset
requires anchored preset evidence); behavioral and ux stay `partial`
(rule I3: ux:full would require behavioral:full) — diagnostics-only, no
navigation surface; extend the existing deviation note (serena-MCP
dependency, settings-gated, dark default). Regenerate docs via
`pnpm docs:parity` and commit the regenerated trio
(`docs/cc-parity-matrix.md`, README parity block,
`docs/claude-code-capabilities.json`); gates `pnpm check:capabilities` +
`pnpm check:parity` green.

## 5. Verification

- **Unit specs**: fake `McpConnectionsService` (injected via the same
  `ctx.get('mcpConnections')` lookup against a bare cordis Context — the
  real-shell insertion precedent from PR #93 applies) covering:
  args shape, severity mapping, cap/truncate math, timeout→drop,
  error→drop, breaker auto-disable at 3, matcher table (incl. NotebookEdit
  capitalization and mcp__ non-match-by-construction),
  one-MCP-call-per-edit-at-the-service-boundary recursion pin, schema-drift
  smoke (mismatched-argument call degrades to a drop, never throws into the
  tool result), concatenated-text-blocks parse, cwd-relative path
  computation, value-accept/passthrough untouched.
- **Preset composition**: `composition.spec.ts` passes unchanged, plus the
  new `toContain` + ordering assertion for the `lsp-on-write` row (§4.7).
- **Smoke (spec)**: nearest faithful seam — no in-process preset-session spec
  exists in `packages/preset/cc/tests` (only YAML composition assertions), so
  the mounted `tools/post-execute` listener is driven end-to-end with a fake
  registry: a scripted edit returns a tool result whose text ends with the
  `[lsp]` block; with the registry absent the result is byte-identical to
  baseline.
- **Dogfood (pre-merge, recorded in PR)**: user-layer enable
  (`cc-lsp-on-write.enabled`) on a real TS repo with serena connected (whose
  root == session cwd — the §4.2 relative_path limitation); edit a
  file to introduce a type error; capture the tool result containing the
  `[lsp]` block on the same call; measure added latency over 20 edits and
  state p50/p95 against the 1500 ms budget in the PR body. The PR body MUST
  also report the drop rate (timeout+error drops / total). House precedent
  may allow merging dark with dogfood as a recorded follow-up
  (post-edit-verify PR #93, edit-recovery-hint PR #104 both shipped dark with
  dogfood deferred) — record in the PR body which actually happened.

## 6. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Serena adds tail latency to every edit | §4.3 budget + crash-loop breaker + ships dark |
| Diagnostics stale for just-written content | pull-based lookup (§4.2); omp guards via `expectedDocumentVersions` (`writethrough.ts:355,427`); our design accepts the known-stale mode (serena pulls post-write from its own file view; its file-watcher lag can yield pre-edit diagnostics labeled post-edit), no version guard in this phase; a spec asserts drop-not-stale-render on call failure |
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

1. Package mounted in the cc preset; §5 specs green incl. the recursion pin;
   full new-package registration checklist (§4.7) completed.
2. Dogfood capture: one real type error surfaced inside the edit tool result,
   with p50/p95 added-latency numbers in the PR body.
3. `engine.ide-lsp` manifest entry updated with evidence in the same PR;
   `pnpm check:capabilities` + `pnpm docs:parity` green.
4. Session auto-disable behavior exercised once in dogfood or forced in spec.
