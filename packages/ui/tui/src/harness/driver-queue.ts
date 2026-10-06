/**
 * Outbox queue, submit, and interrupt pipeline extracted from harness/driver.ts.
 * Free-function collaborator: takes a {@link DriverQueueCtx} instead of closing
 * over createDriver's locals, so the harness factory stays out of this leaf.
 * @module @dsh-cc/tui/harness/driver-queue
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { PastedImage } from '@dsh-cc/pi-tui'
import { LOCAL_SLASH, parseSlash } from '../slash.ts'
import { saveHistory } from '../history.ts'
import {
  clearQueue,
  clearTurn,
  enqueue,
  popQueued,
  setBusy,
  setDraft,
  setTurnActive,
  upsertRow,
  type QueuedChip,
} from '../store.ts'
import {
  admitSubmitImages,
  stripImageMarkers,
  submissionContent,
  type ImageStoreLike,
  type SubmissionPayload,
} from './image-submit.ts'
import type { DriverQueueCtx } from './driver-ctx.ts'

/**
 * Duck-typed surface for the optional cc-shell plugin-commands service (see
 * CcPluginsLike in driver-catalog.ts / CcPluginsRunLike in driver-run-local.ts).
 * A missing service degrades to sending the raw queued line — the same
 * unknown-slash fall-through philosophy as the submit path.
 */
type CcPluginsRunLike = {
  listPluginCommands?(): readonly { name: string }[]
  runPluginCommand(
    name: string,
    input: { agent: unknown; rawInput: string },
  ): Promise<{ ok: true } | { ok: false; reason: string }>
}

/**
 * `SubmissionPayload` is image-submit's own pair (outgoing prose + admitted
 * image blocks); a submission with no images is `{ text, blocks: [] }`, which
 * builds the exact pre-feature message. The shape rule lives in that module,
 * where it is unit-tested without a harness.
 */
const asPrepared = (text: string): SubmissionPayload => ({ text, blocks: [] })

/** Build the user message for one prepared submission. */
const asUserMessage = (submission: SubmissionPayload) => createUserMessage({
  content: submissionContent(submission),
  source: { kind: 'user' },
})

/** True when this chip carries images that must be admitted before dispatch. */
const chipHasImages = (chip: QueuedChip): boolean => chip.images !== undefined && chip.images.length > 0

/** The notice for one submission's unattached images (plan 3.6). */
const imageFailureNotice = (failed: number, total: number, serviceMissing: boolean): string => {
  if (serviceMissing) return 'Image not attached: no attachments service is mounted.'
  if (total === 1) return 'Image not attached: the pasted image could not be saved.'
  return `Image not attached: ${failed} of ${total} images could not be saved.`
}

/**
 * The §3.7 gate lookup, contained: a rejecting seam resolves to "unknown", the
 * same verdict as an absent one. Preparation then never rejects, which is what
 * lets the image-bearing batch below be fire-and-forget without an unhandled
 * rejection path.
 */
const imageSupportOf = async (
  rt: DriverQueueCtx,
): Promise<{ model: string; supported: boolean } | undefined> => {
  try {
    return await rt.resolveImageSupport()
  } catch {
    return undefined
  }
}

/**
 * Turn one submission's captured images into admitted blocks, or into a notice
 * when they cannot be attached. The prompt itself is never at risk: the text
 * comes back either way, with every marker stripped (plan 3.6 - a marker whose
 * image did not attach would otherwise reach the model as prose naming an image
 * it never received).
 *
 * The route gate runs FIRST (plan 3.7): an image sent to a model that does not
 * declare image input throws LlmError(UNSUPPORTED_CONTENT) deep in provider
 * request assembly, so asking here trades a failed turn for a notice naming the
 * model. It is skipped - and admission proceeds - whenever the capability is
 * not resolvable; see DriverQueueCtx.resolveImageSupport.
 */
const prepareCapturedImages = async (
  rt: DriverQueueCtx,
  text: string,
  images: readonly PastedImage[],
): Promise<SubmissionPayload> => {
  const support = await imageSupportOf(rt)
  if (support?.supported === false) {
    rt.showNotice(`Image not attached: ${support.model} does not declare image input.`)
    return { text: stripImageMarkers(text), blocks: [] }
  }
  const store = rt.ctx.get('attachments') as ImageStoreLike | undefined
  const admitted = await admitSubmitImages(store, text, images)
  if (admitted.serviceMissing) rt.showNotice(imageFailureNotice(admitted.failed, images.length, true))
  else if (admitted.failed > 0) rt.showNotice(imageFailureNotice(admitted.failed, images.length, false))
  return { text: admitted.text, blocks: admitted.blocks }
}

