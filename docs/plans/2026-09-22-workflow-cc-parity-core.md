# Dynamic workflows: CC-parity core — source resolution, inline meta, async launch, completion wake

Date: 2026-09-22. Status: **Proposed**. Origin: dynamic-workflow three-way
investigation (Claude Code docs, zcode dynamic-workflow packages, deepseek-harness
workflow packages). Sibling documents: `2026-09-22-workflow-resume-journal.md`
(resume/replay slice) and `2026-09-22-workflow-saved-commands-and-progress.md`
(`/<name>` mounting + progress row slice). Design-review record: cold review
(three-way parallel, 2026-09-22) — **GO-WITH-AMENDMENTS applied**: the idle-wake
section now states PR #31's real failure mechanism (a durable pending-inbox
message re-opens an idle turn) and justifies the product-required wake against it;
the phantom invariant-claimant premise was removed after tracing the actual mount
path (the base bundle mounts no invariant rows at all); the meta parser gained
explicit trailing-comma/comment acceptance and a CC-key-set reconciliation; the
DoD gained scripted idle-one-wake and receipt-shape assertions. Amendment
compliance re-review (2026-09-22): all five items verified RESOLVED against the
code; vacation clean. Contract re-verification (2026-09-23, against the
code.claude.com Agent SDK workflow reference and the workflows overview page on
that date, plus the pinned harness 0.1.5-rc.1 1ef9c1f): the §3.5 launch receipt
and DoD 2 field list are corrected to CC's documented `WorkflowOutput` (adds
`taskType: "local_workflow"` and a concrete use for `warning`; omits
`transcriptDir`, per-run persisted `scriptPath`, and `sessionUrl` with recorded
deviations; no-start receipts omit `taskId` despite the upstream type declaring
it required); CC's monorepo `.claude/workflows/` chain loading (v2.1.178),
built-in workflows, the `wf_` run-id prefix, and the ultracode effort-level side
effect join the manifest deviation list; §3.4's name-disagreement notice moves
onto the receipt's `warning` field; stale harness line anchors freshened
(`:54-74`, `:112-122`, `meta.ts:13-81`, `discovery.ts:39,106`).

## 1. Problem

dsh-cc already exposes a `workflow` tool, but it is the harness's thin adapter
(`tool-workflow`), whose contract diverges from what Claude Code documents for
dynamic workflows and from what models trained on those docs will try:

- **Blocking vs background.** CC's `Workflow` returns immediately with
  `{status: "async_launched", taskId, runId, ...}` and delivers the consolidated
  result as a background task completion. The harness tool awaits the whole run
  inside the tool call; a 100-agent fan-out blocks the agent step for its full
  duration.
- **Meta position is inverted.** CC scripts *begin with* a literal
  `export const meta = { name, description }`; the harness tool takes `meta` as a
  separate tool parameter and *rejects* a leading `export const meta` with a
  pointed parse error (deepseek-harness
  `packages/workflow/workflow-worker-thread/src/index.ts:54-74`). A model
  following CC documentation fails its first call deterministically.
- **No saved-workflow sources.** CC resolves `name` against `.claude/workflows/`
  (project) and the per-user workflows directory, and `scriptPath` against the
  filesystem, with precedence `scriptPath > script > name`. The harness schema
  has only `script`/`meta`/`args` (deepseek-harness
  `packages/workflow/tool-workflow/src/index.ts:216-267`).
- **Manifest overclaim.** `engine.workflow-ralph` in
  `docs/claude-code-capabilities.yaml` declares `behavioral: full`, `ux: full`,
  `deviation: none` while the surface above deviates on execution mode, source
  resolution, and meta syntax.

## 2. Current state and gap

**What exists and is reusable without harness changes (anchors verified
2026-09-22, re-verified 2026-09-23 against the CI-pinned harness
0.1.5-rc.1 = 1ef9c1f; harness paths are repo-relative to the deepseek-harness
checkout):**

- The workflow engine is a public cordis service: `WorkflowEngine extends Service`
  registered as `ctx.workflowEngine`
  (`packages/workflow/workflow/src/index.ts:156-168`) with
  `start(request: WorkflowStartRequest): WorkflowRun`
  (`packages/workflow/workflow/src/runtime-types.ts:20-39`). Request fields:
  `script`, `meta`, `args?`, `subagentProvider?`, `maxTotalAgents?`, `parent`,
  `signal?`. `WorkflowRun` exposes `{id, meta, result, cancel(), dispose()}`
  (`runtime-types.ts:40-48`); `result` never rejects and carries
  `WorkflowResult {value, stopReason, error?, agentsStarted}`
  (`workflow/src/types.ts:72-89`).
