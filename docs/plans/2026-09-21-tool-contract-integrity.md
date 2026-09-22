# Tool-Contract Integrity: pipeline normalization seam, approval decision liveness, layered failure taxonomy

Date: 2026-09-21. Status: **Proposed (mostly upstream proposals; one rescoped dsh-cc-side
watchdog)**. Origin: ZCode design borrow analysis (zai-org/ZCode @ 872ad960) — the
general borrowables list, not the GLM-effective list. Design-review record: first draft
**amended** in cold review — the watchdog criterion as drafted could not tell an
ownerless dialog from a slow human, it overstated how wedged a dsh-cc hook can get (the
hook runner already bounds wedged hooks at a 600s timeout with a graceful no-decision
degrade), and the failure-taxonomy item missed a partial seam that already exists.
Corrected below; anchors re-verified 2026-09-21. Round 3 (2026-09-21, cold re-review
against HEAD f81883d + harness 1ef9c1fa): **CONFIRM, no blocking findings** — all
reachable anchors retraced; five wording/anchor fixes baked in (`approval/policy`
acknowledged alongside asked/decided, firehose/merge line anchors re-pinned, the
watchdog's arming signal made explicit as `tool/call`, and the ZCode anchor block
relabeled secondhand). None of the items are already shipped at HEAD. Round 4
(2026-09-21, ZCode checkout at 872ad96): all ZCode anchors verified against source —
one BLOCKING mis-attribution fixed (the "hooks narrow, never widen" rule actually
belongs to `prepareApproval` only; PreToolUse hook `allow` can auto-approve an
ordinary ask — `hook-flow.ts:209-218`), one package path corrected
(`workflow-model-failure-policy.ts` lives in `adapters/src/model/`, not
`dynamic-workflow`), and the secondhand label retired.

## 1. Problem

Three integrity properties are currently held by convention rather than structure:

1. **Approved-input identity.** The approval surface shows the model's raw tool input;
   the handler resolves paths/defaults afterwards — what runs is not string-wise what
   was approved. ZCode makes the normalized form the single object that hooks,
   permission rules, approval UI, and handler all read.
2. **Approval decision liveness.** An open approval dialog whose owner vanished (UI died
   after the request) is, from every event dsh-cc can observe, indistinguishable from a
   human reading a diff. Today nothing bounds that state or even names it in the log.
3. **Failure taxonomy depth.** Retryable-vs-terminal exists as a partial seam
   (per-provider `retryableCodes` at adapter registration, plus quota-terminal regexes);
   ZCode keeps deliberate provider business-code tables (retryable vs terminal) and a
   structured stop-kind layer above them.

## 2. Current state (negative claims re-verified by review)

**harness (read-only checkout):**

- Tool execution pipeline: pre-execute waterfall → serviceAsk → guards → dispatch; tools
  validate their *own* schema at body time — there is **no central `validateInput`
  point** (`packages/core/tools/src/index.ts:258-264, :315`) and no
  `resolveInput`/`prepareApproval` anywhere in the tree (exhaustive grep, both
  checkouts). Consequence for item 1: the proposal must say where validation moves (see
  §3), or the seam is unanchorable.
- Approval observability for bridges is exactly two decision-observability events:
  `approval/asked` (appended at broker request time,
  `packages/interaction/user-approval/src/index.ts:217`) and `approval/decided` (:224)
  (`approval/policy` also exists at :96 but carries mode changes only); the
  dsh-cc bridge consumes them in a detached observe-only firehose
  (dsh-cc `packages/hooks/hooks-claude-code/src/register-events.ts:253-266`; the
  approval/request handler sits at :242-251).
  Broker-side outcomes at `packages/core/tools/src/index.ts:1698-1714` are terminal
  only if the broker itself returns — a hung broker is the real residual gap, not a
  hung hook.
- Partial taxonomy seam exists: `retryableCodes` are per-route config on the retry
  policy (`packages/llm/llm/src/retry-policy.ts:36-44, :173`) and
  `isQuotaExceededError` regexes cover terminal quota wording
  (`packages/llm/llm/src/error.ts:92-97`). ZCode-shaped static per-provider code tables
  (retryable vs terminal split by business code) do not exist — the proposal is to
  extend the seam, not create one.

**dsh-cc side (this worktree):**

- A wedged PermissionRequest *hook* is already bounded: the hook runner enforces
  `DEFAULT_HOOK_TIMEOUT_MS = 600_000` with per-hook `timeoutSec` override
  (`packages/hooks/hook-protocol/src/runner.ts:20, :74`), infrastructure faults return a
  non-blocking no-decision (`runner.ts:98-106`), and the merge folds that to
  `decision:'none'` → `next()` → broker (`hook-protocol/src/merge.ts:104`,
  `register-events.ts:242-251`). The "hook infra failure = abstain" rule ZCode was
  credited with **already exists here**.
- The PR #117/#123 classifier circuit breaker guards classifier availability/failure
  streaks with its own `timeoutMs` and failure kinds
  (`packages/interaction/permission-rules/src/llm-classifier.ts:23-25, 54-57`). Different
  failure domain from decision-transport liveness: complementary, never merge them.