/**
 * Prepare a FIFO batch of outbox chips for dispatch.
 *
 * Synchronous for a batch with no images, which keeps the pre-feature timing
 * intact: Ctrl+S must have steered before steerQueued returns, and the
 * zombie-busy re-dispatch must land before the draft that follows it. An
 * image-bearing batch has to await `saveImage`, and because one chip's
 * admission can outlast a later chip's, EVERY chip is prepared before anything
 * is dispatched - awaiting a dispatch per chip would let a later, image-free
 * chip overtake and invert the outbox order.
 */
const prepareChips = (
  rt: DriverQueueCtx,
  chips: readonly QueuedChip[],
): readonly SubmissionPayload[] | Promise<readonly SubmissionPayload[]> => {
  if (!chips.some(chipHasImages)) return chips.map(chip => asPrepared(chip.text))
  return Promise.all(chips.map((chip) => {
    const images = chip.images
    return images === undefined || images.length === 0
      ? asPrepared(chip.text)
      : prepareCapturedImages(rt, chip.text, images)
  }))
}

/**
 * Prepare then dispatch a chip batch, preserving FIFO order and the synchronous
 * timing of the image-free case. Returns the per-chip hand-off results
 * `dispatchQueued` reports (a promise when the batch carried images).
 */
const dispatchBatch = (
  rt: DriverQueueCtx,
  chips: readonly QueuedChip[],
  mode: 'followup' | 'steer',
): readonly (boolean | Promise<boolean>)[] | Promise<readonly (boolean | Promise<boolean>)[]> => {
  const prepared = prepareChips(rt, chips)
  if (prepared instanceof Promise) {
    return prepared.then(next => next.map(submission => dispatchQueued(rt, submission, mode)))
  }
  return prepared.map(submission => dispatchQueued(rt, submission, mode))
}

/**
 * Dispatch one prepared outbox entry. A queued plugin command (`/codex:review
 * args`) is re-classified here instead of being forwarded verbatim: flush and
 * steer otherwise leak the raw slash line to the model as prompt text. A local
 * name that is NOT a TUI-owned LOCAL_SLASH entry is a plugin command — it
 * routes through the ccPlugins service. Anything else (plain prose, ordinary
 * local names) sends as the original followup/steer, unchanged.
 *
 * A plugin command drops its submission's images: `runPluginCommand` takes a
 * raw input line, the same non-text flattening the plan records for MCP and
 * hooks. The raw-line fallbacks do NOT drop them - those become ordinary
 * prompts, so they send exactly what a direct submit of the same text sends.
 *
 * Returns whether the entry was handed off to the agent (raw send or a
 * successful plugin dispatch) — false means dropped with a notice. flushQueue
 * uses this to avoid anchoring a busy turn nothing will arrive for.
 */
const dispatchQueued = (
  rt: DriverQueueCtx,
  submission: SubmissionPayload,
  mode: 'followup' | 'steer',
): boolean | Promise<boolean> => {
  const send = (): boolean => {
    const message = asUserMessage(submission)
    if (mode === 'followup') rt.current.agent.followup(message)
    else rt.current.agent.steer(message)
    return true
  }
  const parsed = parseSlash(submission.text)
  if (parsed.kind !== 'local') {
    return send()
  }
  if ((LOCAL_SLASH as readonly string[]).includes(parsed.name)) {
    // Ordinary TUI-local names never enter the outbox while busy, but if one
    // ever does, keep the historical behavior: forward the text verbatim.
    return send()
  }
  // Plugin command. The raw-line fallback is reserved for names that are no
  // longer in the plugin command table (uninstalled between enqueue and
  // flush) or a vanished service — the same unknown-slash fall-through
  // philosophy as the submit path. A name that IS still registered but fails
  // ({ok:false} or reject) must never reach the model as raw slash text: it
  // surfaces a notice instead and the queued line is dropped.
  const plugins = rt.ctx.get('ccPlugins') as CcPluginsRunLike | undefined
  if (plugins === undefined || typeof plugins.runPluginCommand !== 'function') {
    return send()
  }
  const { name, rawInput } = parsed
  // Live membership check against the CURRENT table, mirrored at failure
  // time: a name that left the table degrades to the raw line; a name that is
  // still registered keeps the line local.
  const stillListed = (): boolean => {
    if (typeof plugins.listPluginCommands !== 'function') return true
    try {
      return plugins.listPluginCommands().some(c => c.name.toLowerCase() === name)
    } catch {
      return true // undecidable → keep the line local, never raw-send
    }
  }
  const failWithNotice = (reason: string): boolean => {
    rt.showNotice(`Plugin command /${name} failed: ${reason}`)
    return false
  }
  return plugins.runPluginCommand(name, { agent: rt.current.agent, rawInput })
    .then((result) => {
      if (!(result !== null && typeof result === 'object' && (result as { ok?: unknown }).ok === false)) return true
      if (!stillListed()) return send()
      const reason = (result as { reason?: string }).reason ?? 'unknown error'
      return failWithNotice(reason)
    })
    .catch((error: unknown) => {
      if (!stillListed()) return send()
      return failWithNotice(error instanceof Error ? error.message : String(error))
    })
}