- The shipped tool-workflow package is exactly the thin adapter this document
  replaces: it calls `ctx.workflowEngine.start({script, meta, args, parent,
  signal})` (`tool-workflow/src/index.ts:272-289`), records four durable session
  events `tool-workflow/run-start|agent-start|agent-end|run-end`
  (`tool-workflow/src/types.ts:12-62`, recorder factory `index.ts:72-130`,
  parent-session append top-level only at `:290`), and injects a prompt section via
  `ctx.systemPrompt.section({name: 'tool:workflow', order:
  ctx.systemPrompt.getSectionOrder('TOOL_WORKFLOW'), ...})` (`index.ts:211-215`).
  All imports are public package roots — a third-party replacement needs zero
  harness internals.
- Engine configuration (concurrency `min(16, max(1, cores - 2))` auto-resolved,
  `maxTotalAgents` 1000, `maxItemsPerCall` 4096, `syncTimeoutMs` 5000,
  `disposeGraceMs` 5000) lives on the engine plugin row, not on the tool
  (`workflow-worker-thread/src/index.ts:112-122`); the row is ours to configure.
- In dsh-cc, both rows already sit inside the preset `delegation` group whose
  isolate map exposes `workflowEngine: true`
  (`packages/preset/cc/agent.cordis.yml` delegation group; engine row
  `workflow-worker-thread`, tool row `tool-workflow`, followed by `tool-ralph`).
