/**
 * Outbox queue, submit, and interrupt pipeline extracted from harness/driver.ts.
 * Free-function collaborator: takes a {@link DriverQueueCtx} instead of closing
 * over createDriver's locals, so the harness factory stays out of this leaf.
 * @module @dsh-cc/tui/harness/driver-queue
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
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
} from '../store.ts'
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

const asUserMessage = (text: string) => createUserMessage({
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})

/**
 * Dispatch one queued outbox entry. A queued plugin command (`/codex:review
 * args`) is re-classified here instead of being forwarded verbatim: flush and
 * steer otherwise leak the raw slash line to the model as prompt text. A local
 * name that is NOT a TUI-owned LOCAL_SLASH entry is a plugin command — it
 * routes through the ccPlugins service. Anything else (plain prose, ordinary
 * local names) sends as the original followup/steer, unchanged.
 *
 * Returns whether the entry was handed off to the agent (raw send or a
 * successful plugin dispatch) — false means dropped with a notice. flushQueue
 * uses this to avoid anchoring a busy turn nothing will arrive for.
 */
const dispatchQueued = (rt: DriverQueueCtx, text: string, mode: 'followup' | 'steer'): boolean | Promise<boolean> => {
  const send = (raw: string): boolean => {
    const message = asUserMessage(raw)
    if (mode === 'followup') rt.current.agent.followup(message)
    else rt.current.agent.steer(message)
    return true
  }
  const parsed = parseSlash(text)
  if (parsed.kind !== 'local') {
    return send(text)
  }
  if ((LOCAL_SLASH as readonly string[]).includes(parsed.name)) {
    // Ordinary TUI-local names never enter the outbox while busy, but if one
    // ever does, keep the historical behavior: forward the text verbatim.
    return send(text)
  }
  // Plugin command. The raw-line fallback is reserved for names that are no
  // longer in the plugin command table (uninstalled between enqueue and
  // flush) or a vanished service — the same unknown-slash fall-through
  // philosophy as the submit path. A name that IS still registered but fails
  // ({ok:false} or reject) must never reach the model as raw slash text: it
  // surfaces a notice instead and the queued line is dropped.
  const plugins = rt.ctx.get('ccPlugins') as CcPluginsRunLike | undefined
  if (plugins === undefined || typeof plugins.runPluginCommand !== 'function') {
    return send(text)
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
      if (!stillListed()) return send(text)
      const reason = (result as { reason?: string }).reason ?? 'unknown error'
      return failWithNotice(reason)
    })
    .catch((error: unknown) => {
      if (!stillListed()) return send(text)
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
    const handedOff = pending.map(text => dispatchQueued(rt, text, 'followup'))
    // Anchor the followup turn only once we know at least one entry was
    // actually handed off: an all-dropped flush (e.g. a plugin command that
    // failed with a notice) must not leave a zombie busy spinner behind.
    void Promise.all(handedOff).then(results => {
      if (!results.some(Boolean)) return
      rt.emit(setTurnActive(setBusy(rt.state(), true), { startedAt: Date.now(), outputBase: s.hud?.tokens?.output }))
    })
  }
  // Await the agent that ENDED the turn (captured now); dispatchQueued reads
  // rt.current.agent at fire time, so a session switch still targets the
  // live session. A rejected whenIdle must not strand the queue.
  const endingAgent = rt.current.agent as { whenIdle?: () => Promise<void> }
  if (typeof endingAgent.whenIdle === 'function') {
    void endingAgent.whenIdle().then(flush, flush)
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
  const pending = [...s.queued]
  if (pending.length === 0) return
  for (const text of pending) {
    // Semantic trade-off: a queued plugin command reaches the running turn as
    // a followup (queued work) rather than a steer — running it through the
    // plugin seam is more important than steering semantics.
    void dispatchQueued(rt, text, 'steer')
  }
  rt.emit(clearQueue(s))
}

/**
 * Recall for editing: pop the most recent queued entry back out of the outbox
 * and hand it to the caller (root.ts puts it into the composer). Race-free by
 * construction — flush and steer always clear synchronously, so the queue only
 * ever holds entries that were never sent.
 */
const recallQueued = (rt: DriverQueueCtx): string | undefined => {
  const popped = popQueued(rt.state())
  if (popped.text === undefined) return undefined
  rt.emit(popped.state)
  return popped.text
}

const submit = async (rt: DriverQueueCtx, text?: string): Promise<void> => {
  const draft = text ?? rt.state().draft
  if (draft.trim().length === 0) return
  rt.emit(setDraft(rt.state(), ''))
  // A leading `!` marks a LOCAL shell command no matter how the text was
  // entered — typed in shell mode or pasted wholesale. It runs even while
  // the agent is busy (a local command never touches the turn) and is neither
  // a prompt nor a slash command.
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
  // Persist the prompt (not slash commands — they are commands, not prompts,
  // and would dilute the recall signal; an unknown slash IS a prompt and
  // persists here via the fall-through above). Consecutive duplicates and the
  // cap are handled inside saveHistory. This is also the first real-content
  // signal: mark the session so the launcher can resume it.
  rt.setHistory(saveHistory([...rt.getHistory(), draft], rt.historyDir))
  rt.setMarkedContent(true)
  rt.persistResumeTarget()
  const s = rt.state()
  if (s.busy) {
    // Outbox: park the text as a pending chip only. It reaches the agent on
    // the next durable `turn/end` (flushQueue) or immediately via Ctrl+S
    // (steerQueued). No injection into the running turn here — that is what
    // makes recall-then-edit meaningful.
    rt.emit(enqueue(s, draft))
    return
  }
  // Idle sends bypass the outbox entirely — the row surfaces from the durable
  // `user/message` event, and a sent text must not stay recallable.
  rt.current.agent.followup(createUserMessage({
    content: [{ type: 'text', text: draft }],
    source: { kind: 'user' },
  }))
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
  submit(text?: string): Promise<void>
  interrupt(): void
} {
  return {
    flushQueue: () => flushQueue(rt),
    steerQueued: () => steerQueued(rt),
    recallQueued: () => recallQueued(rt),
    submit: (text) => submit(rt, text),
    interrupt: () => interrupt(rt),
  }
}
