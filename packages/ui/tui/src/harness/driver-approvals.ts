/**
 * Approval + user-question pipeline extracted from harness/driver.ts.
 *
 * Free-function collaborator: `createApprovalsSection` owns the modal FIFO
 * (approvals and questions share one queue via createModalQueue) and takes a
 * {@link DriverApprovalsCtx} instead of closing over createDriver's locals.
 * Emits re-read the current view-model via `rt.state()` after every emit
 * (createDriver rebinds `state` on emit). The section routes approvals from the
 * host's `approval/request` hook, persists "always allow" rules through the
 * settings provider, and answers questions through the host's userQuestions
 * provider.
 * @module @dsh-cc/tui/harness/driver-approvals
 */

import type { ApprovalView, QuestionView, ApprovalPreview } from '../store.ts'
import {
  backspaceQuestionText,
  moveQuestionFocus,
  toggleQuestionOption,
  typeQuestionText,
} from '../store.ts'
import type { ApprovalAnswerKind, SettingsProviderLike } from '../state/driver-types.ts'
import { PERMISSION_SETTINGS_NAMESPACE } from '@dsh-cc/permission-rules'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import {
  UserQuestionError,
  type AskUserQuestionAnswer,
  type AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'
import { allowRuleOf, isSettingsConflict, payloadOf } from './approval-preview.ts'
import { createModalQueue, type ModalEntry } from './driver-modal.ts'
import type { DriverApprovalsCtx } from './driver-ctx.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** The approvals-driven slice of the Driver surface, plus queue/dispose teardown. */
export type ApprovalsSection = {
  answerApproval(kind: ApprovalAnswerKind): void
  questionMove(delta: -1 | 1): void
  questionToggle(): void
  questionPick(index: number): void
  questionType(text: string): void
  questionBackspace(): void
  questionSubmit(): void
  questionCancel(): void
  /** Drain every parked modal entry (switchSession aborts approvals/questions). */
  spliceAll(): ModalEntry[]
  dispose(): void
}

/**
 * Build the approval/question pipeline. `answerApproval` threads the allow-rule
 * write through {@link ModalAnswerDeps}; the modal FIFO lives here so approvals
 * and user questions share a single queue. `current`/`state` are read live via
 * the ctx — never captured snapshots.
 */
export function createApprovalsSection(rt: DriverApprovalsCtx): ApprovalsSection {
  const modal = createModalQueue({ emit: rt.emit, state: rt.state })

  // --- Approvals ------------------------------------------------------------
  // The head approval is parked in state.approval together with the
  // recoverable payload preview. The "always" answer resolves the current call
  // like a one-shot grant AND persists a derived permission rule through the
  // settings provider (see writeAllowRule). Already-queued requests are decided
  // one by one even after a rule lands — grants never apply retroactively.
  // Requests from the current agent and from tracked subagents (their session
  // id was seen on `subagent/start`, which fires before a subagent's first
  // approval) queue here; anything else passes through to the next provider.
  rt.ctx.on('approval/request', async (req: ApprovalRequest, next) => {
    const ownSessions = new Set(rt.state().subagents.map(run => run.sessionId))
    ownSessions.add(String(rt.current.agent.session.id))
    if (!ownSessions.has(String(req.agent.session.id))) return next()
    const preview = payloadOf(req)
    const view: ApprovalView = {
      toolName: req.toolName,
      ...req.reason === undefined ? {} : { reason: req.reason },
      ...preview.kind === 'none' ? {} : { preview },
    }
    return await new Promise<ApprovalOutcome>(resolve => {
      const entry: ModalEntry = {
        kind: 'approval',
        view,
        resolve,
        agent: req.agent,
        ...req.signal === undefined ? {} : { signal: req.signal },
      }
      modal.push(entry)
      req.signal?.addEventListener('abort', () => {
        modal.dequeue(entry)
        resolve('cancelled')
      }, { once: true })
      modal.publishHead()
    })
  })

  /**
   * Persist the allow rule an "always" answer grants: read the `permissions`
   * namespace descriptor, merge the rule into the raw user section's allow
   * list (re-attaching every passthrough field — `replace` overwrites the
   * whole section), and write it back at the observed revision. One retry on
   * a revision conflict (re-describe, re-merge, replace). Degradations
   * (provider missing, namespace unregistered, write failure) leave the call
   * allowed once and say so in a notice — never a crash after the fact.
   */
  async function writeAllowRule(toolName: string, preview: ApprovalPreview | undefined): Promise<void> {
    const rule = allowRuleOf(toolName, preview)
    if (rule === undefined) return
    const settings = rt.ctx.get('settings') as SettingsProviderLike | undefined
    if (settings === undefined || settings.writable === false || typeof settings.describe !== 'function') {
      rt.showNotice('Allowed once only — no writable settings provider is mounted.')
      return
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const descriptor = settings.describe().find(
        entry => String(entry.ns) === String(PERMISSION_SETTINGS_NAMESPACE),
      )
      if (descriptor === undefined) {
        rt.showNotice('Allowed once only — the "permissions" settings namespace is not mounted.')
        return
      }
      const user = descriptor.user !== null && typeof descriptor.user === 'object'
        ? descriptor.user as Record<string, unknown>
        : {}
      const current = Array.isArray(user.allow) ? [...user.allow as unknown[]] : []
      const allow = current.includes(rule) ? current : [...current, rule]
      try {
        await settings.replace(PERMISSION_SETTINGS_NAMESPACE, { ...user, allow }, descriptor.revision)
        rt.showNotice(`Always allow: ${rule}`)
        return
      } catch (error) {
        if (attempt === 0 && isSettingsConflict(error)) continue
        const message = error instanceof Error ? error.message : String(error)
        rt.showNotice(`Allowed once only — saving the allow rule failed: ${message}`)
        return
      }
    }
  }

  /**
   * Grant the derived rule to the requesting session's scoped allowlist
   * (WS4-PR-B): the same derivation the "always" answer persists, but recorded
   * on the permission engine's in-memory session allowlist with an audit
   * event — never into the global `permissions` settings. Degradations (rule
   * underivable, permission engine absent) leave the call allowed once and
   * say so in a notice.
   */
  function addSessionRule(agent: unknown, toolName: string, preview: ApprovalPreview | undefined): void {
    const rule = allowRuleOf(toolName, preview)
    if (rule === undefined) return
    const engine = rt.ctx.get('permissionRules') as
      | { addSessionAllow(agent: Agent, rule: string): void }
      | undefined
    if (agent === undefined || engine === undefined) {
      rt.showNotice('Allowed once only — the permission engine is not mounted.')
      return
    }
    engine.addSessionAllow(agent as Agent, rule)
    rt.showNotice(`Allowed for this session: ${rule}`)
  }

  // --- User questions -------------------------------------------------------
  // A question from the host (agent ask for user input) renders as a modal
  // entry behind any active approval; when the pipeline is empty it becomes
  // the head and renders immediately.
  const userQuestions = rt.ctx.get('userQuestions') as
    | { registerProvider(provider: { ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> }): () => void }
    | undefined
  let questionsDispose: (() => void) | undefined
  if (userQuestions !== undefined) {
    try {
      questionsDispose = userQuestions.registerProvider({
        ask: async (request: AskUserQuestionRequest) => {
          const first = request.questions[0]
          const view: QuestionView = {
            header: first?.header ?? 'Question',
            question: first?.question ?? '',
            ...first?.detail === undefined ? {} : { detail: first.detail },
            options: (first?.options ?? []).map(option => ({
              label: option.label,
              ...option.description === undefined ? {} : { description: option.description },
            })),
            multiSelect: first?.multiSelect === true,
            ...first?.intent === undefined ? {} : { intent: first.intent },
            focused: 0,
            selected: [],
            custom: '',
          }
          // Queue behind any active modal; when the pipeline is empty this
          // entry becomes the head and renders immediately.
          return await new Promise<AskUserQuestionAnswer>((resolve, reject) => {
            const entry: ModalEntry = {
              kind: 'question',
              id: first?.id ?? '',
              view,
              resolve: (answer) => resolve({
                answers: answer.answers.map((item, index) => ({
                  id: request.questions[index]?.id ?? item.id,
                  selected: item.selected,
                  ...item.custom === undefined ? {} : { custom: item.custom },
                })),
              }),
              reject,
              ...request.signal === undefined ? {} : { signal: request.signal },
            }
            modal.push(entry)
            request.signal?.addEventListener('abort', () => {
              modal.dequeue(entry)
              reject(new UserQuestionError('question cancelled', 'CANCELLED'))
            }, { once: true })
            modal.publishHead()
          })
        },
      })
    } catch (error) {
      if ((error as { code?: string }).code !== 'DUPLICATE_PROVIDER') throw error
    }
  }

  /**
   * Resolve the head question and advance the modal queue. Labels are echoed
   * verbatim — the plan-review `intent.approve` contract requires the exact
   * label string, never an inferred or re-indexed one.
   */
  function resolveQuestion(selected: readonly string[], custom?: string): void {
    const head = modal.peekHead()
    if (head === undefined || head.kind !== 'question') return
    modal.shiftHead()
    modal.publishHead()
    head.resolve({
      answers: [{
        id: head.id,
        selected: [...selected],
        ...custom === undefined ? {} : { custom },
      }],
    })
  }

  return {
    answerApproval(kind: ApprovalAnswerKind) {
      modal.answerApproval(kind, { writeAllowRule, addSessionRule, showNotice: rt.showNotice })
    },
    questionMove(delta) {
      rt.emit(moveQuestionFocus(rt.state(), delta))
    },
    questionToggle() {
      const question = rt.state().question
      if (question === undefined) return
      if (question.focused >= question.options.length) {
        rt.emit(typeQuestionText(rt.state(), ' '))
        return
      }
      if (question.multiSelect) {
        rt.emit(toggleQuestionOption(rt.state(), question.focused))
        return
      }
      resolveQuestion([question.options[question.focused]!.label])
    },
    questionPick(index) {
      const question = rt.state().question
      if (question === undefined) return
      const option = question.options[index]
      if (option === undefined) return
      if (question.multiSelect) {
        rt.emit(toggleQuestionOption(rt.state(), index))
        return
      }
      resolveQuestion([option.label])
    },
    questionType(text) {
      rt.emit(typeQuestionText(rt.state(), text))
    },
    questionBackspace() {
      rt.emit(backspaceQuestionText(rt.state()))
    },
    questionSubmit() {
      const question = rt.state().question
      if (question === undefined) return
      const custom = question.custom.trim()
      let selected: string[]
      if (question.selected.length > 0) {
        selected = [...question.selected]
      } else if (custom.length > 0) {
        selected = []
      } else {
        // Nothing chosen and no free text: enter resolves the focused option
        // (the first option when the "Other" row holds focus) so the question
        // always gets an answer.
        const fallback = question.focused < question.options.length
          ? question.options[question.focused]!.label
          : question.options[0]?.label
        selected = fallback === undefined ? [] : [fallback]
      }
      resolveQuestion(selected, custom.length > 0 ? custom : undefined)
    },
    questionCancel() {
      const question = rt.state().question
      resolveQuestion(question !== undefined && question.options.length > 0 ? [question.options[0]!.label] : [])
    },
    spliceAll() {
      return modal.spliceAll()
    },
    dispose() {
      questionsDispose?.()
    },
  }
}
