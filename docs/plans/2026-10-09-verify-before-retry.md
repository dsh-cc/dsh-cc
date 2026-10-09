# Verify-before-retry for mutating tool calls (design)

- Date: 2026-10-09
- Status: draft v3 — internal critic GO after 3 rounds; user sign-off pending. NOT yet implemented.
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

Probe-verified facts (2026-10-09, this worktree):

- Tool results are a discriminated union
  `ToolExecutionSuccess | ToolExecutionFailure`
  (`packages/core/tools/src/tool-types.ts:269-293`); the failure branch is
  `{ isError:true, error: { message, info?: { name, code, reason? } }, content }`.
  `error.info.code` exists only when the tool threw a `HarnessError`
  (`packages/core/tools/src/abort-utils.ts:28-34,102-124`); plain `Error`
  failures — including all MCP bridge failures
  (`packages/mcp/mcp-client/src/tools.ts:420,436-437`) — carry no code. Bash
  timeout has no structured marker either: failure classes below are therefore
  **text-signal based**, and the doc says so openly.
- `tools/pre-execute` exposes the full parsed `exec.arguments` pre-dispatch
  (`packages/core/tools/src/index.ts:122`,
  `packages/core/tools/src/tool-types.ts:120-129`).
- `tools/post-execute` decisions can append non-destructive
  `additionalContexts` (type: `packages/core/tools/src/tool-types.ts:314-317`; runtime fold merges them:
  `packages/core/tools/src/runtime-results.ts:52-90`; producer precedent:
  `packages/interaction/post-edit-verify/src/recovery-wiring.ts:85`,
  `packages/interaction/turn-rules/src/wiring.ts:218,252`).
- No per-call input digest / idempotency index exists anywhere in `core/tools`
  (probe: ABSENT). Nearest existing digests are the permission classifier's
  verdict-cache keys
  (`packages/interaction/permission-rules/src/llm-classifier.ts:147-161`) —
  the precedent is sha256 truncation over joined strings (`listDigest` over a
  slot list), not stable-json of objects; we follow the joined-strings form.

## 2. Goals and non-goals

Goals:

1. **M1 — failure-time postcondition guidance.** When a configured mutating tool
   call fails, append a short, per-class "check before retry" guidance block via
   `additionalContexts` so the very next model turn sees it.
2. **M2 — retry dedup escalation.** If the agent re-dispatches the identical
   mutating call (same tool, same args digest) while its failure is still
   "unresolved" (no intervening successful check), escalate that one call to
   `ask` with a reason naming the earlier failure. **Approval-absent
   fallback:** when the approval service is absent at registration
   (`serviceAsk` missing), M2 returns `{kind:'allow'}` at pre-execute and
   delivers the M1-style advice by direct injection instead:
   `exec.agent?.inject(createUserMessage({ content:[{type:'text',text}],
   source:{ kind:'retry-attendant' } }))` — hook-context precedent
   `packages/hooks/hooks-claude-code/src/register-events.ts:114-115`
   (injection from the tool-decision path). `ask` without an approval service
   is a denial in core (`packages/core/tools/src/runtime-execute.ts:173-175`,
   the `serviceAsk` path); denial is the wrong failure direction here —
   allow + injected guidance is. Note: the ordering of an inject issued at
   pre-execute relative to the post-result FIFO must be sanity-checked at
   implementation (pin test in §5).

Non-goals:

- **Edit/write file-content recovery** — already owned by `post-edit-verify`
  (edit-recovery-hint merged into it, PR #189). This package explicitly does not
  register guidance for `edit` `old_string`-not-found; one owner per hint.
  (Stale-conflict class for edits remains post-edit-verify's domain.)
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
`packages/preset/cc/agent.cordis.yml` (advisor-watchdog row shape);
composition pin in `packages/preset/cc/tests/composition.spec.ts`; capability
manifest `engine.*` row in `docs/claude-code-capabilities.yaml` regenerated
via `pnpm docs:parity`; package README trio. All active behavior defaults
OFF (`retry-attendant.enabled`, §3.5).

### 3.2 M1 — failure-time guidance

Post-execute listener (default priority, NOT prepend — content augmentation
after crushers is fine; ordering asserted by composition test, §5):

On `result.isError === true` for a configured tool class, append:

```jsonc
// additionalContexts entry, source-marked
{ "role": "user",
  "content": [{ "type": "text",
    "text": "[retry-attendant] <class-specific guidance; one line, ≤ 200 chars>" }],
  "source": { "kind": "plugin" } }
```

Failure-class table (data file `classes.json`, unit-tested):

| class | trigger (tool + text signal on `error.message`/result text) | guidance content |
|---|---|---|
| `bash-timeout` | `tool:"bash"` AND message matches `timed out|timeout|ETIMEDOUT` (case-insens.) | "The command may have partially applied before timing out. Verify the intended postcondition (e.g. re-check files/processes) before re-running it." |
| `bash-sandbox-denied` | `tool:"bash"` AND message matches `sandbox|operation not permitted|EPERM` | "The sandbox blocked this before dispatch. Do not retry identically; escalate permissions or change approach." |
| `git-mutation` | `tool:"bash"` AND first token `git` AND subcommand ∈ {commit, push, reset, rebase, merge, cherry-pick, am, checkout, switch} | "Git mutations are not atomic with respect to retries. Run a read-only `git status`/`git log` check first." |
| `pkg-install` | `tool:"bash"` AND command head matches `pnpm/npm/yarn/bun (install|add|remove)` | "Package installs mutate node_modules progressively. Check `node_modules`/lockfile state before re-running; a partial install is usually resumable." |
| `mcp-mutation` | `tool` prefixed `mcp__` AND failure | "If this call mutated remote state, verify before retrying; read-only calls can be retried freely." (read-safe text: noise for read-only MCP tools is accepted) |
| `write-partial` | `tool:"write"|"edit"` (only failures NOT covered by post-edit-verify's hint set: specifically exclude `error?.info?.code === 'FS_AMBIGUOUS_EDIT'` — the structured `error.info.code` value, NOT a message substring; note: FS_AMBIGUOUS_EDIT propagation to post-execute results is upstream-unverifiable in this worktree and must be re-confirmed at implementation time — and keep the `old_string was not found in` message check for the other hint) | "The write may be partial. Read the target path before retrying." |

First-token/head extraction: reuse the same minimal parse style as
`packages/interaction/permission-rules/src/shell-words.ts` (`firstShellToken` :25,
`stripLeadingAssignments` :11) but implemented locally — **do not import
permission-rules internals** (package boundary; duplication of ~30 lines is
accepted deliberately).

Fragility note (written into the doc and the data file): text signals can drift
with harness wording. Mitigation: each class's pattern is exercised against
fixture shapes in unit tests, and an integration note lists the exact upstream
construction points (`packages/core/tools/src/abort-utils.ts:116-124`) so wording drift is a
grep-detectable maintenance task.

### 3.3 M2 — retry dedup escalation

Per-session in-memory map (NOT disk — the state is deliberately ephemeral; a
retry after a session restart is a human-supervised decision anyway):

```
key = sha256(stableJson({tool: exec.name, args: exec.arguments}))[:16]
value = { failedAt, class, failureMessageHead }
```

- **Set** on post-execute failure of a configured class (M1 listener writes it —
  one listener serves both mechanisms), **only when the key is absent or
  expired**; never reset an `escalated:true` entry.
- **Clear** the key (and only that key) ONLY on:
  (a) post-execute success of the **same digest**, or
  (b) success of an **explicit read-only check class** — bash whose
  first token is `git` AND second token ∈ {status, log, diff, show}
  (they are second tokens, not first), or the `read`/`glob`/`grep` tools.
  A successful but non-check mutating call clears nothing — conservative
  direction (residual hole documented: may escalate after an already-checked
  state; accepted).
  Also expire entries after 10 minutes. **Digest-fragility disclosure:**
  identical logical retries with different timestamp/temp-path args never
  digest-match → silent false negatives; accepted.
- **Act** at `tools/pre-execute`: if the incoming call's key matches a live
  entry, return an `ask` verdict —
  `{ kind:'ask'; reason?: string; displayReason?: { en: string; [locale:string]: string } }`
  (`packages/core/tools/src/tool-types.ts:304-308`; `reason` is optional there,
  but we always set it) — naming the earlier failure and class ("identical
  retry of <tool> after <class> failure at <time>; user confirmation
  requested"). The pre-execute decision union and its `ask` kind are the
  existing core gate fold (`packages/core/tools/src/runtime-execute.ts:169-197` is the fold site to pin in implementation; fold semantics pinned in §3.4).

Bounded: at most one escalation per key per session (after one ask, the entry is
marked `escalated:true`; a second identical retry passes through — the user has
already been consulted once).

### 3.4 Interplay rules (normative)

- M2 never fires for tools outside the class table.
- **Hook precedence:** a user PreToolUse hook returning `allow` or `ask`
  overrides retry-attendant's downstream `ask` (fold semantics at
  `packages/hooks/hooks-claude-code/src/register-events.ts:110-127`; `allow`
  maps unconditionally after `next()`). Accepted contract: **downstream deny
  wins; user hook allow/ask wins over plugin ask.**
- M1 guidance is additive only (`additionalContexts`); this package never
  rewrites result content and never blocks.
- If `post-edit-verify` produced guidance for the same failure, M1 for
  `write-partial` still fires only on its exclusion rule; the exclusion patterns
  are pinned by a contract test against post-edit-verify's hint triggers
  (`packages/interaction/post-edit-verify/src/hint.ts:24-29,35,46-55`) so a hint
  widening over there fails our test here (call it out in code comment both
  directions).

### 3.5 Configuration

- `retryAttendant.enabled` (default `false`, dogfood-first).
- `retryAttendant.guidance` (default `true` when enabled) — M1.
- `retryAttendant.escalate` (default `true` when enabled) — M2.
- `retryAttendant.expireMinutes` (default `10`).

### 3.6 Transcript visibility

On escalation and on each fresh failure-with-guidance, append
`session.append('retry-attendant/event', {kind:'guidance'|'escalation', class,
tool, digest, ts})` when `exec.agent?.session` is reachable (module augmentation
pattern: `packages/hooks/hook-protocol/src/types.ts:8-9`). All listener errors
degrade to silent passthrough (CCR hot-path rule).

## 4. Failure modes and mitigations

- **retry-attendant must never break a tool call**: swallow + debug-log only.
- **escalation fatigue**: bounded per key; user can deny → their denial is a
  normal permission decision, and the `escalated` mark prevents re-asking.
- **cross-session staleness**: none (in-memory only).
- **approval service absent**: M2's `ask` would become a hard denial in core
  (`packages/core/tools/src/runtime-execute.ts:173-175`, `serviceAsk` path);
  therefore when the approval service is absent at registration (`serviceAsk`
  missing), M2 returns `{kind:'allow'}` and delivers the advice via
  `exec.agent?.inject(createUserMessage({ content:[{type:'text',text}],
  source:{ kind:'retry-attendant' } }))` (precedent
  `packages/hooks/hooks-claude-code/src/register-events.ts:114-115`) —
  stated explicitly in §2. Note: `PreToolDecision` carries no
  `additionalContexts` field (`tool-types.ts:304-308`), so a pre-execute
  advice channel must be inject, not context-append.
- **false class detection**: worst case is a guidance line or a single ask;
  both tolerable.

## 5. Verification plan

Unit tests (vitest, package-internal):

1. Class table: fixture failures → expected class or none; write-partial
   exclusion asserted against the real exported `isRecoveryCandidate`
   imported from `@dsh-cc/post-edit-verify`
   (`packages/interaction/post-edit-verify/src/hint.ts:39` exports it):
   exclusion ⟺ `isRecoveryCandidate` over shared fixtures (no copied strings);
   the contract test additionally pins the `old_string was not found in`
   message anchor (`packages/interaction/post-edit-verify/src/hint.ts:26-27`
   idiom) so upstream wording drift fails CI on this side too.
2. M1: failing bash timeout ⇒ result carries additionalContexts; success ⇒ none;
   downstream `additionalContexts` from other listeners are preserved (spread
   precedent: context-crusher `packages/context/context-crusher/src/index.ts:251-257`).
3. M2: fail→same-args call ⇒ ask with reason; fail→different-args ⇒ passthrough;
   fail→intervening read-only check (git status / read / glob / grep) ⇒ cleared,
   passthrough; intervening non-check success ⇒ still escalates (conservative);
   expiry ⇒ passthrough; `escalated:true` entry never reset by a new failure;
   approval service absent ⇒ `{kind:'allow'}` + inject fallback (no ask), and
   the pre-execute-inject vs post-result FIFO ordering pin (§2).
4. Waterfall discipline: forced internal throw ⇒ passthrough, log written.
5. Preset composition pin updated in `packages/preset/cc/tests/composition.spec.ts`
   (preset row in `packages/preset/cc/agent.cordis.yml`, cc-services group);
   `pnpm check:capabilities` + README trio + `check:size` green;
   capability manifest row in `docs/claude-code-capabilities.yaml` regenerated
   via `pnpm docs:parity`.

Dogfood: enable in user layer on the dsh-cc repo; collect
`retry-attendant/event` rows for a week; expected observable: escalation fires
only on genuine identical retries (manual check of first 20).

## 6. Falsification / metrics

Dogfood metrics from session events: count of escalations, overrides (user
denied the ask), and post-guidance behavior change (did the next tool call check
before mutating — approximated by a `read`-class call preceding the retry).
If guidance shows no measurable behavior change after dogfood, M1 is removed and
M2 kept or removed by the same evidence. (A11 discipline: this section is the
do-nothing baseline commitment.)

## 7. Follow-ups

1. Protocol-level idempotency for MCP mutations (server-provided idempotency
   keys; blocked on protocol support — out of dsh-cc's control surface).
2. Harness ask: structured `error.info.code` for bash timeout/sandbox classes so
   text matching can be retired (upstream proposal).
3. Postcondition *execution* (runtime runs the check) for a whitelist of
   declarative postconditions — requires the sealed-eval discipline, not before.

## 8. Review ledger

(filled per review round — verdict, findings, dispositions with in-text anchors)

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