**ZCode anchors (re-verified against zai-org/ZCode @ 872ad960; paths relative to
`apps/zcode-cli/packages/`):** `core/src/tool/types.ts:300-370` (`resolveInput` :322,
`prepareApproval` :349; approval may resolve ask→proceed, never allow→ask),
`core/src/tool/executor/approval-gate.ts`,
`core/src/tool/executor/permission-responder-race.ts` (hook-vs-broker race, first
valid decision wins, loser aborted; a hook *infrastructure* failure abstains rather
than deciding), `adapters/src/model/failure-provider-business-codes.ts`
(retryable-vs-terminal business-code tables), `adapters/src/model/workflow-model-failure-policy.ts`
(the workflow runner's stop-policy table). PreToolUse hook bounds enforced at
`core/src/tool/executor/hook-flow.ts:195-226`.

## 3. Design

1. **Upstream proposal — pipeline normalization seam.** The harness pipeline currently
   owns no central validation/normalization point; the proposal adds a pipeline-delta
   section: schema validation moves (or is duplicated) to pre-execute, and a
   tool-declared `resolveInput` produces the execution-fact input consumed identically
   by hooks, permission matching, approval rendering, and the handler. Includes ZCode's
   structural rules, restated to match the code: PreToolUse hooks are bounded by two
   invariants — `deny` is never flipped, and a tool-declared `alwaysAsk` confirmation
   survives hook `allow` — but an ordinary `ask` **can** be auto-allowed by a hook
   (`hook-flow.ts:209-218`); single-direction narrowing applies to the approval side
   only: `prepareApproval` runs after the permission service has already decided `ask`
   and may only resolve ask→proceed or attach a preview, never turn allow into ask.
2. **Upstream proposal — decision liveness, not hook races.** Rescoped per review: the
   hook side is already bounded (§2). The proposal asks the broker for a **liveness
   signal** (heartbeat/ack appended while a dialog is open and owned) so that
   "asked-no-decided with no liveness" (ownerless) becomes distinguishable from
   "asked-no-decided with liveness" (slow human). A PermissionRequest hook answering
   concurrently with the broker — first valid decision wins, loser aborted, and a hook
   infra failure abstains rather than deciding — rides the
   same proposal as the mechanism for hook-answer delivery.
3. **Upstream proposal — extend the taxonomy seam.** Generalize the existing
   per-route `retryableCodes` into two explicit tables (retryable vs terminal business
   codes) read by retry policy; the quota regexes stay as the generic fallback. Fuels
   the cost-gate and admission work without centralizing provider knowledge into the
   core.
4. **dsh-cc-side watchdog (ships without upstream), honestly scoped.** A session-level
   watchdog over the two observable events only: fires when a tool call needed approval
   but **no `approval/asked` event appears within a window** (stuck-before-broker, e.g.
   the ask path wedged upstream of the broker). It cannot and does not fire on
   asked-without-decided (that's the slow-human shape until the §2 liveness signal
   exists). Arming signal: the watchdog arms on `tool/call` (harness
   `packages/core/session/src/known-event-types.ts:71`) whenever the effective
   permission mode makes an ask possible — pre-asked, "needs approval" is not directly
   observable (the ask decision is internal to the pre-execute waterfall), and a wedged
   PreToolUse hook or a slow classifier delays `asked` from inside that window, which is
   exactly the stuck class this watchdog exists to name. Window: `maxConfiguredHookTimeoutMs + slack`, phase-dependent (pre-asked vs
   asked), default dominated by the 600s hook bound — the watchdog never preempts the
   hook runner's own contract, and nested timeouts are layered
   (watchdog > classifier `timeoutMs` + hook timeout) rather than racing them. On fire:
   the tool call fails closed with an explicit `approval-timeout` diagnostic the model
   can report, and the session log gains a named event where today there is silence.

## 4. Expected effect

- Approved-A-ran-B becomes structurally impossible rather than conventionally avoided;
   permission forensics reads one input object end-to-end.
- The residual approval wedge classes each get a name: ownerless dialog (upstream
   liveness), stuck-before-broker (watchdog event), wedged hook (already bounded, now
   documented as such). The PR #123-class incident gets its general floor *without*
   conflating classifier availability with decision transport.
- Retry decisions stop hard-coding: provider packages ship tables, policy reads them.

## 5. Non-goals and risks

- No permission *model* redesign: modes, rule shapes, classifier policy untouched.
- Watchdog false-positive risk is bounded by the phase-dependent window; the cost of a
   false fire is a failed tool call with a named diagnostic, not a hung session.
- Broker liveness is upstream-owned; until it lands, ownerless dialogs remain
   undetectable by design — said out loud so nobody ships the watchdog claiming more.
- Review-flagged unknown: whether any existing broker already emits liveness/heartbeat
   was not verified from the read-only checkout → the proposal's first check.

## Acceptance (DoD)

- [ ] Three upstream proposal segments filed: normalization seam (with the
      validation-moves pipeline delta), decision liveness (+ hook-race delivery),
      taxonomy table seam (extend `retryableCodes`/`isQuotaExceededError`).
- [ ] dsh-cc watchdog shipped behind `cc-permission-watchdog.enabled`, scoped to
      pre-asked only, window = hook-timeout + slack, tests fabricate stuck-before-broker
      and slow-hook cases separately; manifest + `docs:parity` in the same commit.
- [ ] Session-log query for `approval-timeout` events returns rows instead of silence.
