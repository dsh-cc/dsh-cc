# Subagent-aware shunt gate: `DSH_DELEGATION_DEPTH` and worker-actionable block reasons

**Status:** **Design — reviewed (critic round 1, applied 2026-09-25).** Codex blind-review lane unavailable: the `/codex:rescue` dispatch was declined by the user, so the review record is single-lane (critic).

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
tool whitelist rejects, or reports a spurious blocker to the orchestrator. Third-party
plugin worker agents hit the same dead end.

The block reason's second half *does* name an executable escape (offset/limit, grep-pipe),
but the primary recommendation is a skill the worker cannot load, buried before it.

## 2. Constraints and available seams

- **Harness repo is read-only** (user directive 2026-09-10). All fix surface must be
  dsh-cc-side: the hook bridge (`packages/hooks/hooks-claude-code`), the shunt plugin, and
  the dsh-cc-agents definitions all qualify.
- **Caller depth is already computable dsh-cc-side.** The public harness accessor
  `delegationDepthOf(agent)` (`@deepseek-ai/dsh-subagent`) is in use at
  `packages/subagent/task/src/strip-instructions.ts:12,21` (0 = main thread, >0 =
  delegated child). The hooks-bridge package already declares `@deepseek-ai/dsh-subagent`
  in both its peer range and dev link (package.json:40,64) — no new dependency.
- **The caller agent reaches `runPoint`.** The PreToolUse registration
  (register-events.ts:104) passes `exec.agent` into `runPoint`, and `runPoint` already
  builds a per-invocation hook env (`packages/hooks/hooks-claude-code/src/run-point.ts:85-89`,
  `CLAUDE_PROJECT_DIR`). The runner merges that env after the executor scrub
  (`packages/hooks/hook-protocol/src/runner.ts:26-27,83`).
- **Whitelist scoping does not exist.** Agent tool whitelists are exact-name
  sanitization; there is no mechanism to grant `subagent_fork` scoped to specific agent
  types (§3, option C).
- **Config-is-prompt rule.** The block reason *is* the intervention; its wording must be
  verified in a real session post-merge (AGENTS.md).

## 3. Options considered

| Option | Shape | Verdict |
| --- | --- | --- |
| **A** | Caller-aware gate: bridge annotates each hook invocation with the caller's delegation depth; hooks branch on `depth > 0` for the **message only** (decision unchanged) and give workers an actionable reason: paginate with offset/limit, grep-pipe; delegation is unavailable in this session. Companion clause in the critic/executor/marathon contracts. | **Adopt.** |
| **B** | Docs-only: teach pagination in the worker agent contracts; leave hook messages unchanged. | Reject as the fix, **adopt as companion to A**. The block-time message is the only channel guaranteed to be in-context at decision time; contracts are advisory. B alone also leaves third-party/future worker agents broken. |
| **C** | Grant critic/executor a delegation surface to `shunt-reader` (nested spawn). | Reject. Violates the deliberate no-delegation purity of those agents; no type-scoped grant mechanism exists (would need new sanitize machinery); savings are marginal — executor already runs on the cheap lane; touches actor-contract-gate realms. |
| **D** | Exempt `depth > 0` sessions from the gate (always allow). | Reject. Removes the guard where it still has value: a worker whole-reading a 5 MB minified file derails its own task. The gate protects whatever context it fires in. |

### Transport decision inside A: env var, not payload field

The original sketch proposed a `dsh_delegation_depth` field on the PreToolUse stdin
payload. Review verdict flipped this to a bridge-built **environment variable**
`DSH_DELEGATION_DEPTH` extending the existing `hookEnv` channel:

- Hook stdin payloads are the CC-parity contract surface (the manifest tracks the
  `hooks.pre-tool-use` row, docs/claude-code-capabilities.yaml:1328-1350). A documented,
  load-bearing non-CC field becomes a contract third-party hook authors can build on and
  we cannot retract. An injected env var is invisible to CC-schema parity and has exactly
  one consumer: our own hook scripts.
- Golden payload tests (`packages/hooks/hooks-claude-code/tests/events.spec.ts`) assert
  payload shapes; an env var touches none of them.
- Failure semantics are identical: absent variable → depth 0 → today's behavior.
- Accepted cost: the var is also set for http hooks (which cannot use process env), where
  it is simply inert — `httpAllowedEnvVars` never whitelists it, so it stays out of any
  request by design; the payload keeps no caller identity either way.

## 4. Design

### 4.1 Bridge: inject `DSH_DELEGATION_DEPTH` per hook invocation

In `run-point.ts`, extend the `hookEnv` construction:

```
depth = (opts.agent !== undefined) ? safeDepth(opts.agent) : 0
hookEnv = { CLAUDE_PROJECT_DIR?, DSH_DELEGATION_DEPTH: String(depth) }
```

`safeDepth(agent)` wraps `delegationDepthOf(agent)` in try/catch and returns `0` on any
throw, on a non-finite result, or on a negative value.

**Fail-safe direction: toward the main thread.** This is deliberately the *opposite* of
strip-instructions.ts:22-24, which fails toward child. For a block gate, the conservative
failure is the main-thread message: a worker misclassified as main gets today's (noisy
but harmless) status quo; a main thread misclassified as worker would silently lose the
plugin's primary purpose — keeping bulk out of the expensive conversation.

This applies to every hook invocation, not only PreToolUse: `runPoint` is shared, the
computation is one defensive call, and other hook points (PostToolUse, Stop, …) get a
consistent value for free.

### 4.2 Shunt hooks: worker-actionable reasons, same decisions

Both `.mjs` scripts gain one helper:

```js
const isWorker = Number(process.env.DSH_DELEGATION_DEPTH) > 0
```