/**
 * Outbox flush, anchored to the durable `turn/end` event: snapshot the queue,
 * dispatch every entry FIFO through `followup`, and clear the queue in one
 * atomic stroke — so the queue never holds an entry that was already sent and
 * ↑ recall cannot race a flush. Busy is re-asserted optimistically (the
 * flushed followups start a new turn immediately; the fold's `turn/end`
 * handling just set it false), but only when at least one entry was handed
 * off.
 *
 * The stroke is deferred until the agent converges to idle (agent.whenIdle,
 * falling back to one microtask for hosts without it). Two hazards force the
 * wait, both proven by live e2e:
 *
 * 1. The call sites are `session/event` observers running INSIDE the session
 *    append publication window; `followup` → `inbox.splice` appends
 *    `agent/inbox/spliced` synchronously and hits the session reentrancy
 *    guard ("session append cannot reenter while another append is being
 *    published").
 * 2. A bare microtask lands in the driver teardown gap: kick()'s loop already
 *    made its last inbox claim but setPhase(idle) hasn't run, so wakeDriver
 *    takes the non-idle branch — which neither latches the wake (not an
 *    abort/maintenance) nor has a live driver to claim the work. The spliced
 *    message strands in the inbox and the UI sits on a zombie busy anchor.
 *    whenIdle resolves only after kick's finally sets the idle phase, where
 *    wakeDriver's idle path reliably starts the next driver.
 */
const flushQueue = (rt: DriverQueueCtx): void => {
  const flush = (): void => {
    const s = rt.state()
    const pending = [...s.queued]
    if (pending.length === 0) return
    rt.emit(clearQueue(s))
    // Anchor the followup turn only once we know at least one entry was
    // actually handed off: an all-dropped flush (e.g. a plugin command that
    // failed with a notice) must not leave a zombie busy spinner behind.
    const anchor = (handedOff: readonly (boolean | Promise<boolean>)[]): void => {
      void Promise.all(handedOff).then(results => {
        if (!results.some(Boolean)) return
        rt.emit(setTurnActive(setBusy(rt.state(), true), { startedAt: Date.now(), outputBase: s.hud?.tokens?.output }))
      })
    }
    // An image-bearing batch admits its images first (see prepareChips); the
    // queue is already cleared above either way, so a slow admission can never
    // resurrect a chip that failed to attach.
    const dispatched = dispatchBatch(rt, pending, 'followup')
    if (dispatched instanceof Promise) void dispatched.then(anchor)
    else anchor(dispatched)
  }
  // Await the agent that ENDED the turn (captured now); dispatchQueued reads
  // rt.current.agent at fire time, so a session switch still targets the
  // live session. A rejected whenIdle must not strand the queue.
  const endingAgent = rt.current.agent as { whenIdle?: () => Promise<void> }
  if (typeof endingAgent.whenIdle === 'function') {
    // A throwing flush is otherwise an unhandled rejection — surface it.
    void endingAgent.whenIdle().then(flush, flush)
      .catch((error: unknown) => rt.showNotice(`⚠ Outbox flush failed: ${error instanceof Error ? error.message : String(error)}`))
  } else {
    queueMicrotask(flush)
  }
}

/**
 * Ctrl+S queue-jump: inject every queued entry into the RUNNING turn
 * immediately — same synchronous snapshot-then-clear discipline as
 * {@link flushQueue}, but via `agent.steer` and without a busy flip (the
 * turn is already running).
 */
