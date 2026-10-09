# Verify-before-retry for mutating tool calls (design)

- Date: 2026-10-09
- Status: **Implemented** — package `packages/interaction/retry-attendant`, preset row before hooks-claude-code, capability manifest `engine.verify-before-retry` (this PR). Design review: internal critic GO (4 rounds); codex/grok external blind review both GO-WITH-AMENDMENTS, folded through v5.2 (two delta rounds each; cross-seat sibling-remedy adjudication in §8); user sign-off 2026-10-09.
- Scope: new package `packages/interaction/retry-attendant`; capability manifest row; preset registration. No harness-upstream dependency. No edits to `post-edit-verify` (boundary in §2).
- Sources: Verified Tool Calls (arXiv 2608.02645): non-atomic tool failures fall into four classes (timeout-after-dispatch, delayed visibility, partial success, stale conflict) where the observed response is not a reliable proxy for the effect; verify the postcondition before retrying; ablation showed the verification-only variant captures most of the gain (duplicate side effects 20–72% → ~0 with the full wrapper).

## 1. Problem

When a mutating tool call fails ambiguously — a bash timeout, a dropped MCP
connection mid-mutation — the model sees an error string and typically retries
immediately. For non-atomic operations the retry runs against a possibly-applied
effect: `pnpm install` re-run over a half-mutated `node_modules`, `git commit`
re-run after it actually committed (double commit), a file copy repeated over a
partial target. The observed failure tells the agent nothing about which world it
is in, and nothing in dsh-cc today tells the agent to check before retrying.

Probe-verified facts (2026-10-09 refresh, this worktree + linked
`deepseek-harness` tree — the "upstream-unverifiable" hedges of v3 are now
resolved):

- Tool results are a discriminated union
  `ToolExecutionSuccess | ToolExecutionFailure`
  (`packages/core/tools/src/tool-types.ts:269-293`); the failure branch is
  `{ isError:true, error: { message, info?: { name, code, reason? } }, content }`.
  `error.info.code` exists only when the tool threw a `HarnessError`
  (`packages/core/tools/src/abort-utils.ts:28-34,102-124`); plain `Error`
  failures — including all MCP bridge failures
  (`packages/mcp/mcp-client/src/tools.ts:420,436-437`) — carry no code.
- **`isError` is NOT the dominant failure surface for bash.** Under the default
  composition a bash timeout is *promoted to a background job*
  (`promoteOnTimeout: z.boolean().default(true)`,
  `harness packages/shell/tool-bash/src/index.ts:52-58,214`; promotion is gated
  on background-registry availability, `:45,214`): the tool returns a
  success-shaped value `{kind:'promoted', jobId, timeoutMs, output}` (promoted
  arm of the output `oneOf` at :416-425, `oneOf` starts :410). Non-promoted
  timeouts return a success `foreground` value with `timedOut:true,
  exitCode:null` (preparation-timeout shape at :336-338; the non-promote
  settle path is `canonicalBashResult` :526-529), surfaced in text only as the
  marker `[timed out after Xms]` (`render.ts:53`; promoted job reads carry
  `[still running after …]`, `render.ts:77-83`). Persistent-bash timeouts
  likewise return success text carrying `[Command timed out or OOM]`
  (`tool-bash-persistent/src/index.ts:21,355-359`). Sandbox denials render as
  notice text appended to the output (`render.ts:106-117`, `background.ts:23`)
  plus a structured `sandbox.denied` field — again success-shaped, not a thrown
  error; the marker itself is `sandboxDenialMarker`
  (`packages/sandbox/sandbox/src/escalation.ts:71-72`). The escalated retry
  surface `sandbox_permissions` exists as a declared tool parameter (:395-405)
  when escalation modes are composed. **Consequence: bash-class detection must
  run on both result branches — success values (field/name + marker text) and
  failure text — never on `isError` alone.** (Structurally, not a measured
  frequency claim.) The cc preset's Windows composition disables `bash` and
  enables `pwsh` (`agent.cordis.yml:58-64`), and pwsh shares the promotion
  default and timeout marker (`tool-pwsh/src/index.ts:69,75,218`,
  `tool-pwsh/src/render.ts:73`) under tool name `pwsh` (:384).
- **Bash arguments carry volatile, model-written metadata.** `description` is
  a required, model-authored parameter
  (`tool-bash/src/index.ts:378-383` schema, required at :381), alongside
  `timeoutMs`, `justification`, `sandbox_permissions`. A digest over the full
  arguments object would treat a reworded description as a different call
  (§3.3 digest is over effect fields only).
- `tools/pre-execute` exposes the full parsed `exec.arguments` pre-dispatch
  (`packages/core/tools/src/index.ts:122`,
  `packages/core/tools/src/tool-types.ts:120-129`); `exec.agent?` may be absent
  for agent-less executions (`runtime-execute.ts:159-163`).
- `tools/post-execute` decisions can append non-destructive
  `additionalContexts` (type: `packages/core/tools/src/tool-types.ts:314-317`; runtime fold merges them:
  `packages/core/tools/src/runtime-results.ts:52-90`; producer precedent:
  `packages/interaction/post-edit-verify/src/recovery-wiring.ts:85`,
  `packages/interaction/turn-rules/src/wiring.ts:218,252`).
- **Core does not know `kind:'plugin'` as a message source**:
  `MessageSourceMap` (harness `packages/llm/llm/src/message.ts:103-111`) is a
  merge-extensible sum with an explicit "no shared catch-all plugin kind"
  comment; every real producer declares its own kind via module augmentation
  (precedent `packages/interaction/post-edit-verify/src/recovery-wiring.ts:18-24`
  declaring `'edit-recovery-hint'`). This package declares
  `source.kind = 'retry-attendant'` the same way (§3.2, §4).
- `agent.inject(message: UserMessage)` is real
  (harness `packages/core/agent/src/runtime-types.ts:241`) and
  `createUserMessage` is importable from `@deepseek-ai/dsh-llm`; the
  inject-from-tool-decision precedent is
  `packages/hooks/hooks-claude-code/src/register-events.ts:114-115`.
- **The `tools/pre-execute` waterfall is delegation-order sensitive, and
  `prepend:true` ordering is settled, not unknown.** The permission plugin
  returns `{kind:'allow'}` *without* calling `next()` when its rules/auto-mode
  allow the call
  (`packages/interaction/permission-rules/src/pre-execute.ts:287-313`,
  no-delegate at `:295,310`). Any later-registered listener's decision is then
  silently never consulted. cordis `prepend` is `unshift`
  (`harness vendor/cordis/src/events.ts:255`) and the waterfall runs the
  listener list from index 0 outward (`events.ts:234-242`), so **the
  later-registered prepend listener is the OUTERMOST**. hooks-claude-code
  registers its pre-execute listener with `prepend:true`
  (`register-events.ts:128`; row + comment at
  `packages/preset/cc/agent.cordis.yml:416-418`). Retry-attendant's pre-execute
  listener must also use `prepend:true` (permission bypass, §3.3) **and its
  preset row must be registered BEFORE the hooks-claude-code row** so that
  hooks' later prepend lands outside it (§3.3 Act (a)).
- **The inject vs additionalContexts ordering is settled, not unknown.**
  `agent.inject` appends to the next-step inbox without waking
  (`harness packages/core/agent-loop/src/agent.ts:171-172`); post-execute
  `additionalContexts` append to that same inbox at result commit
  (`agent.ts:534-536`, `tool-calls.ts:157`). The inbox is claimed at the next
  `preStep` (`agent.ts:316`). For an inject issued at pre-execute of call N:
  queue order is tool-result, then the inject, then any additionalContexts of
  call N — `register-events.ts:111-113` already calls this the post-result
  FIFO. The §5.3 pin test is a regression lock on this written-down order.
