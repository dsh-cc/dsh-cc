# Background Agent Runtime for dsh-cc — Design

Status: reviewed — deep-reasoner cold Staff-Engineer review returned
**approve-with-changes**; all four should-fix findings (cold-resume
agentOptions disclosure, no fabricated `outputFile`, parent-exit drain
semantics, idle-parent-wake + drain + bundled-explore tests) are folded in.
Review verified every load-bearing harness claim against source; no harness
changes required (the same preset already ships spawn-continuable via
`tool-ralph` / `workflow-worker-thread`).
Date: 2026-09-03
Scope: `@dsh-cc/subagent-task` (the CC `Task` tool), the cc preset's
delegation group, and the cc-shell composition. No harness (`@deepseek-ai/dsh-*`)
changes.

## 1. Problem

dsh-cc's CC-compatible `Task` tool (`subagent_fork`,
`packages/subagent/task/src/tool.ts`) is a **foreground one-shot**: it calls
`ctx.subagents.start()` and awaits `run.result`, blocking the parent turn until
the child finishes. Claude Code, by contrast, treats subagents as a background
agent runtime:

- `Agent`/`Task` returns a discriminated output: `completed` (foreground),
  `async_launched` (background: immediate `agentId` + `outputFile`), or
  `remote_launched` (cloud session).
- A background task's completion is **pushed** to the parent as a
  `task_notification` system message (`completed | failed | stopped`, summary,
  output file, usage); the parent never polls.
- Subagents carry a **durable agent id**. `SendMessage` to that id resumes the
  agent — retaining full history — automatically in the background.
  Observation is via `TaskList`; `TaskOutput` is deprecated in favor of reading
  the task's output file directly.
- One-shot built-ins (Explore, Plan) deliberately return no agent id and cannot
  be resumed; general-purpose and custom agents are continuable.

The deepseek-harness already implements every primitive of this model:

- `ctx.subagents.startContinuable(spec)` establishes a durable continuable
  child with a stable `childId` (`subagent/src/continuation.ts:409`,
  `index.ts:212`).
- `followup(parent, childId, content)` delivers later turns FIFO, cold-resuming
  from the persisted Session when no live Activation exists
  (`continuation.ts:502-531`); `interrupt(...)` stops the current turn
  (`continuation.ts:554-594`); `listChildren`/`listDescendants` project live and
  persisted children (`list-children.ts`).
- The child-scoped `report` tool (`dsh-tool-subagent-report`, host-plane in the
  dsh base composition) delivers the child's result to the parent with
  `reportDelivery: next-step`, waking the parent at its nearest step boundary —
  the `task_notification` analogue. The runtime also notifies the parent when a
  child finishes without reporting.
- `send_message`, `interrupt_agent`, and `list_agents`
  (`dsh-tool-subagent-control`) are **already mounted** in the cc preset
  (`packages/preset/cc/agent.cordis.yml:205-209`) but are today useless from
  `Task`, because no `Task`-started child is continuable.