- Completion/wake precedents in dsh-cc: `agent/pre-step` batch-append delivery
  with `createUserMessage` and the explicit "never `agent.inject()`" rule for
  passive notices (`packages/bundle/cc-shell/src/mcpReadyNotice.ts:159` plus the
  PR #31 phantom-wake incident it records), and the background-subagent
  collection machinery (`packages/subagent/task/src/epoch-collector.ts`,
  `suppress-settled.ts`).
- The `TOOL_WORKFLOW` prompt-section order key is registered once in the shared
  system-prompt module (`packages/core/system-prompt/src/index.ts:143`,
  `TOOL_WORKFLOW: 2600`), independent of which tool row mounts the section —
  disabling the harness tool row cannot unregister the key.
- Capability-manifest validator rules that constrain the true-up: I3 (`ux: full`
  requires `behavioral: full`), I4 (preset-plane rows need an anchored
  `agent.cordis.yml` evidence line), I7 (alphabetical placement within category).

**Gaps this document closes:** source resolution (`name`/`scriptPath`), inline
`export const meta` acceptance, async launch with immediate
`async_launched` output, completion wake, prompt-section parity, and the manifest
true-up. Deliberately not closed here (siblings own them): `resumeFromRunId`
replay, `/<name>` command mounting, TUI progress.

## 3. Design

### 3.1 Package and preset wiring

New leaf package `packages/core/tool-workflow` (`@dsh-cc/tool-workflow`),
`inject = ['tools', 'workflowEngine', 'systemPrompt']`, mirroring the harness
adapter's coupling footprint. Preset edit in `packages/preset/cc/agent.cordis.yml`
inside the existing `delegation` group (the group's isolate map already carries
`workflowEngine: true`; any consuming row must live in this realm — only
`smoke:profile-boot` catches a realm mistake):

```yaml
- id: tool-workflow          # harness adapter; superseded by @dsh-cc/tool-workflow
  name: '@deepseek-ai/dsh-tool-workflow'
  disabled: true
- id: tool-workflow-cc
  name: '@dsh-cc/tool-workflow'
```

The `workflow-worker-thread` engine row is untouched (keeps `provider: spawn`
until the resume slice switches it). Disabling the harness row avoids a
duplicate-tool-name registration failure (harness `tools` throws
"already registered"), since our tool registers the same `workflow` name.
This is the first `@dsh-cc/*` tool row mounted inside a preset isolate realm —
service realms (`cc-services`) are the established precedent, a tool row inside
the `delegation` group is new — which is why `smoke:profile-boot` gates the swap
rather than unit tests alone.

New-package registration checklist (canonical, from prior slices):
`tsconfig.base.json` paths, `tsconfig.packages.json` references, preset row +
group isolate-map key (if a new key is introduced), preset composition tests'
isolate assertions, `preset-cc` package.json dependency, internal deps as
`workspace:^` and harness deps as `link:` devDependencies, README trio
(README.md + README.zh.md + README.i18n.yaml hash record), manifest row update +
`pnpm docs:parity` three generated artifacts in the same commit, deep imports via
package roots only, `check-spec-deps` for any test-side harness import, and
`smoke:profile-boot` with the exit code captured to a file (not piped).

### 3.2 Tool parameter surface

Schema (all optional at the schema level, with cross-field validation reported as
structured errors):

| Param | Type | Semantics |
| --- | --- | --- |
| `script` | string | Inline workflow script; must begin with a literal `export const meta = {...}` block (see 3.3) unless the transitional `meta` param supplies it, body in plain JS with top-level `await`, ending `return <json>`. |
| `name` | string | A workflow saved in the project `.claude/workflows/` or the user workflows directory. Resolved to a script (3.4). |
| `scriptPath` | string | Path to a script file on disk. **Takes precedence over `script` and `name`.** |
| `args` | unknown | JSON value exposed to the script as the global `args`. |
| `meta` | object | Transitional compat with the harness form. Mutually exclusive with an inline meta block; supplying both is an error naming the ambiguity. Not documented to the model in the CC-facing description beyond one refusal line. |
| `title`, `description` | string | Accepted and ignored, mirroring CC (`the script's meta block sets the title`). Present so CC-shaped calls do not hard-fail schema validation. |

At least one of `script`/`name`/`scriptPath` is required; precedence `scriptPath >
script > name` matches CC documentation verbatim. The legal meta combinations are
exactly: `script` + inline meta block; `script` + `meta` param and no inline
block; `name`/`scriptPath` alone (the file carries its own inline meta). A
`name`/`scriptPath` call with a `meta` param is the both-meta ambiguity error —
the file's inline meta is always present (§3.4) and wins nothing by dispute.
`resumeFromRunId` is **absent**
in this slice — the model-facing description names the sibling slice's owner, and
the parameter arrives with the journal slice. Two refusal rules keep off-slice
calls loud rather than silently ignored: a supplied `resumeFromRunId` is refused
with a targeted message naming the resume slice (CC documents the parameter, so
CC-trained models will send it before that slice ships), and any other key
outside the table is refused the same way the harness adapter refuses unknown
tool options — a named error, not a schema failure.

### 3.3 Inline meta extraction

The model will produce `export const meta = {...}` from CC documentation and
training prior; the engine rejects it, so extraction happens in our tool before
`engine.start`:

1. Skip leading whitespace and `//`/`/* */` comments; require
   `export const meta =` at that position (absence without a `meta` param is a
   refusal whose message quotes the CC form, not a silent default).
2. Take the balanced `{...}` literal and parse it with a **strict literal parser**
   accepting only: strings (single/double quoted with standard escapes), numbers,
   `true`/`false`/`null`, arrays, and objects with identifier or string keys;
   trailing commas and `//`/`/* */` comments inside the literal are accepted
   (model-authored multi-line meta blocks carry trailing commas almost by
   default). Template literals, identifiers, spreads, computed keys, and
   function values are rejected. The parser is ~100 lines, dependency-free.
   **`new Function`/eval is forbidden**: meta is model-authored text and the
   wrapper runs in the harness host process, a privilege upgrade over the worker
   VM that executes the body.
3. The remaining body (meta statement stripped) is handed to `engine.start`,
   whose own `assertBodyParses` remains the authoritative syntax gate.
4. Shape validation is delegated to the engine's `validateMeta`
   (`workflow-worker-thread/src/meta.ts:13-81`): non-empty `name`/`description`,
   recognized keys only, `phases[]` entries with required `title` and optional
   `detail`/`provider`/`model`. Our extractor does not re-validate shape; it only
   locates and lifts the literal.
5. Key-set reconciliation: CC documents meta as `{name, description, phases?}`;
   the engine's recognized set `{name, description, whenToUse, phases}`
   (`meta.ts:19`) is a superset, so every CC-documented block that parses also
   passes engine validation; a key outside the engine's set fails loudly as
   `META_INVALID` naming the key.

Failure text for a malformed meta block names the concrete construct that failed
(e.g. "meta block: template literals are not allowed") so the model can repair in
one step.

### 3.4 Name resolution and scriptPath

- Project level: `<cwd>/.claude/workflows/<name>.js`.
- User level: the dsh-cc home, `resolveDshHome()` (`$DSH_HOME`, default `~/.dsh`)
  → `<dshHome>/workflows/<name>.js`. This maps CC's per-user location onto the
  established dsh-cc dual-home convention (precedent:
  `packages/compat/cc-plugin-loader/src/discovery.ts:39,106`). CC's
  `CLAUDE_CONFIG_DIR` mapping note is recorded in the manifest deviation rather
  than implemented. CC's monorepo chain loading (project workflows load from
  every `.claude/workflows/` between the working directory and the repository
  root, closest shadows, since CC v2.1.178) is likewise a recorded deviation:
  dsh-cc's `.claude` discovery convention is cwd-level, and the chain lookup
  belongs with a future repo-root discovery seam, not this slice.
