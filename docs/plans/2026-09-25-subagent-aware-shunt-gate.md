# Subagent-aware shunt gate: CC-parity caller identity and the subagent exemption

**Status:** **Design — reviewed (critic round 1; Codex round 1 SHIP-WITH-FIXES; reviewer round 2 — all findings verified against code and applied, 2026-09-25).** Supersedes the `DSH_DELEGATION_DEPTH` env-var transport of round 1.

**Date:** 2026-09-25

## 1. Problem

The `dsh-cc-shunt` plugin installs two PreToolUse command hooks
(`packages/plugin/dsh-cc-shunt/hooks/check-file-size.mjs` for Read,
`packages/plugin/dsh-cc-shunt/hooks/check-bash-read.mjs` for Bash) that block whole-file
reads over 350 lines / 100 KB. The hooks are session-scoped (wired at
`packages/hooks/hooks-claude-code/src/register-events.ts:98-104`), so they fire inside
worker subagent sessions too.

The defects, stated precisely (review round 2 corrections applied):

1. **The dead-end sentence.** The block reason's leading sentence prescribes delegation
   via the bulk-reader skill, which critic/executor/marathon cannot execute (no Task /
   no skill surface — critic.md:33-46, executor.md:89-93). The trailing escape clause
   ("re-read just that range with offset/limit — targeted reads always pass") already
   existed, so the misleading part is the prescription, not the absence of an escape.
2. **Images are a true deadlock, on the main thread too.** The bridge maps `read_image`
   to the CC name `Read` (packages/core/tools/tests/cc-names.spec.ts:45-46), so the hook
   cannot tell a 150 KB PNG from a text file — and `read_image` has no `offset`/`limit`,
   so neither half of the current reason is executable for it.
3. **For any subagent, the block is pure churn.** The harness `read` tool is itself
   capped — default 2000 lines, maxLineLength and maxBytes caps
   (`packages/fs/tool-fs/src/read.ts`: READ_LIMIT=2000, caps resolved in index.ts:62-64) —
   and measurement shows a whole-file read and an `offset: 1` read of a 5000-line file
   return byte-identical output. The Bash gate is similarly porous to `tail -n +1` and
   the pinned `head -n 100` quirk. A blocked subagent re-issues and gets the same bounded
   content one round trip later.

## 2. Constraints and verified seams

- **Harness repo is read-only** (user directive 2026-09-10). All fix surface is
  dsh-cc-side: the hook bridge, the shunt plugin, their docs.
- **CC already specifies caller identity on hook payloads.** The agent-sdk hooks
  reference (code.claude.com/docs/en/agent-sdk/hooks) documents: "`agent_id` and
  `agent_type` are populated when the hook fires inside a subagent"; on the base hook
  input in TS (all events); optional on PreToolUse/PostToolUse/PostToolUseFailure/
  PermissionRequest, required on SubagentStart/SubagentStop in Python.
  **dsh-cc emits neither field** (verified by probe: PreToolUse carries exactly
  session_id, transcript_path, cwd, hook_event_name, tool_name, tool_input, tool_use_id),
  and SubagentStart/Stop hard-code `agent_type` to `general-purpose`
  (payloads.ts:26,100-107). Filling these is a parity *fix*, not a contract addition —
  the same hook script then works under real CC, and http hooks receive the fields like
  any other payload data.
- **Why not an env var (round-1 verdict, reversed):** the harness reserves the entire
  `DSH_*` namespace — `scrubbedParentEnv()` strips ambient `DSH_*` case-insensitively
  (harness `packages/subprocess/subprocess/src/index.ts`), and a managed-`DSH_*` registry
  (`ctx.shellEnv`, harness `packages/shell/shell-env/src/index.ts`) owns the prefix with
  the explicit rule that caller-supplied values must not override managed ones. An
  injected `DSH_*` works today but is squatting on a managed namespace; any future
  harness collision is silent precisely because the fail-safe is indistinguishable from
  "unset". A non-`DSH_` env name would dodge this but still reinvents what CC already
  specifies, at worse portability (command hooks only).
- **Type/parentage resolution seam exists.** The live agent registry `ctx.agents`
  exposes child sessions duck-typed (one-shot-ledger precedent,
  packages/subagent/task/src/one-shot-ledger.ts:62-132): `session.header.parentSession`
  for parentage and the child's `subagent/descriptor` event (`ownEvents()` →
  `snapshotEvents()` → legacy `events`) for the spawn `label`. The bridge has `ctx`
  and `exec.agent` at PreToolUse (register-events.ts:104), so identity resolution needs
  no new harness surface.