- The spawn provider implements the continuable-creation capability
  (`subagent-spawn-in-process/src/index.ts:55-58`). The fork provider
  implements it too, but shipped compositions deliberately bind fork to
  one-shot: a continuable child's `report` tool and prompt section precede the
  inherited history, defeating the prefix reuse a fork exists for
  (`subagent-fork-in-process/src/index.ts:77-89`, harness issue #2124).
- dsh-cc's own coordinator mode already proves the pattern end-to-end:
  `spawn_worker` calls `provider.startContinuable(...)`, `send_to_worker`
  follows up, workers answer through `report`
  (`packages/subagent/coordinator/src/index.ts:193-202`).

The gap is therefore **wiring, not runtime**: the CC surface (`Task`) never
enters the continuable path. This design closes that gap without forking any
harness behavior.

## 2. Goals and non-goals

Goals (mapped to the P0–P3 breakdown from the comparison analysis):

- **P0 — Background start.** `Task` gains `run_in_background`. A background
  call becomes a durable continuable child on the `spawn` provider and returns
  immediately with the child id. Foreground behavior is byte-identical to
  today.
- **P1 — Observation and control loop.** The durable child id returned by
  `Task` is directly addressable by the already-mounted
  `send_message` / `interrupt_agent` / `list_agents` tools; completion reaches
  the parent through the `report` channel and the runtime's finish notice. Tool
  descriptions and prompt guidance teach the loop.
- **P2 — Persistence and cold resume.** The deployment composition provably
  mounts a session-persistence backend and the host-plane
  `tool-subagent-report` row, so children survive process restarts and
  cold-resume on the next `send_message`.
- **P3 — Consistency.** Parity matrix, preset comments, and tool metadata
  reflect the new semantics; regressions are locked in by tests.

Non-goals (explicitly out of scope):

- `remote_launched` / cloud sessions; the `claude --agent X --bg` CLI flag;
  `notify_when_idle`; agent-team UI.
- A `TaskOutput` alias tool. CC itself deprecates it; the child's persisted
  session transcript is the output file.
- Background **fork** children. Fork stays foreground one-shot until harness
  issue #2124 (continuable fork prefix reuse) is resolved upstream.
- Re-enabling the harness `tool-subagent` / `tool-subagent-fork` rows. The CC
  `Task` tool keeps `.claude/agents` dispatch, persona injection, toolFilter
  sanitization, and model-alias routing; we extend it instead of swapping it.

## 3. Design

### 3.1 P0 — `run_in_background` on the Task tool

**Tool surface** (`packages/subagent/task/src/tool.ts`):

- New optional boolean parameter `run_in_background` (default `false`), named
  after the CC/harness convention already used by `bash`.
- Foreground calls (`run_in_background` omitted/false) execute exactly the
  current code path: `seam.start(...)`, await, settle, return final text.

**Background dispatch rules:**

| `subagent_type`                          | Background behavior                                   |
|------------------------------------------|-------------------------------------------------------|
| omitted / `general-purpose`              | continuable child on provider `spawn`                 |
| named `.claude/agents` definition        | continuable child on `spawn` with the definition's persona, sanitized toolFilter, and alias-resolved agentOptions — identical field mapping to the foreground path |
| `fork`                                   | loud tool error: fork children are one-shot until upstream issue #2124 lands |

**Implementation sketch.** Extend the duck-typed `SubagentsLike` seam with
`startContinuable(spec)` and a capability probe
(`getProvider(name)` → presence of `prepareContinuable`; the service itself
rejects continuable starts on incapable providers with `UNSUPPORTED_CAPABILITY`).
On a background call:

1. Resolve the definition exactly as today (registry, persona, toolFilter
   sanitization against the live `restrictableNames`, `ccModelRoutes` →
   `agentOptions`, `maxDepth: 3`). Continuable semantics require this folding
   at creation time: cold resume deliberately never re-captures the parent's
   policy (`continuation.ts:254-256`), and the persisted descriptor carries
   `label`, `agentProvider`/`agentModel`, `persona`, `toolFilter`
   (`descriptor.ts:49-83`). The existing foreground mapping is already the
   right creation input — no new resolution logic. One known narrowing: the
   descriptor persists only the model route's `provider`/`model` strings, so
   **every other `agentOptions` field — including the alias-stamped
   `reasoningEffort` and `maxTokens` — is dropped on cold resume**; the
   resumed child gets the route's defaults (harness-owned semantics,
   `descriptor.ts:16-19`, `continuation.ts:976-980`). Acceptable; disclosed
   in the parity row.
2. Call `startContinuable({ provider: 'spawn', label: description, request:
   { prompt, parent, agentOptions?, toolFilter?, maxDepth, persona? }, signal })`.
3. Return as soon as the child has accepted its initial prompt
   (`startContinuable` resolves after inbox acceptance — Activation
   materialization and first-turn persistence happen before it resolves, so
   this is "promptly", not "instantly") with the `ContinuableStart`
   identities.

**Output shape.** The tool output gains optional fields beside `text`:
`status` (`'completed' | 'async_launched'`) and `agentId`.
`render` produces the model-facing text:

- Foreground: unchanged (child's final text).
- Background: a short notice naming the durable `agentId`, stating that the
  child runs in the background, that its report or finish notice will arrive as
  a waking message, and that `list_agents` / `send_message` / `interrupt_agent`
  address it by that id. This mirrors CC's `async_launched` semantics at the
  behavior level while keeping our single-text render contract.

**No `outputFile` field.** CC's `async_launched` carries one, but it is a
stub over a deprecated `TaskOutput`; CC's own guidance is "read the output
file". The jsonl persistence backend's on-disk layout (nested project/session
directories, optional zstd compression —
`session-persistence-jsonl/src/index.ts:120-163, 850-890`) is not safely
derivable from outside the service, and the published persistence interface
exposes no path-derivation API. Rather than fabricate or ship an
always-omitted field, the tool returns none: collection flows through the
`report` wake, `list_agents`, and `send_message`; humans can open the session
transcript via existing session tooling. If the harness later publishes a
transcript-locator on the persistence service, adding the field is
additive-only.

**Error mapping.** `UNSUPPORTED_CAPABILITY`, admission refusals (draining),
and missing session persistence surface as tool errors whose text names the
cause and the remedy (e.g. "background subagents require session persistence").
Fork + background is rejected *before* any seam call, with a message that names
issue #2124.