const steerQueued = (rt: DriverQueueCtx): void => {
  const s = rt.state()
  // Same zombie-busy reconcile as submit: steering a dead turn would
  // self-recover the dispatch but leave busy latched forever. Clear the
  // stale anchor and re-dispatch the chips as queued work instead.
  if (s.busy && rt.current.agent.status !== 'running') {
    const zombieChips = [...s.queued]
    rt.emit(clearTurn(clearQueue(setBusy(rt.state(), false))))
    void dispatchBatch(rt, zombieChips, 'followup')
    return
  }
  const pending = [...s.queued]
  if (pending.length === 0) return
  // Semantic trade-off, unchanged: every entry steers, including a queued
  // plugin command — running it through the plugin seam is more important than
  // steering semantics. The clear stays ahead of the dispatch for an
  // image-bearing batch (whose admission is async) and behind it for a
  // text-only one, where the dispatch is synchronous: the original ordering in
  // both cases.
  const dispatched = dispatchBatch(rt, pending, 'steer')
  rt.emit(clearQueue(s))
  void dispatched
}

/**
 * Recall for editing: pop the most recent queued entry back out of the outbox
 * and hand its text to the caller (root.ts puts it into the composer).
 * Race-free by construction — flush and steer always clear synchronously, so
 * the queue only ever holds entries that were never sent.
 *
 * The chip's images cannot come back with it: the composer's image registry is
 * written only by a paste, so a recalled marker could never re-attach, and
 * re-submitting the raw text would put `[Image #N]` in front of the model as
 * prose. The markers are therefore stripped — the same rule dispatch applies —
 * and the user is told, because silently dropping a just-pasted image is the
 * failure §3.5 exists to prevent (plan §5 asks for exactly this confirmation).
 */
const recallQueued = (rt: DriverQueueCtx): string | undefined => {
  const popped = popQueued(rt.state())
  if (popped.chip === undefined) return undefined
  rt.emit(popped.state)
  const images = popped.chip.images
  if (images === undefined || images.length === 0) return popped.chip.text
  rt.showNotice('Image not restored with the recalled text; paste it again to re-attach.')
  return stripImageMarkers(popped.chip.text)
}

