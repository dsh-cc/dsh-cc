# Subagent-aware shunt gate: CC-parity caller identity and the subagent exemption

**Status:** **Design — three review rounds applied (critic; Codex SHIP-WITH-FIXES; code-verified reviewer round 2; reviewer round 3, 2026-09-25).** Identity transport is a CC-parity field fill keyed on the bridge's live `subagentIds` set; `agent_type` stays a constant parity gap in this PR.

**Date:** 2026-09-25

## 1. Problem

`dsh-cc-shunt` installs two PreToolUse command hooks
(`packages/plugin/dsh-cc-shunt/hooks/check-file-size.mjs`, `check-bash-read.mjs`) blocking
whole-file reads over 350 lines / 100 KB. The hooks are session-scoped
(`packages/hooks/hooks-claude-code/src/register-events.ts:98-104`), so they fire inside
worker subagent sessions too. The defects (precise scope after review):

1. **The dead-end sentence.** The block reason leads with "delegate via the bulk-reader
   skill" — unexecutable for critic/executor/marathon (no Task, and executor has no skill
   surface; critic.md:33-46, executor.md:89-93). The trailing offset/limit escape clause
   already existed; the *prescription* was the defect.
2. **Images are a true deadlock, main thread included.** The bridge maps harness
   `read_image` to the CC name `Read` (packages/core/tools/tests/cc-names.spec.ts:45-46),
   so the hook cannot tell a 150 KB PNG from a text file — and `read_image` has no
   `offset`/`limit`. Extensionless image paths are explicitly supported by `read_image`
   (format detected from content — harness read-image.ts tool description), so an
   extension-only skip would still deadlock them.
3. **For any subagent the block is pure churn.** Harness `read` is itself capped
   (READ_LIMIT=2000 plus maxLineLength/maxBytes — harness
   packages/fs/tool-fs/src/read.ts), and a whole-file read vs an `offset: 1` read of the
   same over-limit file return identical bounded output; the Bash gate is porous by
   design-pinned upstream quirks (`head -n 5 big` *passes* — `5` is treated as the path,
   hooks.spec.ts:266-271; `tail -n +1` passes). A blocked worker re-issues and gets the
   same content one round trip later.

## 2. Verified seams and facts

- **Harness repo is read-only** (2026-09-10 directive). Fix surface: bridge, shunt
  plugin, their docs/tests — all dsh-cc-side.
- **CC specifies caller identity on hook input.** The agent-sdk hooks reference
  documents `agent_id` and `agent_type` as populated when a hook fires inside a
  subagent (TS: base input, all events; Python: optional on PreToolUse/PostToolUse/
  PostToolUseFailure/PermissionRequest; required on SubagentStart/Stop). dsh-cc emits
  neither (probe: exactly seven PreToolUse fields today) — filling `agent_id` is a
  parity *fix*, not a contract addition, and http hooks get it like any payload field.
- **The identity seam is the bridge's own `subagentIds` set**
  (register-events.ts:52-54, populated at subagent/start :217 and /end :230). It is
  process-local and populated only by live start/end events; probed ordering: a child's
  start event always precedes its first PreToolUse, grandchildren included. This is the
  only member test that stays correct across process restarts (see resume rows, §5).
  Reviewer-verified sub-facts this design leans on: `exec.agent` at `tools/pre-execute`
  IS the calling subagent, and `exec.agent.id` equals the id `subagent/start` reports;
  a shunt `{"decision":"allow"}` is decoded to a no-op and never auto-approves;
  no existing test pins the hook payload field set, and adding fields breaks no hook.