- **Depth is date-stamped, not identity.** `delegationDepthOf(agent)` reads
  `session.header.delegationDepth` (harness `depth.ts:28-35`; default cap 3,
  packages/subagent/task/src/tool.ts:83). The header value persists: a background child
  session later `/resume`d as a top-level session still reads depth 1 — any
  persisted-depth or persisted-type signal misclassifies it, so identity must be resolved
  from the **live** registry, not the header alone.
- **Depth ≠ capability.** Agents whose frontmatter omits `tools:` inherit the full
  parent tool view, `subagent_fork` included (packages/subagent/task/README.md:121-123);
  with max depth 3, depth-1/2 children can still delegate. Any design that maps depth→
  "cannot delegate" misclassifies those.
- **Config-is-prompt rule.** Whatever the hooks tell the model is prompt surface; the
  post-merge dogfood verification in §7 stands.

## 3. Options considered

| Option | Shape | Verdict |
| --- | --- | --- |
| **A (round 2)** | Fill the CC-parity caller-identity fields (`agent_id` + `agent_type`) on the bridge payload family; the shunt hooks **exempt subagent sessions** (any payload with `agent_id` ⇒ allow) and skip known image formats; main-thread behavior byte-identical. | **Adopt.** |
| A′ (round 1) | Bridge-injected `DSH_DELEGATION_DEPTH` env var; branch message only at PreToolUse. | **Superseded** — reinvents a field CC already specifies (worse: command hooks only, not parity-fillable) and squats on the harness-managed `DSH_*` namespace (§2). |
| B | Docs-only pagination clause in worker contracts. | **Moot** — there is no worker-facing block left to explain. (And per review: such a clause must never live inside the `actor-contract` marker block, which is stripped for non-`glm-*` routes.) |
| C | Grant critic/executor a scoped `shunt-reader` spawn. | Reject (unchanged): violates the no-delegation purity; no type-scoped grant mechanism; executor is already cheap-lane. |
| D | Exempt subagent sessions from the gate. | **Adopt scoped into A.** The round-1 rejection ("a worker whole-reading a 5 MB file derails its task") did not survive measurement: harness read caps bound any single read anyway, the round-trip re-issue yields the same bytes (§1.3), and the Bash gate is porous by pinned upstream quirks. The gate's value is preserving the *orchestrator's* context and its delegation nudge — both live on the main thread, which is untouched. |
| E | Capability-based gating (has `subagent_fork` ∧ depth < 3 ⇒ delegate message; else worker message). | Reject as primary mechanism: no cheap, reliable capability lookup is available at hook granularity from a hook *process*; any depth/persisted-type proxy misreads both ways (depth-1/2 inheriting children; `/resume`d top-level sessions). The exemption makes capability moot — every subagent session is already the cheap lane. |

## 4. Design

### 4.1 Bridge: emit CC-parity caller identity

`payloads.ts` `base()` gains, for every hook event fired with a calling agent
(PreToolUse/PostToolUse/PostToolUseFailure/PermissionRequest/Stop family — TS base-input
parity), two fields **present only when the calling agent is a delegated child**:

- `agent_id`: the child's identity, using the **same id SubagentStart emits**
  (registry-issued `info.id`): hook authors must be able to correlate a PreToolUse back
  to its SubagentStart. (Acceptance criterion: the e2e in §6.3 asserts equality; resolve
  via the live registry, not `session.header.id`, if they differ.)
- `agent_type`: the spawn type token as CC spells it — the scoped form for plugin agents
  (e.g. `dsh-cc-agents:critic`), `general-purpose` for untyped children. Resolution order:
  live-registry descriptor label (`ctx.agents.get(...)` → `subagent/descriptor` event)
  → `general-purpose` fallback whenever the agent is delegated but unresolvable.

**Live-registry, fail-toward-absent.** Identity is resolved at hook time against the live
registry, never from the persisted header: a background child `/resume`d as a top-level
session is not in the registry, gets no fields, and therefore gets main-thread behavior —
the correct outcome (§2). A depth-0 caller always gets no fields. The round-1
"fail toward main" discussion is preserved in spirit: absence = status quo.

**SubagentStart/Stop fix in the same PR**: replace the hard-coded
`SUBAGENT_TYPE = 'general-purpose'` with the resolved type, keeping `general-purpose` as
the unresolvable fallback — this makes kind-specific matchers (hooks.json
`agent_type` matching) actually fire, which the current constant disabled by
construction. `agent_transcript_path` (CC also emits it on SubagentStop) stays out of
scope: dsh-cc has no public transcript-path accessor (`transcript_path: ''` gap is
already recorded in payloads.ts:36-40).

### 4.2 Shunt hooks: subagent exemption + image skip