- Resolution order: project shadows user. A miss on both is a structured error
  listing the directories probed.
- `scriptPath` reads an arbitrary path relative to the session cwd. The read
  runs in the host process with no per-read file-policy admission — the
  `workflow` tool call itself is permission-gated at the tool layer, the same
  posture that already governs `bash`/`read`-class access between
  prescriptions; a filesystem error (missing file, EACCES) is surfaced verbatim
  to the model (same error posture as the `read` tool).
- Saved scripts carry their own inline meta; when `name`/`scriptPath` supplies
  the script, the same 3.3 extraction applies. A saved script whose meta `name`
  disagrees with its file name is accepted (file name governs lookup, meta name
  governs display), with the disagreement surfaced as the launch receipt's
  `warning` field — CC documents `warning?` as the non-blocking-heads-up channel
  (its own example is remote-dispatch git drift); this slice extends it to
  saved-name disagreement, recorded in the manifest deviation — plus a
  `log`-grade note on the run-start event.
- Scripts are plain `.js`; TypeScript syntax is rejected by the engine's parse
  gate, with our error prefix preserved so the model learns the constraint once.

### 3.5 Async launch, run registry, and completion wake

The tool handler performs the synchronous prefix and returns immediately:

1. Resolve source (3.2/3.4), extract meta (3.3), call `engine.start({script:
   body, meta, args, parent: exec.agent, signal: exec.signal})` — `start` throws
   synchronously on meta/parse failure; we catch and return CC's documented
   no-start receipt `{status: "async_launched", error}` (CC documents exactly
   this contract: "check `error` before treating the run as started"). No
   `taskId` exists on this path — upstream's `WorkflowOutput` type declares
   `taskId` required, but no task was registered, so the absence is semantically
   forced and recorded as a receipt deviation rather than faked with a synthetic
   id.
2. On success, register the run under its `runId` (`run.id`) in a session-scoped
   registry along with `{scriptText, meta, args, run, startedAt}`, and return
   the documented receipt subset `{status: "async_launched", taskId, taskType:
   "local_workflow", workflowName, runId, summary, warning?}` where
   `taskId === runId` (CC distinguishes the two; harness has a single id — the
   alias is an honest mapping, recorded as a manifest note along with the
   run-id format delta: CC prefixes `wf_`, harness ids carry their own format),
   `workflowName` is `meta.name`, `summary` is `meta.description` (CC's
   "one-line description"), and `warning` is populated by the §3.4
   name-disagreement path. Omitted with recorded manifest deviations:
   `transcriptDir` (no per-run transcript-directory surface in this slice),
   receipt-`scriptPath` (CC persists every run's script to disk and echoes the
   path; this slice keeps the script in the in-memory registry's `scriptText`,
   which the same-session resume slice consumes — persistence arrives with the
   observability slice if a resume handle needs it), and `sessionUrl` (no
   remote dispatch — `remote_launched` stays a non-goal).