- **What does NOT work for identity (all probed):**
  - `session.header.delegationDepth` persists (harness depth.ts:28-35): a child session
    later `/resume`d as a top-level session still reads depth 1. Dead as a signal.
  - The live registry does not save you either: the resumed child *remains* registered in
    `ctx.agents` with parent=root, source=subagent, and its descriptor intact (probed).
    Registry presence cannot distinguish "running as a child now" from "resumed as
    top-level".
  - `subagent/descriptor`'s `label` is the model-written 3–5-word Task *display*
    description (`label: args.description`, packages/subagent/task/src/tool.ts:247) —
    not a type — and it lands inside the child's FIRST pre-step, *after*
    `subagent/start` fires (one-shot-ledger.ts:182-186), so type derived from it would
    differ between SubagentStart and PreToolUse for the same child.
  - `info.provider` reports spawn-vs-fork mechanics, not the agent type.
- **dsh-cc session_id semantics differ from CC** (pre-existing, documented here rather
  than changed): the bridge's `base()` emits the *calling agent's own* session id
  (payloads.ts:35) — for a subagent event that is the child session id, whereas CC
  keeps the main session id on every payload. Consequence recorded for hook authors:
  in dsh-cc, a subagent's `agent_id` equals its `session_id` (both the child session
  id); in CC they differ.
- **Capability vs depth:** frontmatter-omitting children inherit the full parent tool
  view, `Task` included (packages/subagent/task/README.md:134-136); max delegation depth
  is 3 (tool.ts:83). Depth→"cannot delegate" misclassifies both ways — moot under the
  exemption design, recorded because the rejected options leaned on it.
- **Config-is-prompt** unchanged: block reasons are prompt surface; §6.4 dogfood stands.

## 3. Options considered

