/**
 * Modal pipeline (approvals + questions sharing one FIFO) extracted from
 * harness/driver.ts. Free-function collaborator: `createModalQueue` takes a
 * {@link DriverModalCtx} instead of closing over createDriver's locals, so the
 * harness factory stays out of this leaf. Emits re-read the current view-model
 * via `rt.state()` after every emit (createDriver rebinds `state` on emit).
 * @module @dsh-cc/tui/harness/driver-modal
 */

import {
  setApproval,
  setQuestion,
  type ApprovalPreview,
  type ApprovalView,
  type QuestionView,
} from '../store.ts'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import type { DriverModalCtx } from './driver-ctx.ts'

export type ApprovalEntry = {
  kind: 'approval'
  view: ApprovalView
  resolve: (outcome: ApprovalOutcome) => void
  /** The requesting agent — carries the session a 'session' grant scopes to. */
  agent?: unknown
  signal?: AbortSignal
}
export type QuestionEntry = {
  kind: 'question'
  id: string
  view: QuestionView
  resolve: (answer: AskUserQuestionAnswer) => void
  reject: (error: unknown) => void
  signal?: AbortSignal
}
export type ModalEntry = ApprovalEntry | QuestionEntry

/** Deps `answerApproval` threads through to createDriver's persistence layer. */
export interface ModalAnswerDeps {
  writeAllowRule(toolName: string, preview: ApprovalPreview | undefined): Promise<void>
  /** Grant the derived rule to the requesting session's allowlist (WS4-PR-B). */
  addSessionRule(
    agent: unknown,
    toolName: string,
    preview: ApprovalPreview | undefined,
  ): void
  showNotice(text: string): void
}

/**
 * Build the modal FIFO. Only the head renders (exactly one of the approval and
 * question slots is set); answering or aborting the head promotes the next
 * entry, and `ask()` during an active modal queues behind it instead of
 * stacking a second box.
 */
export function createModalQueue(rt: DriverModalCtx): {
  push(entry: ModalEntry): void
  dequeue(entry: ModalEntry): void
  publishHead(): void
  shiftHead(): ModalEntry | undefined
  peekHead(): ModalEntry | undefined
  spliceAll(): ModalEntry[]
  answerApproval(kind: 'once' | 'always' | 'session' | 'reject', deps: ModalAnswerDeps): void
} {
  const modalQueue: ModalEntry[] = []

  /** Publish the queue head into exactly one of the two modal slots. */
  const publishHead = (): void => {
    const head = modalQueue[0]
    const behind = modalQueue.length - 1
    if (head === undefined || head.kind !== 'approval') rt.emit(setApproval(rt.state(), undefined))
    if (head === undefined || head.kind !== 'question') rt.emit(setQuestion(rt.state(), undefined))
    if (head === undefined) return
    if (head.kind === 'approval') {
      rt.emit(setApproval(rt.state(), { ...head.view, ...(behind === 0 ? {} : { pendingCount: behind }) }))
    } else {
      rt.emit(setQuestion(rt.state(), head.view))
    }
  }

  /** Remove an entry from the queue (no-op if already gone) and republish. */
  const dequeue = (entry: ModalEntry): void => {
    const index = modalQueue.indexOf(entry)
    if (index < 0) return
    modalQueue.splice(index, 1)
    publishHead()
  }

  const peekHead = (): ModalEntry | undefined => modalQueue[0]

  const shiftHead = (): ModalEntry | undefined => modalQueue.shift()

  const spliceAll = (): ModalEntry[] => modalQueue.splice(0)

  const answerApproval = (kind: 'once' | 'always' | 'session' | 'reject', deps: ModalAnswerDeps): void => {
    const head = modalQueue[0]
    if (head === undefined || head.kind !== 'approval') return
    // Advance the queue BEFORE resolving: a resolution can immediately fire
    // the next approval/request, which must enqueue behind the survivors.
    modalQueue.shift()
    publishHead()
    head.resolve(kind === 'reject' ? 'rejected' : 'allowed-once')
    if (kind === 'always') {
      // Fire-and-forget: the call proceeds while the rule persists; a write
      // failure surfaces as a notice, never as an answer error.
      void deps.writeAllowRule(head.view.toolName, head.view.preview).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        deps.showNotice(`Allowed once only — saving the allow rule failed: ${message}`)
      })
    }
    if (kind === 'session') {
      // Fire-and-forget like 'always': the call proceeds while the derived
      // rule is granted to the requesting session's allowlist (WS4-PR-B,
      // never global settings); a failure surfaces as a notice.
      try {
        deps.addSessionRule(head.agent, head.view.toolName, head.view.preview)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        deps.showNotice(`Allowed once only — adding the session rule failed: ${message}`)
      }
    }
  }

  return { push: (e) => modalQueue.push(e), dequeue, publishHead, shiftHead, peekHead, spliceAll, answerApproval }
}
