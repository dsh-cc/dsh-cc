# Subagent-aware shunt gate: `DSH_DELEGATION_DEPTH` and worker-actionable block reasons

**Status:** **Design — reviewed (critic round 1 + Codex round 1 SHIP-WITH-FIXES, all 8 findings applied 2026-09-25).**

**Date:** 2026-09-25

## 1. Problem

The `dsh-cc-shunt` plugin installs two PreToolUse command hooks
(`packages/plugin/dsh-cc-shunt/hooks/check-file-size.mjs` for Read,
`packages/plugin/dsh-cc-shunt/hooks/check-bash-read.mjs` for Bash) that block whole-file
reads over 350 lines / 100 KB. Both block reasons prescribe the same remedy: "delegate
via the bulk-reader skill" (check-file-size.mjs:82-88, 100-104; check-bash-read.mjs:92-98,
109-113) — i.e. spawn the plugin's cheap-lane `shunt-reader` worker.

The hooks are session-scoped (`ctx.on('tools/pre-execute')`, wired at
`packages/hooks/hooks-claude-code/src/register-events.ts:98-104`), so they fire inside
worker subagent sessions too. PR #14 recorded this as a known limitation: the hook
payload carried no caller identity, so workers could not be exempted or handled
differently. The workaround at the time was contractual: `shunt-reader`'s own contract
forces ≤300-line paged reads, and reads with `offset`/`limit` always pass the gate
(check-file-size.mjs:65), so the gate was designed to be never-tripped by design, not to
be escaped by identity.

The gap: every *other* worker agent trips it. `critic`, `executor`, and `marathon`
(`packages/plugin/dsh-cc-agents/agents/*.md`) deliberately have no Task/subagent surfaces
and — for executor — no skill/command surface either (executor.md:89-93,
critic.md:33-46). When such a worker reads a >350-line file it gets blocked with a
remedy it cannot execute: the model either burns turns attempting a delegation that its
tool whitelist rejects, or reports a spurious blocker to the orchestrator.

## 2. Constraints and available seams

- **Harness repo is read-only** (user directive 2026-09-10). All fix surface must be
  dsh-cc-side: the hook bridge (`packages/hooks/hooks-claude-code`), the shunt plugin, and
  the dsh-cc-agents definitions all qualify.
- **Caller depth is already computable dsh-cc-side.** The public harness accessor
  `delegationDepthOf(agent)` (`@deepseek-ai/dsh-subagent`) is in use at
  `packages/subagent/task/src/strip-instructions.ts:12,21` (0 = main thread, >0 =
  delegated child). The hooks bridge already declares `@deepseek-ai/dsh-subagent` in both
  its peer range and dev link (package.json:40,64) — no new dependency.
- **The caller agent reaches `runPoint` at PreToolUse.** The registration
  (register-events.ts:104) passes `exec.agent` into `runPoint`, and `runPoint` already
  builds a per-invocation hook env for command hooks
  (`packages/hooks/hooks-claude-code/src/run-point.ts:85-89`, `CLAUDE_PROJECT_DIR`). The
  runner forwards that env (`packages/hooks/hook-protocol/src/runner.ts:75,83`); the
  scrub-then-merge itself happens one layer down, in the harness subprocess executor.
- **Delegation depth ≠ delegation capability.** Agents whose frontmatter carries no
  `tools:` line inherit the parent tool view, `subagent_fork`/`Task` included
  (packages/subagent/task/README.md:120-127). Depth tells us the caller is *already
  delegated*; it does not tell us whether it can itself delegate.
- **Config-is-prompt rule.** The block reason *is* the intervention; its wording must be
  verified in a real session post-merge (AGENTS.md).

## 3. Options considered