- Session identity for per-session state: `exec.agent?.session` carries
  `header.id` (keyed-state precedent:
  `packages/interaction/turn-rules/src/wiring.ts:240`). Agent-less executions
  get no M2 state (§3.3).
- No per-call input digest / idempotency index exists anywhere in `core/tools`
  (probe: ABSENT). Nearest existing digests are the permission classifier's
  verdict-cache keys
  (`packages/interaction/permission-rules/src/llm-classifier.ts:147-161`) —
  sha256 over joined strings (`listDigest` :154-156) — but that precedent does
  not fit here: bash arguments carry volatile model-written fields
  (`description`, §1). Our digest is stable-json over **effect fields only**
  (§3.3), a deliberate divergence from the precedent.

## 2. Goals and non-goals

Goals:

1. **M1 — ambiguous-outcome postcondition guidance.** When a configured mutating
   tool call produces an *ambiguous outcome* — a failure (`isError:true`) OR a
   success-shaped result carrying a non-atomicity signal (timeout promotion,
   `timedOut:true`, sandbox denial notice — see §3.2) — append a short,
   per-class "check before retry" guidance block via `additionalContexts` so the
   very next model turn sees it.
2. **M2 — retry dedup escalation.** If the agent re-dispatches the identical
   mutating call (same tool, same args digest) while its ambiguous outcome is
   still "unresolved" (no intervening designated check, §3.3), escalate that one
   call to `ask` with a reason naming the earlier outcome. **Approval-absent
   fallback (v5: decision-preserving):** the approval seam is consumed *per
   escalation*, not latched at registration — `serviceAsk` does its
   `ctx.get('approval')` lookup at call time (dsh-cc
   `packages/core/tools/src/runtime-code.ts:144-158`; this is the dsh-cc
   core/tools fork, not the harness tree), and an approval service composed
   later mid-session must still receive asks. So each escalation checks anew:
   when the approval service is absent at that moment, the fallback returns
   **the downstream decision unchanged unless it is `allow`/passthrough**:
   downstream `deny`/`cancel`/`ask` pass through untouched (a downstream `ask`
   is then denied by core with its own reason — the correct posture for a
   call permission itself required; turning it into `allow` would erase an
   existing permission requirement), and only when the downstream verdict is
   `allow`/passthrough does the fallback return `{kind:'allow'}` plus the
   M1-style advice by direct injection:
   `exec.agent?.inject(createUserMessage({ content:[{type:'text',text}],
   source:{ kind:'retry-attendant' } }))` — hook-context precedent
   `packages/hooks/hooks-claude-code/src/register-events.ts:114-115`.
   Symmetrically, when approval IS present and we override a downstream `ask`
   with ours, the reason COMBINES both ("<retry context> (also: <downstream
   ask reason>)") so the approval prompt surfaces every requirement.
   (Inject ordering is settled by code, §1; §5.3 pins it as a regression
   lock.)

Non-goals:

- **Edit/write file-content recovery** — already owned by `post-edit-verify`
  (edit-recovery-hint merged into it, PR #189). This package explicitly does not
  register guidance for `edit` `old_string`-not-found; one owner per hint.
  (Known no-write edit failures — `FS_STALE_VERSION`, `FS_AMBIGUOUS_EDIT`,
  not-found — are excluded from `write-partial` too, since nothing was
  written: §3.2. v5 correction: an earlier draft claimed stale-conflict
  "remains post-edit-verify's domain" — that package's hint only matches
  multiline not-found and handles no stale-conflict class; the sentence is
  dropped.)
- **True idempotency keys / at-least-once semantics for MCP tools** — that is a
  protocol-level change (server cooperation), recorded as §7 follow-up.
- **Automatic postcondition execution** (the runtime itself running checks) —
  the first version advises; it does not execute checks on the agent's behalf.
  Rationale: advice is safe under wrong detection; silent extra mutation is not.
- Bash exit codes remain text-level; no harness ask.

## 3. Design

### 3.1 Package and registration

New package `packages/interaction/retry-attendant` (`@dsh-cc/retry-attendant`),
plain cordis plugin (no Service → no isolate-realm requirement;
handoff-store precedent). Registration (same commit): cc-services group row in
`packages/preset/cc/agent.cordis.yml`, **placed BEFORE the hooks-claude-code
row** (§3.3 Act (a) — unlike advisor-watchdog's tail position, the row index
is load-bearing here);
composition pin in `packages/preset/cc/tests/composition.spec.ts`; capability
manifest `engine.*` row in `docs/claude-code-capabilities.yaml` regenerated
via `pnpm docs:parity`; package README trio. All active behavior defaults
OFF (`retry-attendant.enabled`, §3.5). Test-side import of
`@dsh-cc/post-edit-verify` (§5.1) follows existing interaction→interaction
dependency precedent (advisor-watchdog → `@dsh-cc/permission-rules`).

### 3.2 M1 — ambiguous-outcome guidance

Post-execute listener (default priority, NOT prepend — content augmentation
after crushers is fine; ordering asserted by composition test, §5):

On any configured tool class matching its trigger — **on either result branch** —
append (deduped per fresh digest, see precedence block above; type-guard the
value before field reads — persistent-bash and pwsh results can be plain
strings, and an unguarded `value.kind` read under the §4 swallow rule would
silently skip the text fallback):

```jsonc
// additionalContexts entry, source-marked with OUR OWN kind
{ "role": "user",
  "content": [{ "type": "text",
    "text": "[retry-attendant] <class-specific guidance; one line, ≤ 200 chars>" }],
  "source": { "kind": "retry-attendant" } }
```

`'retry-attendant'` is declared into `MessageSourceMap` by module augmentation
(copy the `recovery-wiring.ts:18-24` pattern); the augmentation is part of the
package's deliverables (§3.1) and the source kind is added to the injected-source
denylist convention only if a recall-side consumer emerges (none today — no
denylist edit in this package).

Failure-class table (data file `classes.json`, unit-tested). "value shape" means
inspecting the success branch's structured `value` when the tool declares an
output schema (bash does); "text" means the rendered result content on either
branch:

| class | trigger (tool + shape/text signal) | guidance content |
|---|---|---|
| `bash-timeout` | `tool ∈ {bash, pwsh}` AND (success value `{kind:'promoted',...}` OR success value `{kind:'foreground', timedOut:true}` OR rendered text contains `[timed out after`, `[still running after`, or `[Command timed out or OOM]`) | "The command may have partially applied before timing out (or still runs as a background job). Verify the intended postcondition (e.g. re-check files/processes, read job state) before re-running it." |
| `bash-sandbox-denied` | `tool ∈ {bash, pwsh}` AND (success value field `sandbox.denied === true` OR rendered text contains `[sandbox: file access denied` or `[sandbox: the sandbox runner itself failed`) | "Sandbox denial: a file effect was refused mid-run (partial effects possible) or the runner itself failed (nothing ran). Check the result marker; verify state before re-running with wider permissions." |
| `git-mutation` | `tool ∈ {bash, pwsh}` AND first token `git` AND subcommand ∈ {commit, push, reset, rebase, merge, cherry-pick, am, checkout, switch} AND (`isError` OR `foreground` value with numeric `exitCode !== 0` — `null` does NOT match, so timeout shapes stay `bash-timeout`) | "Git mutations are not atomic with respect to retries. Run a read-only `git status`/`git log` check first." |
| `pkg-install` | `tool ∈ {bash, pwsh}` AND command head matches `pnpm/npm/yarn/bun (install|add|remove)` AND (`isError` OR `foreground` value with numeric `exitCode !== 0`) | "Package installs mutate node_modules progressively. Check `node_modules`/lockfile state before re-running; a partial install is usually resumable." |
| `mcp-mutation` | `tool` prefixed `mcp__` AND `isError` | "If this call mutated remote state, verify before retrying; read-only calls can be retried freely." (read-safe text: noise for read-only MCP tools is accepted; **M1-only class — M2 never fires for it, see §3.3**) |
| `write-partial` | `tool:"write"|"edit"` AND `isError` AND NOT excluded. Exclusion = the union of: `isRecoveryCandidate` (real import, `hint.ts:39-44`: edit + multi-line `old_string` + not-found text), `error?.info?.code === 'FS_AMBIGUOUS_EDIT'` (no write happened — multiple matches), `error?.info?.code === 'FS_STALE_VERSION'` (no write happened — version guard refused), and the `old_string was not found in` message anchor (single-line not-found also wrote nothing). **This union is deliberately broader than `isRecoveryCandidate`**: the biconditional "exclusion ⟺ isRecoveryCandidate" is FALSE (FS_AMBIGUOUS_EDIT fails that predicate and is excluded by policy). Propagation verified: `fs-local/fsio.ts:831` throws `FsError(...,'FS_AMBIGUOUS_EDIT')`, `FsError extends HarnessError` (`fs/src/types.ts:196`), so `toolErrorResult` (`abort-utils.ts:116-124`) hands post-execute a real `error.info.code`. | "The write may be partial. Read the target path before retrying." |

**Class precedence (first match wins, one class per outcome):** a single
outcome is tested against the table top-to-bottom and the FIRST match wins;
exactly one class is stored in the M2 map and exactly one guidance line is
appended. This resolves the overlap where a preparation-timeout `git commit`
(`timedOut:true`, `exitCode:null`) matches both `bash-timeout` and
`git-mutation`: `bash-timeout` is listed first and wins; the numeric-exit
guard on git/pkg makes the non-promote and promoted paths unambiguous.

**Guidance dedup:** M1 guidance fires only on a FRESH digest — when the M2
map already holds a live entry for this call's key (within `expireMinutes`),
the guidance line is not appended again (§4 noise bullet relies on this).

Rationale for the two-branch reading (v4 change): the headline class
(`bash-timeout`) almost never lands on the failure branch under default
composition (§1 probe). Trigger definitions therefore name the success-value
fields directly (`kind`, `timedOut`, `sandbox.denied`) where the schema exists,
with rendered-marker text as the persistent-bash/cross-shell fallback.

First-token/head extraction: reuse the same minimal parse style as
`packages/interaction/permission-rules/src/shell-words.ts` (`firstShellToken` :25,
`stripLeadingAssignments` :11) but implemented locally — **do not import
permission-rules internals** (package boundary; duplication of ~30 lines is
accepted deliberately).

Fragility note (written into the doc and the data file): value-field shapes are
schema-pinned (bash output `oneOf` at tool-bash/src/index.ts:410-470, promoted
arm :416-425, foreground arm :426+) so field drift is a type-checkable surface;
rendered markers are wording-sensitive. Mitigation: each class's pattern is
exercised against fixture shapes in unit tests, and an integration note lists
the exact upstream construction points
(`tool-bash/src/render.ts:53,77-83,106-117`,
`tool-bash-persistent/src/index.ts:21,355`,
`packages/core/tools/src/abort-utils.ts:116-124`) so wording drift is a
grep-detectable maintenance task. A local fixture string alone detects drift
on OUR side only; cross-tree drift is caught by grepping the construction
points at harness-bump time.

### 3.3 M2 — retry dedup escalation

Per-session in-memory map (NOT disk — the state is deliberately ephemeral; a
retry after a session restart is a human-supervised decision anyway). Keyed by
`exec.agent?.session.header.id` (turn-rules precedent `wiring.ts:240`); the
session boundary is intentional: a child/subagent session has its own
`header.id` and its own map, so a retry delegated to a child does not see the
parent's entry (accepted; the delegation prompt is the human-supervised
path). Executions without `exec.agent` (headless/agent-less) skip M2 entirely
(the fallback inject path needs an agent anyway):