3. `run.result.then(settle)` is attached immediately. On settle, the registry
   composes the consolidated delivery: status line + returned JSON value
   (truncated at `maxResultChars`, default 50 000, mirroring the harness tool
   config knob) or the `stopReason`/`error` text with no partial payload
   (mirroring the harness tool's stopReason-as-error rule).
4. Delivery follows a two-vein design anchored on PR #31's *actual* mechanism.
   That incident was not "repeated injection": `agent.inject()` enqueued a
   durable pending-inbox message, and the agent loop re-opens a turn whenever
   the inbox is non-empty (`hasPending`), so *passive* notices kept waking idle
   turns into a phantom loop (`mcpReadyNotice.ts:8-11` records the rule it
   produced: batch-append, never `agent.inject()`). The asymptote here is
   different: a workflow completion is a background-task result the user asked
   for, so one idle wake per run is a requirement, not a hazard. The veins:
   - **Session busy** — the payload joins the `agent/pre-step` batch as a
     `createUserMessage` appended to the decision's messages
     (`mcpReadyNotice.ts:159` pattern): lands at the next step boundary, never
     re-opens anything, never enters the pending inbox or recall queries, by
     construction.
   - **Session idle** — exactly-once wake: one pending completion message whose
     per-runId delivered latch is set *before* enqueue, whose source kind is
     excluded from recall query construction, and whose registry entry drops at
     delivery so no second wake can be composed. The shared never-inject rule is
     the `one-shot-notice.ts` precedent; the latch + drain-on-read inbox WAKE
     itself is novel mechanism with no repo precedent today, which is why DoD 3
     gates it end-to-end. This deliberately uses the
     `hasPending` re-open once per run — the passive-notice mistake was the
     *content* (informational, ownerless), not the re-open primitive.
   - Candidate idle-vein APIs, ranked for the implementation spike: (i) the
     harness background-task completion channel — **checked 2026-09-23 and
     rejected**: the channel exists (tool-jobs' notice machinery,
     `tool-jobs/src/index.ts:269-298` — busy owner injected into the next-step
     inbox, idle owner woken, dedupe counter reset by user input), but it feeds
     off the jobs REGISTRY, which the cc preset deliberately leaves on the host
     plane (`agent.cordis.yml` background-jobs comment), so a preset-owned tool
     cannot depend on it; (ii) the one-shot pending-inbox append above —
     **selected**, with the re-open primitive already mechanism-pinned by
     `packages/subagent/task/tests/mechanism-pins.spec.ts` (T2: pending inject
     re-opens an idle turn). If (ii)'s scripted test (DoD 3) fails in
     implementation, the documented degradation (completion surfaces at the
     next user interaction, never silently dropped) is recorded as a temporary
     deviation — the slice does not ship on it.
5. Cancellation: the registry hooks context disposal to `run.cancel('session
   ended')` + `run.dispose()` for every in-flight run. A settle racing disposal
   composes nothing: once context disposal has begun, the settle handler
   swallows delivery-composition failure instead of waking a torn-down loop
   (the `mcpReadyNotice.ts` try/catch-drop precedent). `exec.signal` abort is
   bridged to `run.cancel('parent step aborted')` for the launch-window only
   (after async return, turn abort no longer owns the run — recorded as a
   known v1 gap; cancel-by-user arrives with the observability slice).
6. **Single active run per session (v1).** The tool refuses a second concurrent
   run with a structured error naming the in-flight runId. Rationale: the resume
   slice attributes journal entries to runs through signal identity, which is
   sound only under this constraint; CC-level concurrency of multiple workflows
   in one session is a recorded deviation, not an accident.

The registry is a package-internal cordis service
(`ccWorkflowRunRegistry`, unpublished to the model, injectable by the sibling
resume-journal package) so that slice consumes the same run table without
importing package internals.

### 3.6 Durable session events

We reproduce the four harness event types verbatim —
`tool-workflow/run-start` (`{runId, name}`), `tool-workflow/agent-start`
(`{runId, seq, label, phase?, childId}`), `tool-workflow/agent-end` (`{runId,
seq, outcome}`), `tool-workflow/run-end` (`{runId, stopReason}`) — with our own
`declare module '@deepseek-ai/dsh-session/types'` augmentation and recorder
(following `tool-workflow/src/index.ts:72-130`, including its
`exec.parent === undefined` top-level-only rule and the try/catch-drop-on-error
append guard). Rationale for keeping the harness names rather than minting
`dsh-cc/*` names: the harness tool row is disabled in our preset, so there is no
double emitter; and the harness web client (`ui-workflow-run`) renders these
events for free if a profile ever enables it. The harness package also ships an
invariant companion plugin (`tool-workflow/src/invariant.ts`) — but companion
invariants mount as separate rows in bundle patches, the harness base bundle
mounts no invariant rows at all, and our preset mounts none
(`packages/preset/cc/agent.cordis.yml`): the harness invariant has no claimant
today and there is nothing to replace. Our package exports an equivalent
invariant companion module for profiles that opt into invariant rows; the cc
preset keeps the base bundle's no-invariant-rows posture.

In addition, `run-start` gains one dsh-cc extension field, `source`
(`inline` | `project-saved` | `user-saved` | `scriptPath`), to make later `/learn`
class analysis possible; additive fields do not break the harness renderer.

### 3.7 Prompt section

Our package registers the `tool:workflow` section with the same order key
(`ctx.systemPrompt.getSectionOrder('TOOL_WORKFLOW')`). Content, in order:

1. What a workflow is and who holds the plan (script, not the model) — one
   paragraph, CC-aligned.
2. The script contract: meta-first literal block; `agent()/parallel()/pipeline()/
   phase()/log()/args`; per-item `null` on child failure with
   `.filter(Boolean)`; fatal `WorkflowError` classes (hook misuse, unknown opts,
   schema outside the object-rooted subset, cap breaches) kill the run; caps
   (concurrency `min(16, max(1, cores - 2))`, total 1000, items per call 4096).
3. When to use: explicit user request ("use a workflow") or the `ultracode`
   keyword; otherwise ordinary tools. Mirrors CC's opt-in posture; we do not
   implement input highlighting (see observability slice). CC couples
   `ultracode` to the session effort level ("without modifying the session
   effort level"); dsh-cc has no session-effort surface coupled to this keyword,
   so the keyword is honored as an opt-in trigger only, recorded as a manifest
   deviation.
4. Source semantics: precedence, save locations (project `.claude/workflows/`
   and the user workflows directory; the model saves with its `write` tool when
   the user asks — no dedicated tooling), and the "never re-paste; edit the file
   and pass `scriptPath`" iteration loop.
5. Async contract: the tool returns a launch receipt; **the consolidated result
   arrives by itself; do not poll or re-invoke**; `resumeFromRunId` is delivered
   by the resume slice's release.

### 3.8 Manifest true-up and parity docs

`engine.workflow-ralph` is split into `engine.workflow` and `engine.ralph` rows
(I7 ordering within `engine`; the current row double-anchors `tool-workflow` and
`tool-ralph` and conflates two capabilities). `engine.workflow` records:

- `recognized: true`, `mounted: true`, `behavioral: divergent`, `ux: partial`
  (I3: divergent bars `full`), with the deviation list: execution-mode fixed to
  CC-async here but `resumeFromRunId` pending the resume slice;
  per-user directory mapped to `$DSH_HOME/workflows/` instead of
  `~/.claude/workflows/`; monorepo chain loading of every `.claude/workflows/`
  up to the repository root (CC v2.1.178) not implemented — cwd-level only;
  CC's built-in workflows absent (`name` cannot resolve them);
  `taskId === runId` aliasing with harness-format ids (CC prefix `wf_`);
  receipt omits `transcriptDir`/`scriptPath`/`sessionUrl`, and no-start receipts
  omit `taskId` though the upstream type declares it required;
  receipt `warning?` extended to saved-script name disagreement (upstream's
  documented example class is remote-dispatch git drift);
  `ultracode`'s upstream session-effort side effect absent (opt-in trigger
  only); one-active-run constraint; no `/workflows` TUI surface in this slice.
- evidence: preset anchors `"- id: tool-workflow-cc"` and
  `"- id: workflow-worker-thread"` (I4) plus the new package source.
- `engine.ralph` keeps its current dimensions unchanged (`recognized: true`,
  `mounted: true`, `behavioral: full`, `ux: full`, `deviation: none`) and its
  existing preset anchor `"- id: tool-ralph"` — the tool-ralph row is untouched
  by this slice; the split only disentangles the conflated row.

`pnpm docs:parity` regenerates matrix/README/json in the same commit; the
pre-commit and presubmit gates (`check:capabilities`, `check:parity`) must pass.

## 4. Expected effect

- A workflow script written per CC documentation — inline meta block, saved file,
  or `.claude/workflows/` name — launches on the first try instead of failing on
  `export const meta`.
- The session stays responsive during a 10–1000-agent run; the consolidated
  result arrives as one completion delivery, once.
- The capability manifest stops overclaiming and becomes the place reviewers
  check for the remaining deltas instead of discovering them in production.

## 5. Non-goals and risks

**Non-goals (owned elsewhere or rejected):** `resumeFromRunId` replay with
per-agent result caching (resume slice); `/<name>` command mounting and progress
rendering (observability slice); `remote_launched` dispatch; cross-session
resume; zcode-class static analysis (taint/causality graphs, facade-site
diagnostics) — rejected as disproportionate to an opt-in, model-authored feature;
a `/workflows` TUI panel with save dialog and cancel keys.

**Risks.**

- *Wake-vein selection.* The idle vein deliberately uses the pending-inbox
  re-open primitive — the PR #31 hazard was the *passive, ownerless content*
  that re-opened idle turns, not the primitive; the delivered-before-enqueue
  latch and drain-on-read semantics make a re-open loop structurally absent.
  A wrong API pick shows up in the scripted idle-mid-run test (DoD 3), not in
  production.
- *Meta parser acceptance gap.* CC scripts we have not seen may use constructs
  the strict parser rejects (e.g. a computed `phases` array). Mitigation: cite
  the failing construct in the error; dogfood with at least three
  CC-documentation-shaped scripts before shipping enabled.
- *Isolate realm miswiring.* The new row must sit in the `delegation` group's
  realm; statically invisible, caught only by `smoke:profile-boot`.
- *Double registration.* Any profile that adds the harness `tool-workflow` row
  without disabling ours (or vice versa) fails at registration with
  duplicate-tool-name; the preset diff disables the harness row in the same
  commit, and the failure mode is loud, not silent shadowing.
- *Approval storms.* Children inherit session permission handling; a 500-agent
  run under `auto` mode multiplies classifier load, not prompts (classifier lane
  already dedupes); under `ask`-heavy modes the harness behavior is unchanged
  from the shipped tool. Dogfood records the observation either way.
- *Section-order key.* `TOOL_WORKFLOW` is registered in the harness's shared
  system-prompt module's order map (harness `system-prompt/src/index.ts:143`,
  path in the deepseek-harness checkout — dsh-cc has no such package), not by
  the harness tool row, so disabling that row cannot lose the key — verified
  statically above. The smoke test remains the runtime belt if a future harness
  line removes or renames the key.