| Option | Shape | Verdict |
| --- | --- | --- |
| **A** | Caller-aware gate: the bridge annotates PreToolUse hook invocations with the caller's delegation depth; the hooks branch on `depth > 0` for the **message only** (decision unchanged), with a capability-neutral, locally-executable reason: paginate with offset/limit, grep-pipe. Companion clause in the critic/executor/marathon contracts. | **Adopt.** |
| **B** | Docs-only: teach pagination in the worker agent contracts; leave hook messages unchanged. | Reject as the fix, **adopt as companion to A**. The block-time message is the only channel guaranteed to be in-context at decision time; contracts are advisory. B alone also leaves third-party/future worker agents broken. |
| **C** | Grant critic/executor a delegation surface to `shunt-reader` (nested spawn). | Reject. Violates the deliberate no-delegation purity of those agents; no type-scoped grant mechanism exists (would need new sanitize machinery); savings are marginal — executor already runs on the cheap lane; touches actor-contract-gate realms. |
| **D** | Exempt `depth > 0` sessions from the gate (always allow). | Reject. Removes the guard where it still has value: a worker whole-reading a 5 MB minified file derails its own task. The gate protects whatever context it fires in. |

### Transport decision inside A: env var, not payload field

The original sketch proposed a `dsh_delegation_depth` field on the PreToolUse stdin
payload. Review verdict flipped this to a bridge-built **environment variable**
`DSH_DELEGATION_DEPTH` on the existing `hookEnv` channel:

- Hook stdin payloads are the CC-parity contract surface (the manifest tracks the
  `hooks.pre-tool-use` row, docs/claude-code-capabilities.yaml:1328-1350). A documented,
  load-bearing non-CC field becomes a contract third-party hook authors can build on and
  we cannot retract. An injected env var is invisible to CC-schema parity and, today, has
  exactly one consumer: our own hook scripts.
- Golden payload tests (`packages/hooks/hooks-claude-code/tests/events.spec.ts`) assert
  payload shapes; an env var touches none of them.
- Failure semantics are identical: absent variable → depth 0 → today's behavior.
- Scope clarity (review correction): `hookEnv` reaches **command-hook processes only** —
  dispatch forwards env to command hooks (dispatch.ts:73,124) and http hooks never receive
  it, so there is no "inert var on http" case to explain or whitelist.

## 4. Design

### 4.1 Bridge: inject `DSH_DELEGATION_DEPTH` for PreToolUse command hooks

In `run-point.ts`, extend the `hookEnv` construction **only when `point ===
'PreToolUse'`**:

```
depth = (opts.agent !== undefined) ? safeDepth(opts.agent) : 0
hookEnv = { CLAUDE_PROJECT_DIR?, DSH_DELEGATION_DEPTH: String(depth) }
```

`safeDepth(agent)` wraps `delegationDepthOf(agent)` in try/catch and returns `0` on any
throw, on a non-finite result, or on a negative value.

**Injection scoped to PreToolUse** (review finding): other hook points either pass no
agent at all (PermissionDenied, Notification, PostCompact, SessionEnd, TaskCreated), which
would emit a misleading `'0'` for child-origin events, or have no consumer. The parity
delta stays confined to the PreToolUse hook point. Should a PostToolUse consumer appear
later, extending the gate is a one-line condition change, not a contract migration.

**Fail-safe direction: toward the main thread — by appeal, not by context protection.**
Review corrected the original justification: with message-only branching the file stays
blocked either way, so a main thread misclassified as worker does *not* lose bulk-content
protection (its context never receives the file through this gate; pagination is also a
valid remedy there). What it loses is the plugin's primary nudge — the delegation
recommendation that keeps bulk out of the expensive conversation — and if depth-reading
fails *systematically* (harness API drift), that loss is total and silent. Conversely, a
worker misclassified as main keeps today's noisy status quo, which the companion contract
clause (§4.3) covers for the three bundled agents. Failing toward main is therefore the
right default; the alternative — failing toward the worker message because local
pagination is universally executable — is recorded and rejected on the systematic-failure
ground.

**Strict parsing in the hooks** (review finding): accept only non-negative safe-integer
decimal values — reject negative, fractional, `Infinity`, hexadecimal, empty, and garbage.
Idiom: `/^\d+$/.test(raw)` before `Number(raw)`, still treating the result with a
`Number.isSafeInteger` guard. Tested against: unset, empty, `0`, `1`, `2`, `-1`, `1.5`,
`Infinity`, `0x1`, `garbage`.