```
key = sha256(stableJson({tool: exec.name, effect: effectFields(exec)}))[:16]
value = { recordedAt, class, outcomeHead, escalated?: true, askInFlight?: true }
```

**Digest is over effect fields ONLY, never the full arguments.** Bash/pwsh
arguments carry `description` — a required, model-authored field — plus
`timeoutMs`, `justification`, `sandbox_permissions`; a digest over full args
would treat a reworded description as a different call and M2 would stay
silent on the very retries it exists for. Projection per tool:
`bash|pwsh` → `{command, workdir}`; `write` → `{file_path, content}`;
`edit` → `{file_path, old_string, new_string}`; unknown/other tools → all
arguments (stable-serialized; `stableJson` handles non-object values per
`mcp-client/tools.ts:404-408`). Key order is canonicalized by `stableJson`.

- **Set** on post-execute detection of a configured M2 class (M1's listener
  writes it — one listener serves both mechanisms), **only when the key is
  absent or expired**; never reset an `escalated:true` entry. Ambiguous-success
  classes (`bash-timeout` promoted)` count as "recorded" too — a promoted job
  is exactly the delayed-visibility case duplicated retries corrupt.
- **mcp-mutation is M1-only**: it is never set into the map and never
  escalated. Rationale: the trigger fires on *every* MCP failure (read-only
  included), so dedup would escalate harmless read retries and dominate
  escalation-fatigue telemetry (v4 change; revisit if a mutation heuristic
  lands, §7).
- **Clear** the key (and only that key) ONLY on:
  (a) post-execute success of the **same digest** that matches **no ambiguous
      class at all** (a fresh result of the same command that again matches a
      class trigger — even a different class than the stored one, e.g. a
      stored `git-mutation` followed by a promoted timeout of the same
      command — does NOT clear), or
  (b) success of the **class-designated check** — per class:
      `git-mutation` → bash whose first token is `git` AND second token ∈
      {status, log, diff, show} (they are second tokens, not first);
      `pkg-install` / `bash-timeout` / `bash-sandbox-denied` → no designated
      check (conservative: only same-digest success or expiry clears);
      `write-partial` → a successful `read` of the same `file_path` as the
      failed call.
  A successful but non-check mutating call clears nothing — conservative
  direction.
  **Soundness note (v4):** clear-rule (b) deliberately does NOT unblock the
  retry on the grounds that a check happened while the mutation had in fact
  applied — clearing then would license exactly the duplicate side effect this
  mechanism exists to prevent. Instead (b) marks the entry `resolved:true`,
  and the identical retry that follows is escalated **harder**, not softer: the
  ask reason names both the earlier failure AND the fact that a check succeeded
  ("identical retry after <class>; a check (<check>, <time>) ran in between —
  confirm the effect state before re-running" — neutral wording: the check may
  equally have shown the effect applied OR not applied, so the reason asserts
  neither). Same-digest success (a) alone proves the intended
  effect landed fresh, and fully clears.
  Also expire entries after 10 minutes. **Digest-fragility disclosure:**
  identical logical retries with different timestamp/temp-path args never
  digest-match → silent false negatives; accepted.
- **Act** at `tools/pre-execute` **with `prepend:true`** (order-pinning against
  the permission plugin's non-delegating `allow`, §1): if the incoming call's
  key matches a live entry, the listener escalates — but **only after
  delegating**, never by short-circuit:

  ```
  const entry = liveEntryFor(key)            // lookup BEFORE delegating
  if (entry === undefined) return next()     // non-escalation path
  if (entry.escalated) return next()         // already consulted & allowed
  if (entry.askInFlight)                      // sibling of a pending ask:
    return { kind: 'deny',                    // must NOT execute (see Bounded)
             reason: 'identical call is already awaiting confirmation' }
  entry.askInFlight = true                    // synchronous CAS, pre-await window
  const downstream = await next()             // always delegate before deciding
  // pass downstream deny/cancel through unchanged, releasing the in-flight bit
  if (downstream.kind === 'deny' || downstream.kind === 'cancel') {
    entry.askInFlight = false
    return downstream
  }
  // downstream allow/ask/passthrough → our ask wins (approval-absent
  // fallback: preserve downstream instead, §2 — release the bit there too)
  return { kind: 'ask', reason, displayReason }
  // askInFlight is released by resolution tracking (Bounded), never by
  // this return alone: approval settles after the waterfall returns.
  ```

  Two composition constraints made this shape mandatory (v4-D1, order pinned
  in v5):
  (a) **retry-attendant's pre-execute listener must end up INNER to
      hooks-claude-code's** (hooks stays outermost). hooks-claude-code's own
      pre-execute listener is also `prepend:true`
      (`register-events.ts:128`; row at
      `packages/preset/cc/agent.cordis.yml:416-418`) and folds user hooks by
      delegating first, then applying its own override over the downstream
      decision (`register-events.ts:119-127`). cordis `prepend` is `unshift`
      and the waterfall runs index 0 first, so **the later-registered
      prepend listener is outermost** (harness `vendor/cordis/src/events.ts:255`,
      `:234-242`; `effect()` runs registration bodies immediately,
      `fiber.ts:405-418`). Therefore the **retry-attendant row must be placed
      BEFORE the hooks-claude-code row** in `agent.cordis.yml` — the
      advisor-watchdog row shape's cc-services tail position (AFTER hooks) is
      wrong for this plugin and would unshift retry-attendant outside hooks,
      letting its delegate-then-ask fold clobber the hook `allow` and void
      §3.4. The traversal with hooks outer: hooks → retry-attendant →
      permission on the way in, unwinding on the way back — hooks' fold sees
      retry-attendant's `ask` as downstream and lets a user PreToolUse hook
      `allow`/`ask` replace it (the §3.4 contract). The pin is the YAML row
      index (asserted in `composition.spec.ts`, which parses YAML but executes
      no listeners), plus a live two-listener waterfall fold test with the REAL
      hooks-claude-code bridge (not a self-authored stub — a stub proves its
      own fold, not the production registration order; §5.4).
  (b) the permission plugin's non-delegating `allow` (§1 probe) is bypassed only
      because prepend puts retry-attendant outside it; the delegate-first shape
      above keeps a downstream deny — from permission rules or user hooks —
      authoritative.

  The `ask` verdict returned on escalation —
  `{ kind:'ask'; reason?: string; displayReason?: { en: string; [locale:string]: string } }`
  (`packages/core/tools/src/tool-types.ts:304-308`; `reason` is optional there,
  but we always set it) — names the earlier failure and class, and the
  check-resolved status when applicable ("identical retry of <tool> after
  <class>; a check (<check>, <time>) ran in between — confirm the effect state
  before re-running" — neutral wording: the check may equally have shown the
  effect applied OR not applied; the escalation is the safe direction either
  way). The pre-execute decision union and its `ask` kind are the existing core
  gate fold (`packages/core/tools/src/runtime-execute.ts:169-197` is the fold
  site to pin in implementation; fold semantics pinned in §3.4).

Bounded escalation **attempt** semantics (v5 precision; refined in the
external delta round): one "ask" means one *consultation*, not one execution,
and the bound is structural, not a fixed count —

- **Sibling race (execution-level, not just ask-level; cross-seat adjudicated
  v5.1):** two identical concurrent calls can both pass the
  `escalated !== true` check before either writes. Guard: the listener
  compare-and-sets an `askInFlight` bit **synchronously, before `await
  next()`** (JS single-threading makes the pre-await window atomic). An
  identical sibling encountering the bit **must not execute and must not
  return the downstream verdict** (in auto mode that verdict is a
  non-delegating `allow`, `pre-execute.ts:310` — the duplicate would run
  while the prompt is still up): the sibling branch returns
  `{kind:'deny', reason:'identical call is already awaiting confirmation'}`
  short-circuit, so the model sees an explainer and re-issues after the first
  call settles. (`{kind:'cancel'}` — bare union member, no reason field,
  `tool-types.ts:307`, handled at `runtime-execute.ts:180-181` as a clean
  pre-dispatch abort — is the reason-less alternative; deny is preferred
  because its reason is model-visible.) Adjudication note: codex proposed
  await-the-pending-resolution-then-reevaluate; grok proposed
  block-execution. grok's shape is adopted — blocking a tool-decision
  listener on human contemplation time has no repo precedent and risks
  slot-holding and signal/TTL races — while codex's resolution-tracking seam
  below is retained wholesale.
- **Resolution tracking (the concrete observation seams, v5.2):** approval resolves
  AFTER the pre-execute waterfall returns (`runtime-execute.ts:169` →
  `serviceAsk` at `runtime-code.ts:173`), so `await next()` cannot observe
  allowed-once or rejection. The reservation is associated with its owning
  execution (`callId`) and tracked on two dedicated seams — dispatch is never
  inferred from the absence of rejection text, because guard denials and
  pre-dispatch cancellations also reach post-execute as error results
  (`runtime-execute.ts:183,198`):
  (i) **Positive dispatch evidence** — the owning execution reaches the
      `tools/execute` waterfall (declared seam
      `packages/core/tools/src/index.ts:133`, entered only via the
      `{kind:'dispatch'}` next at `runtime-execute.ts:201`). Observed ⇒ the
      ask was allowed, by user approval OR an outer-hook `allow` override
      (indistinguishable; both consume): set `escalated:true`, release
      `askInFlight`. The observe-only listener there must passthrough
      (`next(result)`) and never rewrite;
  (ii) **Terminal release** — the owning execution's `tools/result` emit
      (`index.ts:167`; fires on every terminal path, including the
      final-result bypass at `runtime-execute.ts:202` that post-execute
      alone would miss) without prior dispatch evidence ⇒ release
      `askInFlight`, entry stays un-escalated (rejection does not
      consume). A DENIED SIBLING's terminal result neither releases nor
      consumes the reservation it never owned (the reservation is keyed to
      the first execution's `callId`, not the digest alone);
  (iii) every other terminal path — our listener returned
  downstream `deny`/`cancel` instead of the ask, the approval-absent
  fallback, an internal error swallowed to passthrough ⇒ release the bit
  synchronously at return time. Safety: `askInFlight` also releases when
  the entry expires, so a call whose seams never fire (turn aborted
  mid-approval) cannot wedge the key. We do NOT infer approval from the
  tool's own success/failure semantics — only the two seams above.
- **Bound:** at most one consultation in flight per entry; rejections may
  repeat consultations until expiry (there is deliberately no fixed
  one-attempt bound per entry lifetime); the latch is consumed on
  allowed-once (observed dispatch), after which identical retries pass
  through. A hook-downgraded ask (outer hook turned our ask into `allow`,
  `register-events.ts:126`) consumes the attempt — the user's hook IS the
  user consulting.

### 3.4 Interplay rules (normative)

- M2 never fires for tools outside the class table, and never for the M1-only
  `mcp-mutation` class.
- **Hook precedence:** a user PreToolUse hook returning `allow` or `ask`
  overrides retry-attendant's downstream `ask` — **verified** at
  `packages/hooks/hooks-claude-code/src/register-events.ts:110-127`
  (hook-deny short-circuits without `next()`; downstream deny wins over hook
  ask/allow; hook ask/allow override downstream ask). This contract holds ONLY
  because of the two pins in §3.3's Act bullet: retry-attendant delegates
  before deciding (so the hook fold sees its ask as "downstream"), and the
  hooks-claude-code listener stays outer (so its allow/ask override applies
  after retry-attendant's fold). Accepted contract:
  **downstream deny wins; user hook allow/ask wins over plugin ask.**
- M1 guidance is additive only (`additionalContexts`); this package never
  rewrites result content and never blocks.
- If `post-edit-verify` produced guidance for the same failure, M1 for
  `write-partial` still fires only on its exclusion rule; the exclusion patterns
  are pinned by a contract test against post-edit-verify's hint triggers
  (`packages/interaction/post-edit-verify/src/hint.ts:29-30` NOT_FOUND_ANCHOR
  string, `:39-44` `isRecoveryCandidate`) so a hint
  widening over there fails our test here (call it out in code comment both
  directions).

### 3.5 Configuration

One kebab-case settings namespace (`retry-attendant.*`, repo convention —
`cc-edit-recovery-hint.enabled` precedent; the earlier draft's camelCase
`retryAttendant.*` spelling is dropped):

- `retry-attendant.enabled` (default `false`, dogfood-first).
- `retry-attendant.guidance` (default `true` when enabled) — M1.
- `retry-attendant.escalate` (default `true` when enabled) — M2.
- `retry-attendant.expireMinutes` (default `10`).

### 3.6 Transcript visibility

On escalation and on each fresh outcome-with-guidance, append
`session.append('retry-attendant/event', {kind:'guidance'|'escalation', class,
tool, digest, ts})` when `exec.agent?.session` is reachable (module augmentation
pattern: `packages/hooks/hook-protocol/src/types.ts:8-9`; `exec.agent.session`
anchor: harness `packages/core/agent/src/runtime-types.ts:168`). All listener
errors degrade to silent passthrough (CCR hot-path rule); the append itself is
try/caught (open-turn append can throw — hook-protocol invariant precedent).

## 4. Failure modes and mitigations

- **retry-attendant must never break a tool call**: swallow + debug-log only.
- **escalation fatigue**: bounded per entry lifetime (§3.3 attempt
  semantics); `mcp-mutation` excluded from M2 entirely; a user rejection
  does NOT silence the next identical retry's ask (the denial tools are the
  durable exit), and the `escalated` mark prevents re-asking only after an
  actual allowed-once consultation.
- **cross-session staleness**: none (in-memory only).
- **approval service absent**: M2's `ask` would become a hard denial in core
  (`packages/core/tools/src/runtime-execute.ts:173-175`, `serviceAsk` path);
  therefore **per escalation** (call-time lookup, not a registration latch —
  `serviceAsk` itself looks up `ctx.get('approval')` per ask,
  dsh-cc `runtime-code.ts:144-158`), when the approval service is absent, the
  fallback **preserves the downstream decision** (`deny`/`cancel`/`ask` pass
  through — a downstream ask denied by core is the correct posture for a call
  permission itself required; overriding it with `allow` would erase an
  existing permission requirement), and only when the downstream verdict is
  `allow`/passthrough does it return `{kind:'allow'}` plus the advice via
  `exec.agent?.inject(createUserMessage({ content:[{type:'text',text}],
  source:{ kind:'retry-attendant' } }))` (precedent
  `packages/hooks/hooks-claude-code/src/register-events.ts:114-115`) —
  stated explicitly in §2. Note: `PreToolDecision` carries no
  `additionalContexts` field (`tool-types.ts:304-308`), so a pre-execute
  advice channel must be inject, not context-append. Executions without
  `exec.agent` can neither ask nor inject — passthrough (§3.3). The inject
  contract permits cancellation/disposal to discard pending context
  (`runtime-types.ts:233`), so no unconditional delivery is claimed.
- **false class detection**: worst case is a guidance line or a single ask;
  both tolerable.
- **ambiguous-success noise**: `bash-timeout` promoted results are common on
  long builds; guidance fires per fresh digest only (dedup map), and the text
  names the background-job state so the natural next step is `job_output`,
  not a blind retry.

## 5. Verification plan

Unit tests (vitest, package-internal):

1. Class table: fixture outcomes → expected class or none (first-match
   precedence; overlapping shapes like preparation-timeout `git commit` must
   classify `bash-timeout`, not `git-mutation`). **Success-branch fixtures
   are mandatory** for shell classes: promoted value, foreground
   `timedOut:true`, foreground numeric `exitCode!==0` for git/pkg (and
   `exitCode:null` NOT matching git/pkg), `sandbox.denied` value,
   persistent-bash marker text (string-valued result — the type-guard is
   exercised), pwsh marker text; write-partial exclusion tested as the
   **union** (not biconditional): (i) every `isRecoveryCandidate` fixture is
   excluded (one-way implication, real import from `@dsh-cc/post-edit-verify`,
   `hint.ts:39-44`), (ii) separately, fixtures carrying
   `error.info.code === 'FS_AMBIGUOUS_EDIT'` and `'FS_STALE_VERSION'` are
   excluded (deliberate no-write policy), (iii) the `old_string was not
   found in` anchor (`hint.ts:29-30` NOT_FOUND_ANCHOR) pins wording drift,
   (iv) an ordinary write failure (e.g. mid-write FS error) is NOT excluded.
2. M1: bash promoted result ⇒ guidance present despite `isError:false`;
   failing bash timeout (persistent marker) ⇒ additionalContexts; clean success
   ⇒ none; second ambiguous outcome of the SAME digest ⇒ guidance deduped
   (fresh-digest rule); downstream `additionalContexts` from other listeners
   are preserved (spread precedent: context-crusher
   `packages/context/context-crusher/src/index.ts:251-257`). Assert source kind
   equals `'retry-attendant'` and the module augmentation compiles.
3. M2: ambiguous outcome → same-effect-fields call (reworded `description`,
   different `timeoutMs`) ⇒ ask with reason (digest projection); retry after a
   successful designated check (git status / read of same path) ⇒ **harder ask
   whose reason names the check**; retry of `mcp__*` after identical failure ⇒
   passthrough (M1-only class); fail→different-effect-args ⇒ passthrough;
   same-digest clean success ⇒ fully cleared, passthrough; same-digest success
   that re-matches ANY class (including a different class than stored) ⇒ NOT
   cleared; expiry ⇒ passthrough; `escalated:true` entry never reset by a new
   outcome; **sibling race: two concurrent identical calls ⇒ exactly one ask
   AND the second sibling does NOT execute — assert on the sibling's own
   decision (deny-with-reason), not merely on the ask count**; **rejection does not
   consume the latch ⇒ the next identical retry asks again; allowed-once
   consumes it ⇒ the next passes through**; approval service absent with
   downstream allow ⇒ `{kind:'allow'}` + inject fallback; approval service
   absent with downstream ask ⇒ downstream ask preserved (no allow-override);
   agent-less execution ⇒ passthrough with no state keying; and the
   pre-execute-inject vs post-result FIFO ordering pin (expected order per
   §1: tool result, then inject, then additionalContexts). **Resolution-seam
   tests:** owning execution observed at `tools/execute` ⇒ latch consumed;
   terminal `tools/result` without dispatch evidence ⇒ bit released, entry
   live (rejection path); a denied sibling's terminal result ⇒ reservation
   untouched; expiry sweep ⇒ bit released even when no seam ever fired.
4. Waterfall discipline: forced internal throw ⇒ passthrough, log written.
   Interplay composition tests:
   (a) a permissive stub permission listener registered in append order
   BEFORE retry-attendant ⇒ ask still fires (guards the `prepend:true`
   contract for the permission bypass);
   (b) a live two-listener waterfall test mounting the REAL hooks-claude-code
   bridge (or its registration function) together with retry-attendant in
   code-registered order — hook `allow` downgrades our ask, hook `ask`
   replaces it, hook `deny` short-circuits, downstream `deny`/`cancel` pass
   through (guards §3.3 Act (a) / §3.4 with production fold code, not a
   self-authored stub);
   (c) the YAML row pin: `composition.spec.ts` asserts the retry-attendant row
   index is BEFORE the hooks-claude-code row in `agent.cordis.yml` (the
   executable-order pin; cordis prepend semantics are settled —
   `events.ts:255` — so no derivation-from-stubs is claimed).
5. Preset composition pin updated in `packages/preset/cc/tests/composition.spec.ts`
   (preset row in `packages/preset/cc/agent.cordis.yml`, cc-services group,
   **row placed before hooks-claude-code**, see §3.3 Act (a));
   `pnpm check:capabilities` + README trio + `check:size` green;
   capability manifest row in `docs/claude-code-capabilities.yaml` regenerated
   via `pnpm docs:parity`.

Dogfood: enable in user layer on the dsh-cc repo; collect
`retry-attendant/event` rows for a week; expected observable: escalation fires
only on genuine identical retries (manual check of first 20), and guidance rows
on promoted bash jobs are read as "job state exists" rather than "failure".

## 6. Falsification / metrics

Dogfood metrics from session events: count of escalations, overrides (user
denied the ask), guidance-vs-escalation ratio per class (a bash-timeout
dominated count is expected — promoted jobs are the common case), and
post-guidance behavior change (did the next tool call check before mutating —
approximated by a `read`-class call or `job_output` preceding the retry).
If guidance shows no measurable behavior change after dogfood, M1 is removed and
M2 kept or removed by the same evidence. (A11 discipline: this section is the
do-nothing baseline commitment.)

## 7. Follow-ups

1. Protocol-level idempotency for MCP mutations (server-provided idempotency
   keys; blocked on protocol support — out of dsh-cc's control surface). A
   mutation heuristic for MCP tools (read-only annotation consumers) would also
   unlock M2 for `mcp-mutation`.
2. Harness ask: structured `error.info.code` or typed ambiguous-outcome classes
   for bash timeout/sandbox classes so text matching can be retired (upstream
   proposal; bash currently surfaces ambiguity only via success-value fields +
   rendered markers, §1).
3. Postcondition *execution* (runtime runs the check) for a whitelist of
   declarative postconditions — requires the sealed-eval discipline, not before.

## 8. Review ledger

**Round 1 — internal critic (2026-10-09).** Verdict: **GO-WITH-AMENDMENTS**;
11 findings, all adopted. Amended sections: §2 (approval-absent fallback),
§3.2 (read-safe mcp-mutation guidance; FS_AMBIGUOUS_EDIT as
`error.info.code`), §3.3 (strict clear rule, set-never-resets-escalated,
digest-fragility disclosure, ask type named, llm-classifier citation fixed,
runtime-execute.ts anchor spacing fixed, fully-qualified anchor paths), §3.4
(hook-precedence contract), §5 (real `isRecoveryCandidate` import contract
test), §3.1/§5 (concrete registration paths). Upstream-unverifiable items for
implementation-time confirmation: bash timeout wording (text-signal fragility
note) and FS_AMBIGUOUS_EDIT propagation to post-execute results.

**Round 2 — internal critic delta (2026-10-09).** Verdict: **GO-WITH-AMENDMENTS**;
5 findings, all adopted; the substantive one is the approval-absent fallback
redesign: `PreToolDecision` carries no `additionalContexts` field
(`tool-types.ts:304-308`), so the fallback is now `{kind:'allow'}` at
pre-execute plus direct `agent.inject` of the advice with source kind
`'retry-attendant'` (register-events.ts:114-115 precedent), with an
ordering-sanity pin test in §5. Other adopted findings: §3.3 leftover
parenthetical replaced with a pointer to §3.4 fold semantics; clear-rule (b)
grammar fixed (git/status etc. are second tokens); §5 gate name corrected to
`check:size`; §5.1 contract test pins the `old_string was not found in`
anchor.

**Round 3 — fresh adversarial critic pass (2026-10-09), orchestrator-verified
against the linked harness tree.** Verdict: **GO-WITH-AMENDMENTS**; 8 findings,
7 adopted as v4 amendments, F7 kept as implementation-pinned. Headline changes:
- **F1 (WRONG, HIGH)** — the v3 M1 trigger (`isError` + error-message text)
  never fires for the flagship `bash-timeout` class: timeouts are success-shaped
  (`promoteOnTimeout` default true → `{kind:'promoted',jobId,...}`, or
  `foreground` + `timedOut:true` + `[timed out after …]` marker; persistent-bash
  `[Command timed out or OOM]`). Sandbox denial likewise lands as success-value
  `sandbox.denied` / `[sandbox: …]` notice text, not a thrown error.
  Orchestrator re-verify: `tool-bash/src/index.ts:58,214,332-345,351-358`,
  `render.ts:53,106-117` — all confirmed. Disposition: class table rewritten to
  name success-value fields first with marker-text fallback; §1 probe facts,
  §2 goal 1 ("ambiguous outcome", not "failure"), §5.1 fixture requirements
  updated; `agent.inject`/`runtime-types` anchors added.
- **F2 (DESIGN, HIGH)** — clear-rule (b) ("any successful read/glob/grep
  clears") was unsound both directions (unrelated read unblocks blind retry;
  check showing the effect *did* apply also unblocked the duplicate). v4: (b)
  narrowed to class-designated checks and changed semantics to
  `resolved:true` → the retry is escalated *harder* (reason names the check),
  never cleared; only same-digest non-ambiguous success fully clears.
  Designated checks: git status/log/diff/show (git class), same-path `read`
  (write-partial); none for the two bash-generic and pkg classes.
- **F3 (WRONG, MEDIUM)** — `source:{kind:'plugin'}` is not a real source kind
  (`MessageSourceMap` has no catch-all; comment at
  harness `packages/llm/llm/src/message.ts:103-111`). v4 declares
  `'retry-attendant'` via module augmentation (recovery-wiring.ts:18-24
  pattern) in §3.2 sketch, §2/§4 fallback, and §5.2 assertion.
- **F4 (DESIGN, MEDIUM)** — permission-rules' auto-allow returns without
  delegating (`pre-execute.ts:287-313`), so a later-registered pre-execute
  listener would never run and M2 would silently never fire under the default
  `auto` permission mode. v4 pins `prepend:true` on the pre-execute listener
  (agent.cordis.yml:416 precedent) plus a §5.4 composition-level guard test.
- **F5 (UNCLEAR, LOW)** — per-session keying unspecified. v4: keyed by
  `exec.agent?.session.header.id` (turn-rules `wiring.ts:240` precedent);
  agent-less executions skip M2. Adopted.
- **F6 (UNCLEAR→RESOLVED, LOW)** — FS_AMBIGUOUS_EDIT hedge was stale:
  `fs-local/fsio.ts:831` + `FsError extends HarnessError`
  (`fs/src/types.ts:196`) confirm `error.info.code` propagation. Hedge replaced
  with confirmed anchors in §3.2 and a §5.1 exclusion fixture.
- **F7 (UNCLEAR, LOW)** — pre-execute inject vs post-result FIFO ordering not
  determinable from code; remains an implementation-time pin test (§5.3).
  Accepted as-is.
- **F8 (DESIGN, LOW)** — `mcp-mutation`'s trigger fires on every MCP failure
  including read-only retries; under M2 that would dominate escalation telemetry
  with harmless asks. v4 makes `mcp-mutation` M1-only (§3.2 row, §3.3 gate,
  §4 fatigue bullet, §7.1 future unlock via read-only annotations).

Anchors re-verified clean in round 3 (no change): tool result union
(:269-293), pre-execute exec shape (:120-129), ask decision shape (:304-308),
additionalContexts fold (`runtime-results.ts:52-90`), serviceAsk-denial path
(`runtime-execute.ts:159-175`), MCP plain-Error failures
(`mcp-client/tools.ts:420,436-437`), hook fold semantics
(`register-events.ts:110-127`), hint.ts anchors, shell-words anchors,
listDigest precedent, hook-protocol module augmentation, preset/composition
registration shape, interaction→interaction test-dependency precedent
(advisor-watchdog), `engine.*` manifest category.

**Round 4 — critic delta on v4 (2026-10-09, send_message continuation of the
round-3 seat).** Verdict: **GO** with D1–D3 folded before implementation;
nothing NO-GO-level. All 8 round-3 folds verified present and faithful in the
v4 text; all four marker strings (`[timed out after`, `[Command timed out or
OOM]`, `[sandbox: file access denied`, `[sandbox: the sandbox runner itself
failed`) grep-verified verbatim against `tool-bash/src/render.ts:53,106-117`,
`tool-bash/src/index.ts:97,182-185`, and
`tool-bash-persistent/src/index.ts:21,355-359`. Two-branch trigger internals
judged coherent (success `value` is visible to post-execute; bash output-schema
oneOf at tool-bash/src/index.ts:426-470; `exitCode:null` conservative match
accepted; promoted-job M2 Set coheres with clear-rule (a)'s no-retrigger
clause). Folded:
- **D1 (DESIGN/UNCLEAR, MEDIUM)** — two `prepend:true` listeners
  (hooks-claude-code at `agent.cordis.yml:416-418` and retry-attendant) have
  unpinned relative order and unpinned delegation discipline, and either
  mistake silently voids §3.4 ("user hook allow/ask wins over plugin ask").
  v4 now specifies delegate-first fold semantics for the pre-execute listener
  (pass downstream deny/cancel through unchanged; our ask overrides
  allow/ask/passthrough), pins "hooks-claude-code stays outer,
  retry-attendant inner" as the order contract, and extends §5.4 from one
  permission-stub test to three live-fold composition tests — including one
  that derives the relative prepend order from observed fold outcomes rather
  than from `agent.cordis.yml` row positions.
- **D2 (DESIGN, LOW)** — resolved-retry ask reason was one-sided ("your check
  may have shown the effect already applied"), misleading whenever the check
  showed the opposite. Reason text switched to neutral wording in both §3.3
  locations ("a check ran in between — confirm the effect state").
- **D3 (WRONG-minor, LOW)** — "approval service absent at registration" was a
  latch misconception: `serviceAsk` itself looks up `ctx.get('approval')`
  per call (harness `runtime-code.ts:144-158`), and a registration-time latch
  would deny asks to a session that composes approval later. §2 and §4 now
  specify per-escalation detection.

Residual implementation-pinned unknowns (accepted, listed for the implementer):
the cordis prepend relative order among same-priority listeners (asserted by
§5.4 test, not assumed); exact `sandboxDenialMarker` wording lives in
`dsh-sandbox` and is pinned by a fixture assert (documented wording at
`tool-bash/src/index.ts:97`); pre-execute inject vs post-result FIFO ordering
(§5.3 pin test).

**Round 4 confirmation (2026-10-09, same critic seat).** Verdict: **CONFIRM** —
the D1–D3 folds carry the intended pins (fold direction in §3.3, mechanism in
§5.4(b), derived order in §5.4(c)); the override set {allow, ask, passthrough →
our ask; deny/cancel pass through} is correct per `register-events.ts:123-124`
semantics; the ledger matches the reviewer's own citations (no
misattribution). One optional polish adopted: the §3.3 pseudocode now shows
the non-escalation path (`return downstream` when no live entry matches) so
"delegate-first" cannot be read as escalation-only.

**Round 5 — codex external blind review (2026-10-09, canonical bridge lane,
65k tokens).** Verdict: **GO-WITH-AMENDMENTS**; 6 findings (2 HIGH, 3 MEDIUM,
1 LOW), all orchestrator-verified then folded into v5:
- **C1 (HIGH)** — the approval-absent fallback as written could erase an
  existing permission requirement: permission-rules can return a downstream
  `ask` independently (`pre-execute.ts:312`) and core intentionally denies it
  when approval is unavailable (`runtime-code.ts:149`); v4's fallback would
  have overridden it with `allow`. v5: fallback preserves the downstream
  decision (deny/cancel/ask pass through; allow-override only over
  downstream allow/passthrough), and a downstream-ask override under
  available approval COMBINES reasons. Folded in §2 and §4.
- **C2 (HIGH)** — `bash-sandbox-denied` guidance "blocked this before
  dispatch" was unsupported: the denial marker covers a kernel refusing a
  file effect mid-run (`escalation.ts:63-71`), and only `runnerFailed` means
  "command did not run" (`render.ts:110`). v5: guidance rewritten to the
  two-case neutral form. §3.2.
- **C3 (MEDIUM)** — hook-fold traversal narration was inverted and §5.4(b)'s
  self-authored stub could not prove production registration order. v5:
  traversal corrected (hooks → retry-attendant → permission, unwind on
  return), §5.4(b) upgraded to mount the REAL hooks bridge. §3.3 Act (a).
- **C4 (MEDIUM)** — exclusion biconditional false (convergent with grok G6).
- **C5 (MEDIUM)** — "one ask per session" needed attempt-lifetime precision
  (convergent with grok G2). Folded as §3.3 attempt-semantics block.
- **C6 (LOW)** — citation refresh: promoted schema :416-425 (foreground arm
  :426+), `sandbox_permissions` :395-405, `serviceAsk` lives in the dsh-cc
  core/tools fork (not the harness tree), §1 digest-precedent wording made
  consistent with §3.3, promotion qualified by background-registry
  availability. All folded in §1.
Codex explicitly confirmed the two-branch timeout thesis, the delegate-first
fold shape, FS_AMBIGUOUS_EDIT propagation, MessageSourceMap augmentation, and
session-identity keying.

**Round 6 — grok external blind review (2026-10-09, canonical bridge lane,
39 turns).** Verdict: **GO-WITH-AMENDMENTS**; 14 findings (3 HIGH, 6 MEDIUM,
5 LOW) plus four open questions, all orchestrator-verified (cordis unshift,
inject/inbox order, win32 pwsh preset, hint anchors re-checked against source)
then folded into v5:
- **G1 (HIGH)** — full-arguments digest misses ordinary bash retries:
  `description` is a required model-written parameter, so a reworded retry is
  a different digest. v5: digest over effect fields only (`{command,
  workdir}` for bash/pwsh, etc.); §1 precedent note rewritten as a deliberate
  divergence. §3.3.
- **G2 (HIGH)** — one ask ≠ one execution: a rejection spends the v4 latch
  and the NEXT identical retry passes silently; sibling identical calls can
  both observe `escalated !== true`. v5: attempt-semantics block —
  synchronous `askInFlight` CAS before `await next()`, latch consumed only
  on allowed-once, rejection keeps asking (convergent with codex C5).
  §3.3 Bounded.
- **G3 (HIGH)** — prepend order is settled, not unknown: cordis `prepend` is
  `unshift` and later prepend is outermost (`vendor/cordis/src/events.ts:255`,
  `:234-242`); the advisor-watchdog tail position would put retry-attendant
  OUTSIDE hooks and clobber the hook allow. v5: row must be placed BEFORE
  the hooks-claude-code row; pinned by YAML row-index assert + live fold test
  with the real bridge (convergent with codex C3). §3.3 Act (a), §5.4-5.5.
- **G4 (MEDIUM)** — `exitCode !== 0` matched `null` (preparation timeout),
  overlapping bash-timeout and git-mutation with conflicting designated
  checks. v5: numeric-exit guard + first-match precedence, one class stored.
  §3.2.
- **G5 (MEDIUM)** — promoted-schema citation pointed at the foreground arm;
  promoted text marker is `[still running after …]` (`render.ts:77-83`).
  Folded in §1 and §3.2 (marker list).
- **G6 (MEDIUM)** — exclusion biconditional unimplementable; union spec +
  one-way test (convergent with codex C4). §3.2, §5.1.
- **G7 (MEDIUM)** — §3.2 (append on every match) vs §4 (per fresh digest)
  contradiction: v5 specifies fresh-digest dedup in §3.2.
- **G8 (MEDIUM)** — two settings spellings (`retry-attendant.enabled` vs
  `retryAttendant.enabled`): v5 standardizes on kebab `retry-attendant.*`.
  §3.5.
- **G9 (MEDIUM)** — the Windows preset runs `pwsh`, not `bash`
  (`agent.cordis.yml:58-64`); pwsh shares promotion default and timeout
  marker (`tool-pwsh/src/index.ts:69,75,218`, `render.ts:73`). v5: class
  table trigger `tool ∈ {bash, pwsh}`. §3.2.
- **G10 (MEDIUM)** — "stale-conflict stays with post-edit-verify" was false
  (that package handles no stale class; `FS_STALE_VERSION` edits write
  nothing). v5: stale added to the no-write exclusion; ownership sentence
  corrected. §2 non-goals, §3.2.
- **G11 (MEDIUM)** — clear (a) cross-class hole: same-digest result matching
  a different ambiguous class must not clear. v5: clear only when the new
  success matches no ambiguous class. §3.3.
- **G12 (LOW)** — persistent-bash `value` is a string; unguarded `value.kind`
  under the swallow rule skips the text fallback. v5: type-guard note. §3.2.
- **G13 (LOW)** — mcp-mutation M1-only accepted with named hole (§7 unlock).
  Unchanged.
- **G14 (LOW)** — child sessions don't share the map: declared intentional.
  §3.3.
- **Three "implementation-pinned unknowns" settled by grok and verified by
  the orchestrator**: (1) cordis prepend order — `unshift` at
  `events.ts:255`, later prepend outermost; the §5.4(c) "derive from stubs"
  commitment replaced by the row-index pin. (2) `sandboxDenialMarker` exact
  wording at `escalation.ts:71-72` (fixture assert is a drift alarm, not a
  discovery task). (3) inject-vs-FIFO order — inject appends to the next-step
  inbox without waking (`agent.ts:171-172`), additionalContexts append at
  result commit (`agent.ts:534-536`, `tool-calls.ts:157`), inbox claimed at
  next `preStep` (`agent.ts:316`); expected order written down in §1 and
  §5.3 as a regression lock. Grok's four open questions (digest fields,
  multi-class match, clear-(a) meaning, pwsh scope) are each answered in the
  v5 text (§3.3 digest projection, §3.2 precedence block, §3.3 clear rule,
  §3.2 tool set).

**Round 5 delta — codex confirmation on v5 (2026-10-09, `--last` thread).**
Verdict: **C1 CONFIRM; C5 refined once more.** The C1 preserve-downstream
fold matches the intended disposition. Two further real issues on the
attempt-semantics block, both folded (v5.1):
- The v5 sibling rule ("second sibling sees the bit and passes through")
  closed only the duplicate-*ask* race, not the duplicate-*execution* race:
  the sibling would run while the first ask was still pending — even if
  subsequently rejected.
- `await next()` cannot observe approval outcomes at all: approval resolves
  AFTER the waterfall returns (`runtime-execute.ts:169` → `serviceAsk` at
  `runtime-code.ts:173`), so the latch consumption needed a concrete
  observation seam. Folded: resolution tracking via post-execute of the same
  `callId` (dispatch ⇒ consume; serviceAsk rejection family ⇒ release,
  entry stays live; every other terminal path ⇒ synchronous release; expiry
  sweep as wedge safety; never inferring approval from the tool's own
  success/failure).
codex's proposed sibling remedy (await-the-pending-resolution-then-reevaluate)
was **not** adopted as-is — see the cross-seat adjudication note below.

**Round 6 delta — grok confirmation on v5 (2026-10-09, `--last` thread).**
Verdict: **G2/G3 folds confirmed; the sibling clause was the sole NO-GO**;
fold it and this seat is CONFIRM. Grok independently flagged the same
execution-level race codex did (pass-through returns a non-delegating auto
allow, `pre-execute.ts:310`) and prescribed a different remedy: block the
sibling's execution outright rather than let it await. Grok also confirmed
the G3 triple (row placement + row-index pin + real-bridge live test) as
satisfying the finding.

**Cross-seat adjudication (v5.1, recorded per review discipline):** both
seats agreed the sibling must not execute while an identical ask is pending;
they diverged on the remedy — codex: await the pending resolution then
re-evaluate; grok: cancel/deny the sibling immediately. **grok's shape is
adopted**: blocking a tool-decision listener on human contemplation time has
no repo precedent, holds a tool-call slot for the approval duration, and
adds signal/TTL race complexity; a deny-with-reason gives the model immediate
actionable feedback (re-issue after the first settles). The carrier is
`deny`, not grok's literal `cancel`: `{kind:'cancel'}` is a bare union member
with no reason field (`tool-types.ts:307`), while deny carries the
model-visible explainer. codex's resolution-tracking seam is retained
wholesale. The fold is in §3.3 (sibling bullet + Act pseudocode) and §5.3
(the sibling test asserts non-execution, not ask count).

**Round 5 adjudication round (codex micro-confirm on v5.1).** Verdict:
**deny-shape CONFIRM; one final fix on resolution tracking.** codex
confirmed the sibling-blocking shape ("repeated denials cannot execute the
duplicate while the latch remains held") and closed the divergence. The
final fix, folded as v5.2: "post-execute result is not a rejection" does
NOT imply dispatch — guard denials and pre-dispatch cancellations also
reach post-execute as error results (`runtime-execute.ts:183,198`). The
seam is replaced by positive dispatch evidence: the owning execution
reaching the `tools/execute` waterfall (declared seam
`packages/core/tools/src/index.ts:133`, entered only via the
`{kind:'dispatch'}` next at `runtime-execute.ts:201`), plus terminal
release on the owning execution's `tools/result` emit (`index.ts:167`),
which fires on every terminal path including the final-result bypass
(`runtime-execute.ts:202`); a denied sibling neither releases nor consumes
a reservation it never owned. Orchestrator verified both seams against
source before folding.
