# Implementation record — moa-cascade-routing

Keyed to the final run of 2026-10-26. Not part of inputDigest.

## Final run

- runId: `20261027T043654Z-5687877f-16b4-48e1-ab2f-22d8bf2487c8`,
  inputDigest `dfd5ea7b0033d0c79f1a366970940389394c582cbb80c3f38cb49c10eff05127`
  (supersedes `20261026T071949Z-0f408d71-…`, the pre-#301 run) 〔src:ws:specs/tla/moa-cascade-routing/code-anchors.md#L138-L201〕
- runnerPackage: `@dsh-cc/plugin-dsh-cc-agents` 0.9.2, TLC 1.7.4
  (jarSha256 936a2620…), Java 25.0.2, darwin
- check-evidence: `valid` / fresh / verification `counterexample`
  (aggregate — the two expansion probes are expected counterexamples)

## Case results

| Case | Status | Statistics |
|---|---|---|
| convention | **verified** | 13389/1928/0 |
| shadow-mode | **verified** | 3481/500/0 |
| strict-self-feedback | counterexample — ArmedNotAway | 209/75/43 |
| strict-crash-resume | counterexample — NoFloorlessRetry | 464/164/99 |

## Counterexample dispositions

### strict-self-feedback — design-defense necessity (expected)

Trace: `Classify → TurnEnd → UserTurn → RequestObserve`. With the observe
reading the served (overlaid) pair instead of the frozen pre-overlay pair,
the first overlaid turn's own traffic disarms the cascade at the next
request (`armed=false` while `away=false`). In the real code this is
structurally impossible: `observeLiveSelection` runs strictly before
`withTier` and the sanitizer publishes the frozen `selection.assembled`
before `next()`. The probe demonstrates why that ordering is load-bearing:
removing it silently kills routing after one classified turn.

Classification: modeling probe validating a design defense; no code
change.

### strict-crash-resume — F-3 CLOSED by PR #301 (probe keeps the pre-fix shape)

Trace: `Classify → TurnEnd → JudgeVerdict → Crash → RetryTurn`. The judge
escalates (recordRetryUsed → followup dispatched), the process crashes and
resumes, the in-memory `EscalationBookkeeping` map is lost while the typed
`moa-escalation` followup survives in the inbox. The retry turn then finds
`floorFor(originSeq)` undefined and `tierForTurn` fails open — the retry
runs on the boot selection instead of the escalation floor, silently
undoing the escalation.

Code anchors: `state.ts:101-105` (production entry created only by the
first `recordRetryUsed`; `recordFloor` is test/rig-only) and
`router.ts:333-334` (fail-open on undefined floor). No test pins the crash
window.

Classification: **design defect / accepted fail-open** (user disposition
pending): the escalation chain survives only as long as the process. A fix
would persist the bookkeeping (e.g. sidecar) or re-derive the floor from
the routing ledger on resume. Not fixed here.

## Unmodeled scope

- Classification internals (System One argmax, label collapse, token
  cropping, truncation sentinel) — deterministic computation.
- Sidecar ledger rows (routing.jsonl / acceptance.jsonl bytes), status-row
  splice, sanitizer row dropping.
- Degenerate-ladder validation (contiguous-duplicate rule) — the model
  assumes an armed, all-distinct ladder; the validation itself is pure.
- Subagent scope exclusion is encoded structurally (a no-op action), not
  as a TLC state predicate.
- Multi-origin concurrent conversations (single-origin chain modeled).
- Stale-guard variants beyond a genuine user turn (fork session identity,
  /model during judging) — folded into the single stale flag.

## Suggested regression tests (repo changes, not made here)

1. Crash-resume floor loss: simulate a restart between escalation
   dispatch and retry-turn delivery; assert the retry tier (currently
   fails open to the boot selection — pins the F-3 disposition).
2. Pre-overlay observe: a spy-order test asserting `observeLiveSelection`
   sees the pre-overlay pair on every request under an active overlay
   (extends `sanitizer-order.spec.ts` to the request lane).