## Acceptance (DoD)

1. `packages/core/tool-workflow` registered per §3.1 checklist; `pnpm typecheck`,
   package vitest, `check-spec-deps`, `check:readme`, `check:exports` green.
2. Unit tests with a fake `workflowEngine` + fake session (both offline stubs):
   source precedence matrix; meta extraction (accepted literal forms incl.
   trailing commas and comments, rejected construct classes, both-meta
   ambiguity error, absent-meta refusal text); name resolution shadowing and
   miss diagnostics; the `async_launched` success receipt asserted against the
   §3.5 documented subset — `status`/`taskId`/`taskType`/`workflowName`/
   `runId`/`summary` populated with the stated derivations (`taskType` constant
   `"local_workflow"`, `workflowName` from `meta.name`, `summary` from
   `meta.description`), `transcriptDir`/`scriptPath`/`sessionUrl` absent, and
   `warning` populated on the saved-script name-disagreement path; the
   error-populated no-start case (`status` + `error`, `taskId` absent);
   `resumeFromRunId`/unknown-key targeted refusals;
   busy-vein batch delivery never entering the pending inbox (asserted through
   the harness `agent-loop-testkit`'s real AgentLoop with its claim-based
   pending admission and inbox stub, not the hand-rolled fake session);
   single-active-run refusal; registry dispose cancels in-flight runs; the four durable events
   with the dsh-cc extension field; prompt-section registration under the order
   key.
3. Scripted session test (harness testkit): a script whose run outlives a turn
   completes while the session is idle → **exactly one** wake delivers the
   consolidated payload (asserted via turn count and inbox contents), and no
   residual pending message re-opens further turns. `smoke:profile-boot` green
   with the row swap applied; harness-tool-absent and our-tool-present asserted
   via the boot tool list.
4. `docs:parity` regenerated; manifest shows `engine.workflow`/`engine.ralph`
   split with the deviations above; `check:capabilities`/`check:parity` green.
5. Dogfood on a real session: three CC-doc-shaped scripts (inline meta, saved by
   name from the project directory, `scriptPath` after one edit) each launch
   async; session accepts new input during a run; completion arrives exactly
   once; result JSON is the script's return value. Recorded in the PR
   description.