Both `.mjs` scripts gain two guards, ahead of the thresholds (kill switch and
offset/limit/pipe early-allows keep their current order and semantics):

```js
const payload = JSON.parse(stdin)
if (typeof payload.agent_id === 'string' && payload.agent_id !== '') allow()
```

- **Subagent exemption**: any hook invocation carrying CC's subagent identity is a
  delegated session → allow. Rationale is §1.3 / option D: a subagent context is
  disposable and bounded by the read tool's own caps; the block cost a round trip and
  bought nothing.
- **Image skip**: `check-file-size.mjs` allows when the path ends in one of the formats
  `read_image` accepts (png/jpg/jpeg/webp/gif, case-insensitive). The hook cannot
  distinguish `read` from `read_image` by name or input shape (both carry a bare
  `file_path` when read is called unadorned), so the format sniff is the only correct
  discriminator; extensionless binaries stay gated, which is fine — reading them with
  `read` yields garbage regardless. This fixes the image deadlock on the main thread too.
- Main-thread messages are otherwise **byte-identical** to today, including the pinned
  upstream Bash quirks (`head -n 100` blocked, `tail -n +1` passes): the exemption makes
  those quirks subagent-irrelevant without forking upstream eval semantics.

### 4.3 No worker-contract changes

Round 1 planned a pagination clause in critic/executor/marathon. Under the exemption it
teaches nothing gate-related, and review surfaced two placement traps it would have hit:
it must sit *outside* the `actor-contract` markers (the block is stripped for non-`glm-*`
routes — marathon on an unconfigured `fable` alias included), and it must explicitly
override the contracts' "report missing capability as a blocker" sentence for the
large-read case. Removing the clause removes both traps. Nothing in the worker .md files
needs to change because nothing a worker can do any longer gets blocked.

### 4.4 Docs and manifest

- `docs/claude-code-capabilities.yaml`: update the `hooks.pre-tool-use` row (caller
  identity fields now CC-complete; fold in the stale `additionalContext` correction —
  the bridge *does* inject a non-deny one with an ordering divergence,
  register-events.ts:109-113) and the subagent-hook rows (`agent_type` is now the real
  spawn token with `general-purpose` fallback). Regenerate with `pnpm docs:parity`;
  commit matrix + README parity block + capabilities.json together; run
  `check:capabilities`, `check:parity`, `check:readme`.
- `packages/hooks/hooks-claude-code/README.md` / `README.zh.md`: document the identity
  fields and their live-registry resolution semantics (incl. the `/resume` recovery).
- `packages/plugin/dsh-cc-shunt/README.md` / `README.zh.md`: document the subagent
  exemption and the image skip; re-record the README hash pair
  (`node scripts/check-readme.mjs --write`).

### 4.5 Supersession

Fully resolves the PR #14 limitation ("payload 无调用者身份 → worker 不能靠身份豁免") —
by giving the payload the identity CC itself specifies, and by recognizing that the
worker side never needed the gate at all (§1.3).

## 5. Misclassification table

| Caller state | Fields emitted | Shunt behavior | Correct? |
| --- | --- | --- | --- |
| Main thread (depth 0) | none | gate active | yes |
| Named restricted child (critic/executor/marathon) | id+type | exempt | yes — they cannot delegate; caps bound the read |
| Unrestricted depth-1/2 child (inherits Task) | id+type | exempt | accepted — same caps argument; delegation nudge belongs to the orchestrator that spawned it |
| shunt-reader/shunt-writer | id+type | exempt | yes — they paginate by contract anyway; now belt-and-braces |
| `/resume`d child now top-level | none (not in live registry) | gate active | yes |
| Delegated but registry lookup fails | id + `general-purpose` fallback | exempt | yes — identity presence, not type, drives the exemption |
| read_image on a large PNG | whatever the caller carries | allow (format skip) | yes — no pagination surface exists for images |

## 6. Tests

1. **Bridge unit**: `base()` emits both fields for a delegated agent, none for depth 0;
   descriptor lookup failure with depth>0 still emits `agent_id` + `general-purpose`;
   registry absent ⇒ duck-typed no-crash fallback. SubagentStart/Stop carry the resolved
   type (kind-specific matcher fires) and keep the `general-purpose` fallback.
2. **Plugin (`dsh-cc-shunt/tests/hooks.spec.ts`)**: all four block sites (byte + line ×
   Read + Bash) allow when `agent_id` is present — including a worker read where the main
   goldens would block; image paths (png/jpg/jpeg/webp/gif, mixed case) allow at main
   level too; main-thread goldens byte-identical without `agent_id`; kill switch,
   offset/limit, and pipe early-allows parameterized across both payload shapes.
