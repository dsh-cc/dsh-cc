# Memory-Recall Hardening Follow-Ups (Harness-Frozen)

Date: 2026-09-09. Status: approved — design reviewed cold by the critic agent;
every finding is adopted inline below (W2 parentage resolution, runId pairing,
injection scope limits, W3 enumeration mechanism + negative control, W1 prompt
invariants, W4 scope trim). Follow-up to the rogue memory-recall fork incident
root-caused in PR #26 (merged, c8cc9be).

## 1. Background and constraints

The memory-recall selector (`packages/memory/memory/src/recall.ts`) spawns a
one-shot fork child per user prompt. Before PR #26 that child inherited the
full parent transcript, received the raw user task as prompt text, had the full
tool surface, and ran on the inherited main model — one such child executed the
user's task in parallel, including `git commit` and `git push`. PR #26 shipped
`toolFilter: { allow: ['read'] }`, `maxDepth: 1`, `<user_query>` delimiting, and
a never-execute instruction. This plan lands the four deferred follow-ups.

**Hard constraint: `deepseek-harness` is frozen.** No upstream edits, no
upstream PRs. Everything below is dsh-cc-side. The harness behaviors we do not
change (the `list_agents` one-shot filter, the `restrict()` own-layer
exemption) are treated as invariants and worked around, not fixed.

Verified facts this plan relies on:

- `outputSchema` is a shipping harness capability. `memory-consolidation`
  (`packages/memory/memory-consolidation/src/index.ts`) calls
  `subagents.start({ outputSchema })` in production; the fork driver injects a
  `structured_output` tool into the child's own scope; the result arrives as
  `result.structured` alongside `stopReason`; a schema requested but never
  reported settles as a *resolved* `stopReason: 'error'`, never a rejection.
- Production one-shot fork call sites in dsh-cc: `recall.ts`,
  `memory-consolidation/src/index.ts`, `hooks-claude-code/src/dispatch.ts`
  (CC hook bridge), `skill-claude-code` (`context: fork` skills).
- `subagent/start` / `subagent/end` events fire for one-shot runs and are
  global; dsh-cc already taps them
  (`packages/subagent/task/src/epoch-collector.ts`,
  `packages/ui/tui/src/harness/driver-catalog.ts`, `store/views.ts`).
  **The event payloads do not carry parentage** (driver-catalog documents
  "Events are NOT session-filtered"). Parentage is resolvable via
  `ctx.agents.get(childId).session.header.parentSession` — the TUI already
  probes sessions this way.
- Real in-process subagent integration tests exist in-repo:
  `packages/compat/cc-model-aliases/tests/integration.spec.ts` drives real
  `subagents.start('fork' | 'spawn')` through a mock-model adapter. The
  adapter captures the child's request, whose `tools` array *is* the
  effective post-`restrict` tool surface — there is no public
  tool-enumeration API.
- `restrict({ allow })` masks the inherited/global tool surface; a scope's
  own-layer registrations bypass by design (this keeps `structured_output`
  alive under a `toolFilter`). Plugin tools registered at plugin load land in
  the global layer and *are* masked; only agent-scoped registrations bypass.
- Memory recall injects its result block into the parent agent's context from
  an `agent/pre-step` hook via `agent.inject()` with `createUserMessage` and
  a `MessageSourceMap` kind declaration (`recall.ts`). Contributors to a
  parent cross-session message must replicate that shape.

## 2. Workstreams

One PR, four commits (W1..W4), TDD per workstream. `extractSelectedNames`
dies; the harness stays untouched.

### W1 — Recall selector reports via `outputSchema` (packages/memory/memory)

Changes:

- `recall.ts`:
  - `RECALL_FILES_SCHEMA = { type: 'object', additionalProperties: false,
    properties: { files: { type: 'array', items: { type: 'string' },
    maxItems: MAX_RECALL_MEMORIES } }, required: ['files'] }`.
  - The system/prompt text keeps **every** selection-policy sentence verbatim
    (certainty preference, recent-tools suppression, max-N cap, the
    `<user_query>` delimiting, and the never-execute instruction). Only the
    output-format sentence changes: report by calling `structured_output`
    with `{ files: [...] }` instead of replying with JSON text.
  - `SubagentLike` request type gains `outputSchema?: Record<string, unknown>`.
- Consumption: accept a selection only when `stopReason === 'completed'` and
  `structured.files` is a string array; validate ⊆ candidate set, dedup, cap
  host-side at `MAX_RECALL_MEMORIES` (`maxItems` in the schema is advisory —
  enforcement is host-side). Any deviation → fail-open empty recall, plus a
  warn-once-per-process log line (module-level boolean; no counter, there is
  no metrics channel).
- **Delete** `extractSelectedNames` and its tests, including its export from
  `packages/memory/memory/src/index.ts`. The structured path is the only
  path; an absent payload means no recall, same as malformed JSON today.

