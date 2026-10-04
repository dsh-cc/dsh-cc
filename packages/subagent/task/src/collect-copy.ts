/**
 * The collect path's copy functions (extracted from background-start.ts to
 * keep that module under its file-size budget — the release-valve additions
 * stopped fitting): per-reason failure copy for epoch terminals, the Ctrl+B
 * user-promotion result, and the outcome→tool-result projection.
 *
 * @module @dsh-cc/subagent-task/collect-copy
 */

import { isReleased, isReleasing } from '@dsh-cc/command-agents/release'
import { graceWindowClause } from './grace-window.ts'
import type { EpochOutcome } from './epoch-collector.ts'

/**
 * Per-reason failure copy for the collect path (UX plan §4 Slice 3 item 2):
 * mirrors `settle`'s contract — `completed` becomes the tool result, every
 * other stop reason throws with a reason-specific, actionable message.
 */
function stopReasonMessage(childId: string, stopReason: string): string {
  switch (stopReason) {
    case 'error':
      return `subagent ${childId} run failed: the child hit a model or transport failure (stopReason "error").`
    case 'max-tokens':
      return `subagent ${childId} stopped with reason "max-tokens": the child hit its token ceiling before finishing.`
    case 'refusal':
      return `subagent ${childId} stopped with reason "refusal": the child declined the task.`
    case 'aborted':
      // Release-valve gate (D3): a child released (or mid-release) while being
      // collected is NOT resumable here — the pre-issuance releasing mark
      // makes the gate visible even when the collect resolves during the
      // drain (F12a).
      if (isReleased(childId) || isReleasing(childId)) {
        return `subagent ${childId} was released (or its release was in flight) while it was being collected; it cannot be continued in this session.`
      }
      // R6 (§3.6): a post-start interrupt has an accepted childId and a
      // persisted session — the copy may claim resumability and name the
      // continuation path. Start failures never reach stopReasonMessage.
      return `subagent ${childId} was interrupted (stopReason "aborted"); it may still be resumed — /agents for status. The child's session persisted; send_message to ${childId} can resume it.`
    default:
      return `subagent ${childId} stopped with reason "${stopReason}".`
  }
}

/**
 * R9: every non-`completed` terminal throws through `stopReasonMessage`, and
 * the arm-time grace clause rides it too — the parent of a failed writer
 * needs the deadline at least as much (§3.8 arms on that same
 * `subagent/end`). Released children are excluded: their copy already says
 * the child cannot be continued here.
 */
function stopReasonWithGrace(childId: string, stopReason: string): string {
  const base = stopReasonMessage(childId, stopReason)
  if (stopReason === 'aborted' && (isReleased(childId) || isReleasing(childId))) return base
  return base + graceWindowClause(childId)
}

/**
 * The user-promotion result (Ctrl+B, UX plan §3.4): the foreground wait is
 * released to background — the model sees the SAME contract as an explicit
 * `run_in_background: true` launch, with `backgroundedByUser: true` marking
 * the promotion. The child's report/finish notice arrives later as a wake
 * (its suppression mark was removed by `promote()` — exactly-once delivery).
 */
export function promotedResult(
  childId: string,
  captureWarning: string | undefined,
): { text: string; status: 'async_launched'; agentId: string; backgroundedByUser: true } {
  return {
    text:
      `Background subagent started (agentId: ${childId}). The user moved the foreground wait `
      + 'to the background while it ran (status async_launched, backgroundedByUser: true); treat '
      + 'this exactly like a background launch — the result arrives as a later waking message, '
      + 'so do not compose on an inline result. '
      + 'Control it by that id: `list_agents` for status, `send_message` to continue that same '
      + 'assignment (a new task needs a fresh `subagent_fork`), `interrupt_agent` to stop its '
      + 'current turn.'
      + (captureWarning !== undefined
        ? `\nresume pin capture failed: ${captureWarning}; this child will resume with legacy semantics`
        : ''),
    status: 'async_launched',
    agentId: childId,
    backgroundedByUser: true,
  }
}

/**
 * Project the collect path's epoch outcome onto the tool output shape
 * (`settle`'s contract): `completed` → the closing message's text blocks;
 * any other stop reason — including the abort path's prompt-synthetic
 * `aborted` — throws with per-reason copy.
 */
export function outcomeToResult(
  childId: string,
  outcome: EpochOutcome,
  captureWarning: string | undefined,
): { text: string; status: 'completed' } {
  // A promoted outcome never reaches here (the collect caller returns the
  // async_launched result first); defensively it is an unexpected terminal.
  if (outcome.kind !== 'epoch' || outcome.stopReason !== 'completed') {
    throw new Error(stopReasonWithGrace(childId, outcome.kind === 'epoch' ? outcome.stopReason : outcome.kind))
  }
  const text = (outcome.output ?? [])
    .filter(block => block.type === 'text')
    .map(block => block.text ?? '')
    .join('')
  // R9 arm-time copy: the armed grace clause (window + absolute local expiry,
  // or "auto-release disabled") rides the completed foreground result.
  return {
    text:
      text
      + graceWindowClause(childId)
      + (captureWarning !== undefined
        ? `\nresume pin capture failed: ${captureWarning}; this child will resume with legacy semantics`
        : ''),
    status: 'completed' as const,
  }
}