3. **End-to-end (required)**: full dsh-cc path, not the harness-level spawner — mount the
   cc preset with the real shunt plugin hooks (plugin-hooks-seam.spec.ts assembly
   precedent), dispatch through `subagent_fork`/`Task` with
   `subagent_type: "dsh-cc-agents:critic"`, have the child attempt a >350-line Read, and
   assert (a) the child's tool call was NOT blocked, (b) the emitted PreToolUse payload
   carried `agent_id` equal to the SubagentStart `agent_id`, (c) `agent_type` is the
   scoped plugin id. A root-session read of the same file must still block with today's
   golden message.
4. **Post-merge dogfood** (config-is-prompt): fresh session; executor child reads a
   >350-line file → passes the gate directly; main-thread read of the same file →
   unchanged delegation message; main-thread read of a 150 KB PNG → passes. Commit
   message states these expectations per AGENTS.md.

## 7. Risks and open questions

- **Registry-lookup cost per hook**: one map get + a descriptor-event scan per invocation
  on tool-call fire paths. `ownEvents()` cost scales with session event count — pin the
  descriptor is found in the child's FIRST pre-step (one-shot-ledger.ts:184), so the scan
  can stop early; measure once during implementation.
- **`agent_type` token form**: the descriptor `label` is assumed to carry the scoped
  spawn token; if it carries a display label instead, map through the definition catalog
  at resolve time — the e2e assertion (§6.3c) is the tripwire.
- **Soft contract**: third-party hooks will build on `agent_id`/`agent_type` — fine,
  that's verbatim CC parity, and the fallback semantics (`general-purpose` when
  delegated-but-unresolvable) must be documented in the bridge README.
- **Bash-gate porosity** (`tail -n +1`, `head -n 100` quirk) remains pinned for the main
  thread as upstream eval parity; naming it here so a future tightening PR doesn't
  rediscover it as a regression.
- **Behavioral compliance** with the unchanged main message is out of scope here; the
  dogfood check (§6.4) covers only the changed surfaces.

## 8. Implementation order

1. `payloads.ts` identity fields + resolution helper (bridge unit spec).
2. SubagentStart/Stop real `agent_type` (+ matcher behavior change recorded in the
   manifest row).
3. Shunt hooks exemption + image skip + `hooks.spec.ts` matrix.
4. End-to-end full-path test (§6.3).
5. README en/zh ×2 packages + manifest rows + `docs:parity` regeneration.
6. Commit message per config-is-prompt; merge; dogfood verify (§6.4).

## 9. Review record

- **dsh-cc-agents:critic**, round 1 (cold, blind): endorsed caller-aware gating; its
  env-var transport variant was accepted then — superseded by round 2's parity finding.
- **Codex** (`/codex:rescue`, read-only), round 1: SHIP-WITH-FIXES, 8 findings, then all
  applied to the env-var design (capability-neutral wording, PreToolUse scoping, parsing
  strictness, four-site tests, concrete e2e assembly, parity scope, hookEnv/http
  correction). Findings that survive the redesign (four-site test coverage, e2e realism,
  parity/docs scope) are carried into §6 and §4.4.
- **Reviewer round 2** (code-verified relay): 6 majors + 4 minors, **all verified in
  code and applied**:
  1. CC specifies `agent_id`/`agent_type` on hook inputs in subagents (agent-sdk hooks
     docs) — adopted as the transport; replaces the env var wholesale.
  2. `DSH_*` is harness-managed (scrub + `ctx.shellEnv` registry + no-override rule) —
     verified; env transport rejected on this ground too.
  3. Option D's rejection didn't hold — harness read caps bound any read (READ_LIMIT=2000;
     maxBytes/maxLineLength config), whole-read ≡ offset-read byte-identical; D adopted in
     scoped form (subagent exemption).
  4. Depth-based judgment misreads both ways (inheriting depth-1/2 children; `/resume`d
     top-level depth-1 sessions) — design switched to live-registry identity; resume case
     lands on the correct side by construction (§5).
  5. Images blocked with non-executable advice (`read_image` ⇒ `Read`, no offset/limit) —
     format skip added; pre-existing on the main thread.
  6. e2e must drive the real dsh-cc Task→plugin-agent path with the real shunt plugin
     loaded — §6.3 rewritten.
  7. Minor: no worker-contract clause ⇒ the actor-contract-marker and blocker-override
     traps disappear with it (§4.3).
  8. Minor: problem statement rescoped (the escape clause existed; the prescription was
     the defect) — §1.
  9. Minor: stale citations fixed (task README sanitize lines; §6.3 path).