Tests (TDD): start-request carries the exact schema and `maxItems` matches
`MAX_RECALL_MEMORIES`; happy-path structured payload; subset/order
preservation; non-array / wrong-type / over-cap / non-candidate entries →
filtered or empty as specified; `stopReason !== 'completed'` → empty +
warn-once fires exactly once across repeated failures; **prompt-invariant
test asserting the `<user_query>` delimiters and the never-execute sentence
survive the rewrite** (that instruction is the PR-#26 regression surface).

DoD: memory package suite green; memory-consolidation untouched and green.

### W2 — One-shot subagent visibility (packages/subagent/task + scripts/)

The model-facing `list_agents` cannot be fixed (harness). We add dsh-cc-side
awareness with two independent surfaces.

**(a) Live ledger + parent-scoped pre-step injection.**

- `packages/subagent/task/src/one-shot-ledger.ts`: process-level ledger fed
  by one shared `subagent/start` / `subagent/end` listener pair (mirror the
  `epoch-collector` wiring). Row: `{ runId, id, provider, label?, parentId?,
  startedAt, endedAt?, stopReason? }`.
  - **Pairing by `runId`, never by child id**: a cold-resumed child gets a
    new `runId` and must not satisfy a stale watcher (epoch-collector's
    documented lesson).
  - **Parentage**: on `start`, resolve
    `ctx.agents.get(id)?.session.header.parentSession`; store it as
    `parentId`. Children whose parentage cannot be resolved are kept but
    treated as unscoped (never injected into any specific session's context).
  - **Pruning**: ended rows age out after a fixed TTL; *active* rows also age
    out (a crashed child may never emit `end` — without this the active count
    grows monotonically); an `end` arriving after its row was pruned is a
    no-op.
  - **Internal classification**: prefer deriving "infra fork" from the
    child's session descriptor/provider metadata when enumerable; fall back
    to a colocated `INTERNAL_LABELS` literal list (`memory-recall`,
    `memory-consolidation`, the hooks-dispatch labels, skill fork labels —
    enumerate the real values during implementation) plus a unit test that
    fails when a known production label is missing from the list.
- Injection: on `agent/pre-step`, for the agent whose `session.id` matches a
  ledger row's `parentId`, contribute one observe-only line via
  `agent.inject()` + `createUserMessage` + a dedicated `MessageSourceMap`
  kind — mirroring `recall.ts`'s contribution shape. Emitted only when that
  session has ≥1 active non-internal one-shot child: a single folded line
  counting/labelling active children. Zero emission otherwise (no per-step
  token cost). `packages/subagent/task` currently has `@deepseek-ai/dsh-llm`
  as a dev-dependency only; promote it to a runtime dependency (or duck-type
  the message construction if the shape is trivially stable — implementer's
  call, document the choice).
- **Stated limit (do not "fix")**: inline one-shot forks that start and
  finish within a single step (the recall selector itself, prompt-hook forks)
  are never ACTIVE at a pre-step boundary and therefore never appear in this
  injection. They are covered by the internal folding plus the forensic
  script below. The injection exists for long-running ephemeral children
  (background Task spawns, consolidation jobs, anything future and rogue).

**(b) Post-hoc forensic script** `scripts/audit-subagent-children.mjs`

- Walks `~/.dsh/sessions/**/session.jsonl.zstd` (spawn the `zstd` CLI; clear
  error if absent), rebuilds parent→child trees from log headers
  (`parentSession`, `origin: 'subagent'`, `seedLength`), prints a per-child
  timeline (branch/write/commit/push tool calls with wall-clock times).
- Flags: `--session <id>` (restrict to one session and its descendants),
  `--grep <substr>` (only children whose log mentions the substring — the
  technique that located the rogue commit `5b50d7b`).
- Must tolerate a live session file being appended mid-read: skip a trailing
  truncated line rather than failing.

Tests: ledger unit tests (start/end fold by runId; cold-resume re-pairing;
prune TTL for ended and active rows; end-after-prune no-op; internal
classification incl. the label-list completeness test); injection tests
(no active children → nothing emitted; active non-internal child → exactly
one line **only to the matching parent session** — a second session's agent
must see nothing; internal-only activity → folded count, no per-child rows);
script tests on synthetic `.jsonl` fixtures (tree rebuild, `--grep`,
truncated-tail tolerance).

DoD: task package suite green; no capability-manifest or parity change is
expected (no preset/command/settings surface moves) — if `check:capabilities`
disagrees, comply with its direction in the same commit.

### W3 — Recall child tool-surface tripwire + registration audit

- Integration test in `packages/memory/memory/tests/` using the
  `cc-model-aliases` in-process template (mock-model adapter): start a fork
  with the recall request shape (`toolFilter: RECALL_TOOL_FILTER`,
  `outputSchema: RECALL_FILES_SCHEMA`, `maxDepth: 1`). Assert the *security
  invariant* on the child's captured request `tools`: every entry ∈ `{read,
  structured_output}`, and both `read` and `structured_output` are present.
  (Invariant-style, not deep-equal: the tripwire must fire on *widening* and
  name the offending tool, without breaking on unrelated own-layer additions
  in a future harness bump.)
- **Negative control** in the same spec: a fork started *without* a
  `toolFilter` must observe a strictly larger tool surface — otherwise the
  invariant assertion can be vacuously green.
- One-time audit (result committed into §3 below, not a CI gate): inventory
  every `tools.register` call site; classify plugin-load-time (global layer →
  masked, safe) vs agent-scoped (own layer → bypasses `restrict`); any
  agent-scoped registration must visibly guard on non-subagent origin.
  Include `recallAgentOptions`/route plumbing only insofar as it proves the
  `haiku` alias unresolvable path degrades to warn-once + inherited model and
  never produces `{ model: undefined }`.

DoD: new spec green; audit table appended to §3; `check-spec-deps` clean
(the spec imports harness packages — declare them in the memory package's
devDependencies per the repo's spec-deps gate).

### W4 — Recall-selection quality eval harness (packages/memory/memory/eval/)

Purpose: gate a future `recallUseSmallFast` default flip. **The flip itself
is out of this PR** — it requires a real-model run.

- `eval/fixture-memory/`: ~25–30 synthetic topic files + `MEMORY.md` index
  with one-line descriptions; ≥3 near-miss distractor clusters (3–5
  lookalike topics each where only a subset is relevant).
- `eval/golden.json`: ~40 queries, 10 per class (direct / compositional /
  no-relevant-memory → empty / ambiguous), each `{ query, required[],
  tolerated[] }`.
- Runner: env-gated (`DSH_RECALL_EVAL=1`) vitest spec reusing the W3
  in-process wiring; two arms (inherited model vs `haiku` alias, skipping
  cleanly when the alias is unresolvable); writes
  `eval/report-<timestamp>.json` with per-arm required-set
  precision/recall/F1 and paired per-query agreement against the strong arm.
  JSON only; no latency metric (queue-confounded); no token accounting unless
  the run object exposes it for free.
- `eval/README.md` pre-registers the acceptance gate: the flip PR is only
  legitimate if haiku-arm F1 ≥ strong-arm F1 − 0.03, no query class shows a
  zero-hit collapse, and the report is attached to the flip PR.

Tests: fixture validator (file count, index coverage, distractor clusters
present); golden schema validator; metric-math unit tests; the model-facing
spec auto-skips without the env var.

DoD: all non-gated tests green; a documented one-liner runs the eval when
aliases are configured.

## 3. Registration audit (W3 result, 2026-09-09)

Inventory: every production `tools.register` call site under `packages/`
(tests excluded). Layer classification follows the harness semantics: plugin
load/activation contexts write to the global layer (masked by `restrict` →
safe); `agent.ctx` writes to the agent's own layer (bypasses `restrict` →
needs a guard).

| package:site | layer | bypass-capable? | origin guard | action |
|---|---|---|---|---|
| workspace/tool-git-worktree `src/index.ts:216,289` | global | no | n/a | none |
| core/tool-notebook-edit `src/index.ts:129` | global | no | n/a | none |
| core/tool-web-fetch `src/index.ts:225` | global | no | n/a | none |
| core/tool-structured-output `src/index.ts:106` | global | no | n/a | none (the dsh-cc side; the per-child own-layer `structured_output` is injected harness-side and is the intended exemption) |
| mcp/mcp-client `src/defer.ts:57,60`, `src/resources.ts:71` | global | no | n/a | none |
| core/tool-search `src/index.ts:216` | global | no | n/a | none |
| core/tool-sleep `src/index.ts:94` | global | no | n/a | none |
| subagent/coordinator `src/index.ts:154,202,250,290` | agent own-layer | **yes** (4 coordinator tools) | composition guard: `apply()` requires an agent-scoped context and throws when active without one; the preset mounts it for the coordinator main agent only — no blanket per-agent hook exists | accept & document; no code change |

Result: 9 production sites across 8 packages; exactly one bypass-capable
class (coordinator mode), invocation-guarded by preset composition. No
unguarded blank-hook registrations exist in dsh-cc's own plugins today;
the W3 tripwire spec fails CI if that ever changes for the recall child.

**Fallback-path verdict (clean):** `resolveRecallAgentOptions` →
`toAgentOptions(routes?.resolve('haiku'))`; `toAgentOptions` returns
`undefined` for an unresolved alias *and* collapses empty route objects
(`agentOptions.ts:20-28`), so `{ model: undefined }` is unrepresentable.
`recall.spec.ts` already pins the inherit-on-unresolvable behavior
("omits agentOptions when recallUseSmallFast is true but no ccModelRoutes
is mounted"). Accepted residual: an unresolvable `haiku` alias inherits the
main model silently (no warn-once) — logged here as known, tolerated
behavior; no code change.

## 4. Sequencing and PR plan

- W1 → W3 (W3 imports W1's constants; same package).
- W2 and W4 are independent of W1/W3 and of each other.
- Wave 1 (parallel): W1, W2, W4. Wave 2: W3.
- Commits: one per workstream on `worktree-recall-followups`, then a single
  PR. Commit messages state observable behavior changes (prompt changes are
  behavior changes).
- Explicit non-goals: flipping `recallUseSmallFast` (needs a W4 report);
  touching `deepseek-harness`; fixing `list_agents` or `restrict()`
  upstream (worked around in W2/W3 instead).