`Number(undefined)`/`Number('garbage')` are `NaN`, which fails the `> 0` test — so a
missing or corrupt value falls back to main-thread framing, matching §4.1.

Decision logic is untouched: thresholds, kill switch, `offset`/`limit` early-allow, and
piped/redirected early-allow all stay exactly as they are. Only the `block(reason)` text
branches:

- **Main session (`isWorker` false):** byte-identical to today's messages.
- **Worker session (`isWorker` true):** the delegation sentence is replaced.

Draft worker Read message:
> File is {n} lines (~{kb} KB), over the shunt threshold ({minLines} lines / {maxBytes} bytes). **This session has no delegation surface — do not attempt to spawn a shunt/bulk-reader subagent.** Re-read the ranges you need with offset/limit (targeted reads always pass this gate), and use Grep to locate the sections that matter.

Draft worker Bash message:
> File is {n} lines (~{kb} KB), over the shunt threshold ({minLines} lines / {maxBytes} bytes). **This session has no delegation surface — do not attempt to spawn a shunt/bulk-reader subagent.** Pipe to grep/head (e.g. `cat file | grep pattern`) — piped or redirected commands always pass this gate.

Both scripts stay self-contained (the shared-text refactor lives inside each file; the
plugin's scripts intentionally carry no shared module, per the port's
dependency-free design).

### 4.3 Companion: worker agent contracts

Add one short clause to `agents/critic.md`, `agents/executor.md`, `agents/marathon.md`,
phrased conditionally (shunt is opt-in — with the plugin disabled there is no gate at
all):

> Large reads: if a pre-tool gate blocks a whole-file read as too large, you have no
> delegation surface — never attempt to spawn a shunt/bulk-reader subagent. Re-read the
> needed range with `offset`/`limit` (targeted reads always pass) or grep for the
> sections you need.

### 4.4 Docs and manifest

- `packages/plugin/dsh-cc-shunt/README.md` / `README.zh.md`: document the injected
  variable as **bridge-injected, not user-set** (the env table's user knobs are
  `SHUNT_*`); describe the worker-session message. Run
  `node scripts/check-readme.mjs --write` to re-record the hash pair.
- `docs/claude-code-capabilities.yaml`, row `hooks.pre-tool-use`: one sentence in the
  deviation summary recording the bridge-injected `DSH_DELEGATION_DEPTH` (no CC
  equivalent, inert for http hooks). Regenerate with `pnpm docs:parity` and commit the
  three generated artifacts together (matrix, README parity block, capabilities.json).

### 4.5 Supersession

This resolves the limitation recorded when the plugin landed (PR #14): "the hook payload
carries no caller identity → workers cannot be exempted by identity". The session payload
still carries none; identity now arrives over the per-invocation env channel instead.

## 5. Tests

1. **Bridge (`hooks-claude-code`)**: `run-point` spec — top-level agent → `'0'`;
   delegated agent → `'1'`; `opts.agent` undefined → `'0'`; `delegationDepthOf` throw →
   `'0'`. Assert `CLAUDE_PROJECT_DIR` merging is preserved.
2. **Plugin (`dsh-cc-shunt/tests/hooks.spec.ts`)**: at `DSH_DELEGATION_DEPTH=1`, a blocked
   Read names offset/limit and never names bulk-reader/shunt-reader; same for Bash with
   the pipe guidance; at `0`, unset, and garbage, messages are byte-identical to today;
   kill switch and offset/limit early-allow unaffected at any depth.
3. **End-to-end (required, not optional)**: an integration test in the bridge's
   harness-assembled spec family (same assembly as `bridge.spec.ts`) that spawns a
   delegated child, lets it issue a gated tool call, and asserts the probe hook observed
   `DSH_DELEGATION_DEPTH=1`. This pins the riskiest assumption: that the depth is
   populated on `exec.agent` for forked/named worker sessions on the `tools/pre-execute`
   path (strip-instructions only ever exercises it at `agent/pre-step`). A silent `0` here
   ships the bug invisibly — the failure mode is safe, but undetected.
4. **Post-merge dogfood** (config-is-prompt): in a fresh session, an `executor` child
   reads a >350-line file; expected observable change: the block reason is the
   worker variant and the executor paginates without attempting delegation. Recorded in
   the merge commit message per AGENTS.md.

## 6. Risks and open questions

- **Model compliance with the rewritten reason is unverifiable pre-merge** — inherent to
  any prompt-surface change; §5.4 is the remediation.
- **Env name collision with a future harness-native field**: `DSH_` is the dsh-cc product
  prefix, not a harness-reserved namespace; risk accepted, documented in the README.
- **Third-party hook authors may consume the var**: it becomes a soft contract the moment
  it ships. Acceptable — it is documented and additive; removing it would only ever
  degrade messages back to status quo.
- **`depth > 1`** (a worker that itself delegates): the branch is `> 0`, so nested workers
  get the worker message — correct, since a sub-subagent's delegation surface is no
  broader.
- **Worker retry loops on the same file**: still possible (the gate still blocks); the
  §4.3 contract clause is the mitigation, not unblocking. If dogfooding shows loops,
  raise a per-worker threshold knob as a follow-up rather than touching the decision.

## 7. Implementation order

1. `run-point.ts` env injection + bridge spec (§5.1).
2. Both shunt `.mjs` scripts + `hooks.spec.ts` (§5.2).
3. Agent contract clauses ×3 (§4.3).
4. Bridge end-to-end depth test (§5.3).
5. README en/zh + manifest row + `docs:parity` regeneration (§4.4).
6. Commit message states the expected observable behavior change (§5.4); merge, then
   dogfood-verify in a new session.