### 4.2 Shunt hooks: capability-neutral worker reasons, same decisions

Both `.mjs` scripts gain the depth check above. Decision logic is untouched: thresholds,
kill switch, `offset`/`limit` early-allow, and piped/redirected early-allow all stay
exactly as they are. Only the `block(reason)` text branches — and the worker text is
**capability-neutral** (depth says nothing about whether this worker can itself delegate,
§2): it must not claim "no delegation surface" and must not name or prohibit shunt
agents. Worker messages carry no delegation vocabulary at all:

Draft worker Read message:
> File is {n} lines (~{kb} KB), over the size threshold ({minLines} lines / {maxBytes} bytes). This session is already a delegated worker — handle the read locally: re-read the ranges you need with offset/limit (targeted reads always pass this gate), and use Grep to narrow down first.

Draft worker Bash message:
> File is {n} lines (~{kb} KB), over the size threshold ({minLines} lines / {maxBytes} bytes). This session is already a delegated worker — handle the read locally: pipe to grep/head (e.g. `cat file | grep pattern`); piped or redirected commands always pass this gate.

Main-session messages stay byte-identical to today. Each script has **two** block sites
(byte-size and line-count) — both branch, in both files; the shared-text refactor lives
inside each file since the plugin's standalone scripts intentionally carry no shared
module.

### 4.3 Companion: worker agent contracts

Add one short clause to `agents/critic.md`, `agents/executor.md`, `agents/marathon.md`,
phrased conditionally (shunt is opt-in — with the plugin disabled there is no gate at
all) and scoped to *this* gate's guarantee, not every conceivable pre-tool gate:

> Large reads: if a size gate (e.g. the shunt plugin's) blocks a whole-file read as too
> large, re-read the needed range with `offset`/`limit` — targeted reads always pass this
> gate — or grep for the sections you need. You have no delegation surface; resolve it
> locally.

### 4.4 Docs and manifest

- `packages/plugin/dsh-cc-shunt/README.md` / `README.zh.md`: document the injected
  variable as **bridge-injected, not user-set** (the env table's user knobs are
  `SHUNT_*`); describe the worker-session message. Run
  `node scripts/check-readme.mjs --write` to re-record the hash pair.
- `packages/hooks/hooks-claude-code/README.md` / `README.zh.md`: the bridge owns
  command-hook environment behavior — record `DSH_DELEGATION_DEPTH` there too.
- `docs/claude-code-capabilities.yaml`, row `hooks.pre-tool-use`: (a) one sentence
  recording the bridge-injected `DSH_DELEGATION_DEPTH` (no CC equivalent, command hooks
  only); (b) correct the stale `additionalContext` sentence in the same row — the bridge
  *does* inject a non-deny `additionalContext`, with a documented ordering divergence
  (register-events.ts:109-113), which the row's deviation summary predates. Regenerate
  with `pnpm docs:parity` and commit the three generated artifacts together (matrix,
  README parity block, capabilities.json); `check:capabilities`, `check:parity`,
  `check:readme` all run.

### 4.5 Supersession

This resolves the limitation recorded when the plugin landed (PR #14): "the hook payload
carries no caller identity → workers cannot be exempted by identity". The session payload
still carries none; identity now arrives over the per-invocation command-hook env channel
instead.

## 5. Tests

1. **Bridge (`hooks-claude-code`)**: `run-point` spec — at `PreToolUse`, top-level agent
   → `'0'`; delegated agent → `'1'`; `opts.agent` undefined → `'0'`; `delegationDepthOf`
   throw → `'0'`. At a non-PreToolUse point the var is **absent** from hookEnv.
   `CLAUDE_PROJECT_DIR` merging preserved.
2. **Plugin (`dsh-cc-shunt/tests/hooks.spec.ts`)**: cover **all four block sites**
   (byte + line paths in both scripts) at worker depth: the reason carries the local
   remediation (offset/limit or the pipe guidance) and contains no recommendatory
   delegation wording (assert absence of `delegate via`); at depths `0`, unset, and
   garbage the messages are byte-identical golden strings for all four sites; threshold
   boundaries, Read offset/limit early-allow, Bash pipe/redirect early-allow, and the
   kill switch are parameterized across depths 0/1.
3. **End-to-end (required, not optional)**: replicate the real-child assembly precedent
   of `packages/hooks-claude-code/tests/background-subagent-start.spec.ts` (agent-loop
   testkit runtime + spawn provider + JsonlSessionPersistence), spawn a **named,
   tool-restricted child** (the critic/executor defect shape) plus a fork if both spawns
   are in scope, let the child issue a gated Read, and assert a probe command hook records
   `DSH_DELEGATION_DEPTH=1` for the child and `=0` for the root agent. This pins the
   riskiest assumption: depth populated on `exec.agent` for spawned worker sessions on
   the `tools/pre-execute` path (strip-instructions only ever exercises it at
   `agent/pre-step`). A silent `0` here ships the bug invisibly — the failure mode is
   safe, but undetected.
4. **Post-merge dogfood** (config-is-prompt): in a fresh session, an `executor` child
   reads a >350-line file; expected observable change: the block reason is the
   worker variant and the executor paginates without attempting delegation. Recorded in
   the merge commit message per AGENTS.md.

## 6. Risks and open questions

- **Model compliance with the rewritten reason is unverifiable pre-merge** — inherent to
  any prompt-surface change; §5.4 is the remediation.
- **Env name collision with a future harness-native field**: `DSH_` is the dsh-cc product
  prefix, not a harness-reserved namespace; risk accepted, documented in the READMEs.
- **Third-party hook authors may consume the var**: it becomes a soft contract the moment
  it ships. Acceptable — documented and additive; removing it would only ever degrade
  messages back to status quo.
- **`depth > 1` and unrestricted children**: a worker whose frontmatter sets no `tools:`
  *can* itself delegate (§2). The capability-neutral worker message stays harmless for
  them (local pagination is valid advice regardless); by the same token the message never
  claims they cannot delegate.
- **Worker retry loops on the same file**: still possible (the gate still blocks); the
  §4.3 contract clause is the mitigation, not unblocking. If dogfooding shows loops,
  raise a per-worker threshold knob as a follow-up rather than touching the decision.

## 7. Implementation order

1. `run-point.ts` PreToolUse-scoped env injection + bridge spec (§5.1).
2. Both shunt `.mjs` scripts + `hooks.spec.ts` four-site matrix (§5.2).
3. Agent contract clauses ×3 (§4.3).
4. Bridge end-to-end depth test (§5.3).
5. README en/zh ×2 packages + manifest row + `docs:parity` regeneration (§4.4).
6. Commit message states the expected observable behavior change (§5.4); merge, then
   dogfood-verify in a new session.

## 8. Review record

- **dsh-cc-agents:critic**, round 1 (cold, blind to Codex): endorsed A with the env-var
  transport variant; findings applied (env transport, fail-safe-toward-main direction,
  symmetric Read/Bash treatment, required end-to-end depth test, README env-table
  guidance, golden-payload-test avoidance).
- **Codex** (via `/codex:rescue`, read-only), round 1: **SHIP-WITH-FIXES**, 8 findings,
  all applied: depth≠capability → capability-neutral worker message (F1); injection
  scoped to PreToolUse (F2); worker-message/test-text contradiction removed — assertions
  target remediation presence and `delegate via` absence (F3); fail-safe justification
  rewritten + strict safe-integer parsing matrix (F4); all four block sites under test
  (F5); concrete e2e assembly pinned to the background-subagent-start precedent with a
  named restricted child (F6); parity/docs scope widened to the bridge READMEs and the
  stale `additionalContext` manifest sentence (F7); explanatory claims corrected —
  hookEnv reaches command hooks only, scrub-merge lives in the harness subprocess layer
  (F8).