const submit = async (rt: DriverQueueCtx, text?: string, images?: readonly PastedImage[]): Promise<void> => {
  const draft = text ?? rt.state().draft
  // An image-only submission (paste a screenshot, press Enter) has no text but
  // is not empty: this guard exists to drop a genuinely blank composer, not to
  // drop payload. Rejected alternative: keep the text-only guard and have the
  // caller synthesize a placeholder prompt, which would put words the user never
  // typed in front of the model.
  if (draft.trim().length === 0 && (images === undefined || images.length === 0)) return
  rt.emit(setDraft(rt.state(), ''))
  // A leading `!` marks a LOCAL shell command no matter how the text was
  // entered — typed in shell mode or pasted wholesale. It runs even while
  // the agent is busy (a local command never touches the turn) and is neither
  // a prompt nor a slash command. Images captured into one are dropped here,
  // with the slash/harness returns below: a command line is not a prompt, so
  // there is nothing to attach them to (a `!` line reaches the shell with its
  // marker text, exactly as it did before admission existed).
  if (draft.startsWith('!')) {
    await rt.runShellCommand(draft.slice(1))
    return
  }
  const parsed = parseSlash(draft)
  if (parsed.kind === 'local') {
    await rt.runLocal(parsed.name, parsed.rawInput)
    return
  }
  if (parsed.kind === 'harness') {
    // Bare `/permissions` is the TUI analogue of the browser popupSelect
    // decoration: open the overlay instead of dumping the rule listing.
    // `/permissions <mode>` stays scriptable through the host command.
    if (/^\/permissions$/i.test(parsed.line)) {
      rt.openPermissionPicker()
      return
    }
    // An empty name segment (bare `/` or `/   `) is not a command, a skill,
    // or a prompt worth a model turn.
    const name = parsed.line.slice(1).split(/\s/, 1)[0] ?? ''
    if (name.length === 0) {
      rt.showNotice('Empty slash command.')
      return
    }
    const result = await rt.runHarness(parsed.line)
    if (result !== undefined) {
      // A result object (success or error) means a known command ran in the
      // command plane; `null` means no command registry is mounted (runHarness
      // already noticed). Neither becomes a prompt.
      return
    }
    // Unknown name: fall through to the prompt path below. This is the whole
    // user-invocable-skill mechanism — the TUI never decides "is this a
    // skill?"; the host's closed-set matching does. The followup message
    // below MUST keep `source: { kind: 'user' }` because dsh-tool-skill's
    // pre-step gesture boundary only scans `source.kind === 'user'` messages;
    // if the name is a user-invocable skill it injects <skill_content>, and
    // otherwise the line stays ordinary prose.
  }
  // W4 await-late seam: the boot seed (deployment default model) must be
  // SETTLED before this turn is enqueued or dispatched — the harness
  // snapshots `selection.current` at the start of prompt assembly
  // (@deepseek-ai/dsh-agent model-selection.ts `system-prompt/assemble`),
  // so dispatching earlier would run the turn with an undefined model.
  // Local `!` shell lines and slash commands above already returned.
  await rt.waitForModel()
  // Images are admitted to durable refs BEFORE the message is built (plan
  // 3.4), which is also where the markers leave the prose: the composer's
  // `[Image #N]` must never reach the model as text. A submission with no
  // images skips this entirely - no lookup, no await, no notices - so the
  // text-only path keeps its exact pre-feature shape.
  const captured = images ?? []
  const submission = captured.length === 0
    ? asPrepared(draft)
    : await prepareCapturedImages(rt, draft, captured)
  // Persist the prompt (not slash commands — they are commands, not prompts,
  // and would dilute the recall signal; an unknown slash IS a prompt and
  // persists here via the fall-through above). Consecutive duplicates and the
  // cap are handled inside saveHistory. This is also the first real-content
  // signal: mark the session so the launcher can resume it. The MARKER-BEARING
  // draft is what persists, not `submission.text`: recall history should read
  // back what the user typed, and an image is not replayable from history
  // (plan §5).
  rt.setHistory(saveHistory([...rt.getHistory(), draft], rt.historyDir))
  rt.setMarkedContent(true)
  rt.persistResumeTarget()
  const s = rt.state()
  if (s.busy) {
    // Zombie-busy reconcile: if ground truth says the agent is not running,
    // the busy latch is stale (the event intake died mid-turn) and the chips
    // would strand until a turn/end that can never be seen. Reconcile from
    // the agent status, re-dispatch the chips FIFO before the new draft (NOT
    // via flushQueue — its whenIdle deferral would let the draft below
    // overtake them; awaiting the batch's admission keeps that order even for
    // a chip with images), then fall through to the idle-send path below.
    if (rt.current.agent.status !== 'running') {
      const zombieChips = [...rt.state().queued]
      rt.emit(clearTurn(clearQueue(setBusy(rt.state(), false))))
      await dispatchBatch(rt, zombieChips, 'followup')
    } else {
      // Outbox: park the submission as a pending chip only. It reaches the
      // agent on the next durable `turn/end` (flushQueue) or immediately via
      // Ctrl+S (steerQueued). No injection into the running turn here — that
      // is what makes recall-then-edit meaningful. The chip takes the images
      // with it (plan 3.5): admission is deferred to dispatch, so a paste made
      // while busy is never lost.
      rt.emit(enqueue(s, draft, captured))
      return
    }
  }
  // Idle sends bypass the outbox entirely — the row surfaces from the durable
  // `user/message` event, and a sent text must not stay recallable.
  rt.current.agent.followup(asUserMessage(submission))
  // Anchor the working line at dispatch: elapsed counts from here, the token
  // delta from the current HUD total (undefined when unseeded — the tokenUsage
  // rebase pins it on the first change).
  rt.emit(setTurnActive(setBusy(rt.state(), true), { startedAt: Date.now(), outputBase: s.hud?.tokens?.output }))
}

const interrupt = (rt: DriverQueueCtx): void => {
  rt.current.agent.cancel({ kind: 'user' })
  // cancel discards queued/steering inbox items; mirror that in UI state.
  // Clearing BEFORE the abort's turn/end lands also guarantees the flush
  // anchor finds an empty queue — an interrupt never resurrects entries.
  // The working-line anchor clears with the turn.
  rt.emit(upsertRow(clearTurn(clearQueue(setBusy(rt.state(), false))), {
    kind: 'status',
    text: 'Interrupted by user.',
  }))
}

/**
 * Build the queue/sumit/interrupt section of createDriver. `rt` supplies live
 * state, emit, and neighbor-section seams (bash/local/harness/permission picker).
 */
export function createQueueSection(rt: DriverQueueCtx): {
  flushQueue(): void
  steerQueued(): void
  recallQueued(): string | undefined
  submit(text?: string, images?: readonly PastedImage[]): Promise<void>
  interrupt(): void
} {
  return {
    flushQueue: () => flushQueue(rt),
    steerQueued: () => steerQueued(rt),
    recallQueued: () => recallQueued(rt),
    submit: (text, images) => submit(rt, text, images),
    interrupt: () => interrupt(rt),
  }
}