### 3.2 P1 — observation and control loop

No new tools. The work is contract alignment and guidance:

1. **Identity contract.** The `agentId` returned by `Task` is the durable
   `childId`, which is exactly what `send_message`, `interrupt_agent`, and
   `list_agents` (already mounted, preset rows `tool-subagent-control` and
   `tool-subagent-control/list-agents`) accept. Verified by integration test,
   not by new code.
2. **Completion delivery.** Continuable children receive the child-scoped
   `report` tool from the host-plane `tool-subagent-report` row (activation
   setup registry installs it into every continuable in-process child). The
   default `reportDelivery: next-step` wakes the parent — the
   `task_notification` analogue. Children that finish without reporting still
   generate the runtime's finish notice. The design relies on these harness
   behaviors; P1 adds a composition-level assertion (see 3.3) and guidance
   text, not machinery.
3. **Guidance.** The `Task` tool description gains a background paragraph:
   when to use it (long-running or parallel work), what the call returns, and
   the exact loop ("you are told when it finishes; use `list_agents` to check
   status, `send_message` to continue the same conversation, `interrupt_agent`
   to stop its current turn"). A short system-prompt section in
   `@dsh-cc/subagent-task` states the same contract once, so it survives
   tool-description trimming.
4. **Lineage rule surfaced.** Cold resume admits only the child's exact live
   direct parent (`continuation.ts:962-963`, enforced by `authorizeLineage`
   at `continuation.ts:1273-1287`). Guidance therefore says: the
   agent that started a background child owns its continuation; sibling or
   grandchild continuation is rejected by the runtime.
5. **Parent-exit semantics stated.** Tearing down the parent session drains
   its continuable descendants' Activations
   (`drainContinuableDescendants`, `subagent/src/index.ts:296-308`): an
   in-flight child turn stops. Nothing is lost — the child's persisted
   Session survives, and a later `send_message` from the (resumed) parent
   cold-resumes it. Guidance and the parity matrix state this plainly so
   nobody mistakes a drained turn for a lost child.

### 3.3 P2 — persistence and composition guarantees

- The deployment composition inherits `session-persistence-jsonl`
  (`dsh base cordis.patch.yml` rows) and host-plane `tool-subagent-report`.
  dsh-cc's cc-shell patch does not disable either; P2 **locks this in with a
  composition test** in `packages/bundle/cc-shell/tests` asserting that a
  composed cc app (a) resolves a session-persistence backend service and
  (b) mounts the report setup exactly once. If a future upstream upgrade drops
  either row, the test fails at the drift gate instead of background children
  silently losing durability.
- Cold-resume behavior itself (descriptor folding from the child's own suffix,
  lineage authorization, Activation materialization through
  `ctx.agents.resume`) is harness-owned and harness-tested; dsh-cc adds no
  wrapper. P2 is therefore verification + pinning, plus the P0 error mapping
  that tells the model when persistence is absent.

### 3.4 P3 — consistency and documentation

- `docs/cc-parity-matrix.md`: the Subagents row drops the "foreground one-shot
  only" known limit and documents the background/continuable loop, including
  the deliberate deviations:
  - fork + background rejected (upstream #2124);
  - no `TaskOutput` alias and no `outputFile` field (collection flows through
    the report wake / `list_agents` / `send_message`; transcripts are inspectable
    via existing session tooling);
  - cold resume restores `persona`/`toolFilter`/model route from the persisted
    descriptor, but **drops every other `agentOptions` field** (alias-stamped
    `reasoningEffort`, `maxTokens`) in favor of the resumed route's defaults;
  - exiting the parent session drains children's in-flight turns (their
    persisted Sessions survive and cold-resume on the next `send_message`);
  - bundled cheap agents (`explore`, `dsh-cc-guide`) *may* run in the
    background — CC's "built-ins return no agent id" restriction is not
    mirrored, since background-vs-foreground here is the caller's choice and
    the continuable machinery is uniform. (Foreground remains the default and
    the cheap-lane recommendation.)
- Preset comment at `agent.cordis.yml:194-198` updated: the "follow-up" is
  this change; the harness rows stay disabled. Note for future readers: the
  *disabled* `tool-subagent-fork` row still carries `backgroundMode:
  continuable` in its config — that config is inert while the row is disabled
  and does not contradict the fork-stays-one-shot rule above.
- Tool-name mapping (`cc-names.ts`) unchanged: `Task` still translates to
  `['subagent', 'subagent_fork']`; `send_message` / `interrupt_agent` /
  `list_agents` are already authoritative harness names.
- Hooks: `subagent/start` / `subagent/end` fire per Activation **epoch** — a
  cold resume of one durable child produces a fresh start/end pair with a new
  `runId` (`lifecycle.ts:174-216`). The `SubagentStart` regression test pins
  the initial-epoch assertion only, and callers of the hook must not treat
  repeated starts as new children.

### 3.5 Files touched (planned)

| File | Change |
|---|---|
| `packages/subagent/task/src/tool.ts` | `run_in_background` param, background dispatch via `startContinuable`, output fields + render, fork rejection, error mapping |
| `packages/subagent/task/src/index.ts` | plugin config surface if any; prompt section registration |
| `packages/subagent/task/tests/tool.spec.ts` | TDD: new cases below |
| `packages/bundle/cc-shell/tests/` (new or existing composition spec) | persistence + report mounting assertions |
| `packages/preset/cc/agent.cordis.yml` | comment update only |
| `docs/cc-parity-matrix.md` | Subagents row rewrite |
| `packages/hooks/hooks-claude-code/tests/` | SubagentStart on background path (if not already covered) |

## 4. Test plan (TDD)

Red-first, in this order. All unit tests extend
`packages/subagent/task/tests/tool.spec.ts` (mock seam gains
`startContinuable` + capability-aware `getProvider`):

P0:
1. Background spawn (no type): calls `startContinuable` with provider `spawn`,
   label, prompt, parent, `maxDepth: 3`; returns `status: 'async_launched'`
   with the durable id; does **not** await a result.
2. Background with named definition: persona, sanitized toolFilter, and
   alias-resolved agentOptions are folded into the continuable request exactly
   as the foreground path folds them.
3. Background + `fork` → error naming issue #2124; seam untouched.
4. Background + unknown `subagent_type` → the existing available-list error.
5. Provider without `prepareContinuable` → tool error naming
   `UNSUPPORTED_CAPABILITY`.
6. Foreground regression: the 26 existing cases pass unmodified.
7. Output render: background text contains the durable id and the
   list/send/interrupt loop instructions; no `outputFile` field exists.
8. Background + bundled `explore` definition: continuable start with the
   bundled persona and read-only allow-list (the deliberate §3.4 deviation).

P1:
9. Integration (coordinator-style, in-process harness): start a background
   child via the tool, then `send_message` by returned id delivers a follow-up
   turn; `list_agents` shows the child; `interrupt_agent` stops a running turn.
10. Report delivery, **idle parent**: the parent's turn has already ended when
    the child finishes; the child's `report` (or the runtime's settlement
    notice, `continuation.ts:1497-1503`) wakes the idle parent with a real
    turn. This is the defining background scenario, so it is pinned here even
    though the mechanism is harness-owned.