| Option | Shape | Verdict |
| --- | --- | --- |
| **A (round 3)** | Bridge emits `agent_id` (+ `agent_type: 'general-purpose'`, recorded gap) on hook events whose caller id is in the bridge `subagentIds` set; shunt hooks allow any invocation carrying `agent_id` and skip image formats by magic bytes; main thread byte-identical. | **Adopt.** |
| A′ (round 1/2) | `DSH_DELEGATION_DEPTH` env var / message-only branching. | Superseded: reinvents a CC-specified field; `DSH_*` is a harness-managed namespace (ambient scrub in subprocess, `ctx.shellEnv` registry owns the prefix) with silent-failure semantics. |
| A″ (round 2) | CC-parity fields, but `agent_type` resolved from the `subagent/descriptor` label; identity from live-registry/header. | Superseded: label is a display string (tool.ts:247), lands after SubagentStart; registry/header both misclassify resumed sessions (§2). |
| B | Docs-only pagination clause in worker contracts. | Moot — no worker-facing block remains. (Had it shipped, it would also have had to dodge the `actor-contract` marker strip and the contracts' "report as blocker" sentence.) |
| C | Grant workers a scoped `shunt-reader` spawn. | Rejected: contract-purity violation, no type-scoped whitelist mechanism, executor is already cheap-lane. |
| D | Exempt subagent sessions. | **Adopted scoped into A** — measured: harness read caps make the block pure churn in worker sessions (§1.3); the gate's value (orchestrator context + delegation nudge) lives on the main thread. |
| E | Capability-based gating (has subagent_fork ∧ depth<3). | Rejected: no reliable capability lookup at hook-process granularity; misreads both ways. |
| F | Real `agent_type` in this PR via a Task-side id→type registry table the bridge reads (plugin agents → scoped name; file-defined agents → frontmatter name; untyped → `general-purpose`; internal forks → `''`). | Deferred follow-up, design sketched in §10; this PR keeps the constant and records the gap. |

## 4. Design

### 4.1 Bridge: emit `agent_id` (and constant `agent_type`) for live subagent callers

At every hook site that has a calling agent (PreToolUse / PostToolUse /
PostToolUseFailure / PermissionRequest / Stop family), the registration layer passes
`isSubagent = subagentIds.has(exec.agent.id)` down to the payload builder; when true the
payload gains:

- `agent_id: exec.agent.id` — probed equal to the id SubagentStart reports, grandchildren
  included; the equality is pinned by tests (no "if they differ" hedge).
- `agent_type: 'general-purpose'` — the uniform constant, **unchanged from today** for
  SubagentStart/Stop and extended to the tool-event family. Kind-specific matchers
  remain non-firing; this is recorded as a known parity gap in the manifest rows rather
  than silently fixed with a wrong source (§2, F of §3, §10).

Events without a calling agent (PermissionDenied, Notification, PostCompact, SessionEnd,
TaskCreated) stay as-is in this PR — recorded as out of scope for the identity fill.

**Set-membership is the whole identity test.** A `/resume`d child running as a top-level
session never produced a live start event *in this process*, so it is not in the set:
no fields, gate active — the correct behavior, now for a verified reason. One open edge
remains (§7): a *cold-resumed-as-child* continuable child may not re-emit
`subagent/start`; if it does not, it loses the exemption until it next spawns fresh.
The e2e characterizes this rather than guessing.

### 4.2 Shunt hooks: subagent exemption + image sniff

Both `.mjs` scripts, ahead of the thresholds (kill switch and offset/limit/pipe
early-allows keep order and semantics):

```js
if (typeof payload.agent_id === 'string' && payload.agent_id !== '') allow()
```

- **Read hook image sniff**: extension fast-path (png/jpg/jpeg/webp/gif,
  case-insensitive) **plus** a first-12-byte magic check — PNG `\x89PNG\r\n\x1a\n`, JPEG
  `FF D8 FF`, GIF `GIF8`, WEBP `RIFF????WEBP` — so extensionless images are also allowed.
  The hook cannot distinguish `read` from `read_image` by tool name or input shape; magic
  bytes are the only discriminator that covers both call styles.
- **Bash hook is unchanged except the exemption**: no image sniff there — `cat`ing a
  binary yields capped binary output and the byte gate stays appropriate; the exemption
  is the subagent fix, not a Bash-behavior change.
- Main-thread messages stay byte-identical, **including** the pinned upstream quirks —
  `head -n 5 big` passes (hooks.spec.ts:266-271), `head -100 big` and `tail -n +1`'s
  inverse gate behavior stay as upstream eval asserts; the exemption makes them
  irrelevant for workers without forking upstream semantics.

### 4.3 No worker-contract changes

Nothing a worker does is blocked anymore; the critic/executor/marathon files are
untouched. (A fork child inherits the parent's transcript, stale "please delegate" block
texts included — cosmetic, no remedy needed; recorded.)

### 4.4 Docs and manifest

- `docs/claude-code-capabilities.yaml`:
  - `hooks.pre-tool-use` — record the emitted `agent_id`/`agent_type` (constant) fields
    and the child-scoped `session_id` semantics difference; fold in the stale
    `additionalContext` correction (the bridge injects a non-deny one with an ordering
    divergence, register-events.ts:109-113).
  - `hooks.subagent-start` / `hooks.subagent-stop` — today `behavioral: full`,
    `ux: full`, `deviation: none` while `agent_type` is a constant and no test pins the
    payload shape: downgrade to the honest state (`behavioral: partial`, `ux: partial`
    per the validator's I3 rule; deviation `divergent` naming the constant-`agent_type`
    and `agent_transcript_path` gaps), README matrix regenerated to match. Same-commit
    fix with this PR rather than a separate truthfulness pass.
- `packages/hooks/hooks-claude-code/README.md` / zh: document the identity fields,
  set-membership semantics, resume behavior, and the session_id difference.
- `packages/plugin/dsh-cc-shunt/README.md` / zh: document the subagent exemption and the
  image sniff; re-record the README hash pair (`node scripts/check-readme.mjs --write`).
- Regenerate parity artifacts (`pnpm docs:parity`) and run `check:capabilities`,
  `check:parity`, `check:readme` in the same commit.

### 4.5 Supersession

Resolves the PR #14 limitation ("payload 无调用者身份 → worker 不能靠身份豁免"): identity
now exists on the payload in the shape CC itself specifies, and the worker side never
needed the gate (§1.3).

## 5. Misclassification table

| Caller state | Fields | Shunt behavior | Correct? |
| --- | --- | --- | --- |
| Main thread | none | gate active | yes |
| Named restricted child (critic/executor/marathon) | id + `general-purpose` | exempt | yes — cannot delegate; read caps bound content |
| Unrestricted depth-1/2 child (inherits Task) | id + `general-purpose` | exempt | accepted — same caps argument; the nudge belongs to the spawning orchestrator |
| shunt-reader/shunt-writer | id + `general-purpose` | exempt | yes — they paginate by contract; now belt-and-braces |
| Child `/resume`d to top-level in another process | none (no in-process start event) | gate active | yes — the round-2 registry design got this wrong; the set gets it right |
| Cold-resumed-as-child continuable child | none **until** it re-spawns with a live start | gate active (regression of the exemption) | open — §7; e2e characterizes the event stream |
| Grandchild (depth 2) | id + `general-purpose` | exempt | yes — start precedes first PreToolUse at every depth (probed) |
| `read_image` on a large PNG, any caller | per caller | allow (magic bytes) | yes — no pagination surface exists |

## 6. Tests

1. **Bridge unit**: fields present exactly when `subagentIds.has(agent.id)`; start-before-
   first-PreToolUse ordering pinned; `agent_id` equals the id emitted by the
   SubagentStart payload in the same flow; grandchild case; **payload field-set goldens
   are added** (no test pins the field set today — this PR must not leave that true);
   resumed-top-level negative case (agent not in the set despite registry/descriptor
   identity — mocked).
2. **Plugin (`dsh-cc-shunt/tests/hooks.spec.ts`)**: all four block sites allow with
   `agent_id` present; main goldens byte-identical without it; image fixtures: extension
   forms plus an **extensionless PNG** (magic sniff); kill switch / offset-limit / pipe
   early-allows parameterized across payload shapes; the `head -n 5` quirk stays pinned.
3. **End-to-end (required)** — full dsh-cc path, NOT the bare testkit spawner. Assembly
   must be spelled out in the test: subagent runtime + spawn provider,
   `@dsh-cc/subagent-task` (the real Task tool), the cc plugin loader with **both real
   plugins mounted** (dsh-cc-agents and dsh-cc-shunt), and a model route configured for
   `critic`. Then `subagent_fork`/`Task` with `subagent_type: "dsh-cc-agents:critic"`;
   the child attempts a >350-line Read; assert (a) the child's tool result is the file
   content, not a block, (b) the PreToolUse payload carried `agent_id`, (c) a root-agent
   read of the same file still blocks with today's golden message. Additional cases: a
   `fork:true` child; a grandchild; a cold-resumed child characterized against §7's open
   edge (assert whichever behavior the event stream actually produces, so a harness
   change shows up as a test diff).
4. **Post-merge dogfood** (config-is-prompt): fresh session — executor child reads a
   >350-line file → passes; root reads the same file → unchanged delegation message;
   root reads a 150 KB PNG (extension and extensionless) → passes. Expectations go in the
   merge commit message.

## 7. Risks and open questions

- **Cold-resumed continuable child and `subagent/start` re-emission** — if the resume
  path does not emit a live start event in-process, that child loses the exemption and
  sees the main-thread (delegation-prescribing) message again. Better than the reverse
  failure (a top-level user session exempted), but a real nuisance; §6.3 pins the actual
  behavior so a future harness change surfaces as a test diff.
- **Registry scan cost vanished with the design** — set membership is O(1).
- **`agent_type` constant** — kind-specific matchers stay non-firing; §10 is the
  follow-up. A hook ecosystem assuming CC's real type tokens will see
  `general-purpose`; documented in the manifest rows.
- **Bash-gate porosity** (`head -n 5`, `tail -n +1`) remains pinned for the main thread
  as upstream eval parity — recorded so a future tightening PR does not mistake it for
  a regression.
- **Soft contract** — third-party hooks will build on `agent_id`; fine, that is verbatim
  CC parity.

## 8. Implementation order

1. Bridge: `subagentIds`-keyed identity fields in the payload family (+ field-set
   goldens) (§6.1).
2. Shunt hooks: exemption + magic-byte image sniff + spec matrix (§6.2).
3. End-to-end full-path test (§6.3).
4. Manifest rows + bridge/shunt READMEs en/zh + `docs:parity` regeneration (§4.4).
5. Commit per config-is-prompt; merge; dogfood (§6.4).

## 9. Review record

- **critic** round 1 (cold, blind): endorsed caller-aware gating; env-var transport
  variant — later superseded.
- **Codex** round 1: SHIP-WITH-FIXES, 8/8 applied (survivors after redesigns: four-site
  test coverage, e2e realism, parity/docs scope, PreToolUse-family scoping semantics).
- **Reviewer round 2** (code-verified): 6 majors + 4 minors, applied: CC parity fields
  replace env var; `DSH_*` namespace rejected; option D re-adopted (read caps evidence);
  image deadlock; e2e to real path; doc overclaim and stale citations corrected.
- **Reviewer round 3** (code-verified): 4 must-fix + 6 minors, applied:
  1. `agent_type` from descriptor label is wrong (label = Task display description,
     tool.ts:247; lands after SubagentStart) and `info.provider` is spawn/fork mechanics —
     this PR keeps `agent_type: 'general-purpose'` as a recorded gap; the Task-side
     id→type registry table is the sketched follow-up (§10).
  2. "Resumed child leaves the registry" was false — it stays registered with
     parent/descriptor intact. Identity switches to the `subagentIds` set
     (register-events.ts:52-54); resume rows in §5 corrected; `agent_id = exec.agent.id`
     with the equality pinned (the round-2 "resolve differently if the ids differ" hedge is
     removed — they are probed equal).
  3. Extension-only image skip misses extensionless images (read_image detects from
     content) — magic-byte sniff added; the "binary read outputs garbage" claim dropped
     (read rejects binaries with an error; gate-side behavior is what matters here).
  4. The e2e must not mimic the plugin-hooks-seam assembly (no subagent runtime/Task
     tool/plugins there) — §6.3 names the full assembly and adds fork/grandchild/resumed
     cases.
  5. Minors: events without a calling agent recorded as out of scope (§4.1); dsh-cc
     child-scoped `session_id` vs CC's main-scoped one documented (§2); manifest
     subagent rows' full/no-deviation claims corrected with the README matrix (§4.4) and
     payload field-set goldens added to the test plan (§6.1); the `head -n 5` direction
     fixed (it *passes*) (§1.3/§4.2); task README citation corrected to 134-136; the
     round-2 "all findings fully applied" overclaim corrected in this record; fork
     children inheriting stale parent block texts noted (§4.3).
- Reviewer round 3 also confirmed: `exec.agent` at pre-execute is the calling subagent
  itself; a shunt `allow` decision is a decoded no-op (no auto-approval side channel);
  adding payload fields breaks no existing test or hook.

## 10. Deferred follow-up: real `agent_type`

If kind-specific hooks matter, introduce it as its own PR: the Task dispatch
(packages/subagent/task) records `childId → type` in an in-process table at spawn —
plugin agents get the scoped id (e.g. `dsh-cc-agents:critic`), file-defined agents get
the frontmatter `name`, untyped spawns get `general-purpose`, internal forks get `''`
(not a CC subagent shape). The bridge reads the table when building payloads; the
`subagentIds` set can merge with it (one map: presence ⇒ subagent, value ⇒ type).
Manifest rows then flip to full with matching evidence. Do NOT source it from the
descriptor label, the header, or `info.provider` (§2).