P2:
11. Composition: cc-shell composed app exposes the persistence backend and
    mounts the report setup once.
12. Cold resume (harness-level, in-process): dispose the Activation, then
    `send_message` re-materializes from the persisted Session and the child's
    descriptor composition (persona/toolFilter) is intact.
13. Parent teardown: `drainContinuableDescendants` stops the child's
    Activation; the persisted Session survives and a later `send_message`
    cold-resumes it.

P3:
14. `SubagentStart` hook fires for a background start (initial epoch only; see
    §3.4 epoch semantics).
15. Docs/parity strings asserted where the repo already gates them (composition
    drift gate keeps passing).

## 5. Risks and mitigations

- **Fork ambiguity.** A model may reasonably ask for a background fork. The
  rejection message must teach the workaround (background spawn) — covered by
  test 3's message assertion.
- **Persistence absence in exotic deployments.** Without a persistence backend
  `startContinuable` fails loudly; the P0 error mapping turns that into an
  actionable tool error instead of an opaque crash.
- **Prompt-driven misuse** (model backgrounds everything). Mitigated by
  guidance: foreground remains the default; background is for long/parallel
  work. No hard gate.
- **Descriptor version drift.** The harness owns `SUBAGENT_DESCRIPTOR_VERSION`;
  dsh-cc stores only fields the harness descriptor already supports
  (persona/toolFilter/agentProvider/agentModel/label), so no dsh-cc migration
  surface is created.
- **Scope creep into harness.** Every capability used here already exists in
  `@deepseek-ai/dsh-subagent*`; if a gap appears during implementation, stop
  and re-plan rather than patching harness internals.

## 6. Acceptance (DoD)

- [ ] All tests in section 4 green (`pnpm vitest run` for touched packages;
      repo gates pass).
- [ ] A live cc session can: start a background `Task`, keep working, receive
      the child's report as a waking message, `send_message` a follow-up,
      `interrupt_agent`, and see the child in `list_agents`.
- [ ] After a process restart, `send_message` to the durable id cold-resumes
      the child with its original persona/tool scoping.
- [ ] Parity matrix and preset comments match the shipped behavior.
