# acp-prompt-lifecycle — code anchors

Verbatim excerpts of every cited production and test range, captured at
worktree commit 6ec11022 (branch tla-modeling, this worktree). This file
exists so design.md citation markers point at in-repo markdown evidence
(the citation whitelist admits `*.md` targets only); the authoritative
sources are the paths named in each excerpt header.

## Production: packages/acp/cc-acp/src/session.ts

### session.ts:64-78 — InflightPrompt record 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L11-L29〕

```ts
interface InflightPrompt {
  resolve: (reason: StopReason) => void
  reject: (error: Error) => void
  messageId: string | undefined
  messageQueued: boolean
  turn: number | undefined
  endReason: TurnEndReason | undefined
  admissionDone: Promise<void>
  finishAdmission: () => void
  admissionController: AbortController
  cancelRequested: boolean
  settlementStarted: boolean
  outputError: Error | undefined
  agentError: Error | undefined
}
```

### session.ts:114-121 — per-session slot state 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L31-L42〕

```ts
export class AcpSession {
  /** The exact top-level Agent owned by this ACP session. */
  readonly agent: Agent
  private readonly modelControl: AcpModelControl
  private outputTail = Promise.resolve()
  private inflight: InflightPrompt | undefined
  private closing: Promise<void> | undefined
  private readonly pendingSelections = new Map<string, ModelSelection>()
```

### session.ts:277-306 — prompt() head: single-slot guard and abort wiring 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L44-L75〕

```ts
  async prompt(
    params: PromptRequest,
    imageEnabled: boolean,
    requestSignal?: AbortSignal,
  ): Promise<PromptResponse> {
    this.assertActive()
    if (this.inflight !== undefined) throw invalidParams('a prompt is already in flight for this session')
    const completion = Promise.withResolvers<StopReason>()
    const admission = Promise.withResolvers<void>()
    const admissionController = new AbortController()
    const inflight: InflightPrompt = {
      resolve: completion.resolve,
      reject: completion.reject,
      messageId: undefined,
      messageQueued: false,
      turn: undefined,
      endReason: undefined,
      admissionDone: admission.promise,
      finishAdmission: admission.resolve,
      admissionController,
      cancelRequested: false,
      settlementStarted: false,
      outputError: undefined,
      agentError: undefined,
    }
    this.inflight = inflight
    const onRequestAbort = (): void => { this.cancelPrompt('ACP prompt request cancelled') }
    requestSignal?.addEventListener('abort', onRequestAbort, { once: true })
```

### session.ts:307-343 — admission: abort guard, then queue+followup in one synchronous block 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L77-L117〕

```ts
    try {
      let admissionFailure: unknown
      const promptSelection = this.modelControl.snapshot()
      try {
        if (this.ctx.agents.get(this.agent.id) !== this.agent) {
          throw internalError('prompt was not queued: the agent was disposed outside the bridge')
        }
        const content = await admitAcpPrompt(
          this.ctx,
          promptSelection,
          params.prompt,
          imageEnabled,
          admissionController.signal,
        )
        admissionController.signal.throwIfAborted()
        if (this.ctx.agents.get(this.agent.id) !== this.agent) {
          throw internalError('prompt was not queued: the agent was disposed outside the bridge')
        }
        const message = createUserMessage({
          content,
          source: { kind: 'user' },
        })
        inflight.messageId = message.id
        inflight.messageQueued = true
        if (promptSelection !== undefined) this.pendingSelections.set(message.id, promptSelection)
        try {
          this.agent.followup(message)
        } catch (error: unknown) {
          inflight.messageQueued = false
          this.pendingSelections.delete(message.id)
          throw error
        }
      } catch (error: unknown) {
        admissionFailure = error
      } finally {
        inflight.finishAdmission()
      }
```

### session.ts:345-365 — cancel-before-failure precedence and slot freeing on admission failure 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L119-L143〕

```ts
      if (inflight.cancelRequested) {
        this.settleAfterQuiescence(inflight)
        return { stopReason: await completion.promise }
      }
      if (admissionFailure !== undefined) {
        this.inflight = undefined
        if (admissionFailure instanceof AcpContentError) {
          throw admissionFailure.kind === 'invalid'
            ? invalidParams(admissionFailure.message)
            : internalError(admissionFailure.message)
        }
        if (admissionFailure instanceof RequestError) throw admissionFailure
        throw internalError(`prompt was not queued: ${(admissionFailure as Error).message}`)
      }

      this.settleAfterQuiescence(inflight)
      return { stopReason: await completion.promise }
    } finally {
      requestSignal?.removeEventListener('abort', onRequestAbort)
    }
  }
```

### session.ts:367-372 — cancel(): inflight first, autonomous work only when idle 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L145-L154〕

```ts
  /** Cancel the active prompt, or autonomous work when no ACP prompt exists. */
  cancel(): void {
    const inflight = this.inflight
    this.cancelPrompt('ACP prompt cancelled')
    if (inflight === undefined) this.agent.cancel({ kind: 'user' })
  }
```

### session.ts:379-423 — onSessionEvent: ordered updates, matching-turn end correlation 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L156-L185〕

```ts
  onSessionEvent(session: Session, event: SessionEvent): void {
    try {
      if (event.type === 'assistant/message') {
        const inflight = this.inflight?.turn === event.data.turn ? this.inflight : undefined
        const previous = this.outputTail
        const delivery = previous.then(async () => {
          for (const update of await assistantUpdates(this.ctx, session, event)) {
            await this.notify({ sessionId: this.agent.session.id, update })
          }
        })
        this.outputTail = delivery.catch((error: unknown) => {
          const failure = error as Error
          if (inflight !== undefined) inflight.outputError ??= failure
          this.ctx.logger.warn(`acp: assistant output conversion failed: ${errorChain(error)}`)
        })
      } else if (event.type === 'tool/call') {
```
```ts
    } finally {
      const inflight = this.inflight
      if (inflight !== undefined && event.type === 'turn/end' && inflight.turn === event.data.turn) {
        inflight.endReason = event.data.reason
      }
      if (event.type === 'turn/end') this.modelControl.releaseTurn(event.data.turn)
    }
  }
```

### session.ts:430-450 — onInboxClaimed and onAgentError guards 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L187-L207〕

```ts
  onInboxClaimed(message: UserMessage, turn: number): void {
    if (this.inflight !== undefined && this.inflight.messageId === message.id) this.inflight.turn = turn
    const selection = this.pendingSelections.get(message.id)
    this.pendingSelections.delete(message.id)
    if (selection !== undefined) this.modelControl.pinTurn(turn, selection)
  }
```
```ts
  onAgentError(turn: number, error: unknown): void {
    const inflight = this.inflight
    if (inflight === undefined || !inflight.messageQueued) return
    // AgentLoop balances an in-turn failure with durable turn/end; settlement
    // reads that exact error reason. This slot records interval failures outside it.
    if (inflight.turn === turn) return
    inflight.agentError = new Error(errorChain(error))
    this.settleAfterQuiescence(inflight)
  }
```

### session.ts:462-502 — close(): memoized teardown 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L209-L226〕

```ts
  close(detail: string): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.closing = (async () => {
      const failures: unknown[] = []
      const inflight = this.inflight
      this.cancelPrompt(detail)
      if (inflight === undefined || !inflight.messageQueued) this.agent.cancel({ kind: 'user' })
      try {
        await inflight?.admissionDone
        await this.agent.whenIdle()
        await this.outputTail
      } catch (error: unknown) {
        failures.push(new Error('ACP session activity drain failed', { cause: error }))
      }
```

### session.ts:504-515 — assertActive / cancelPrompt 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L228-L243〕

```ts
  private assertActive(): void {
    if (this.closing !== undefined) throw invalidParams(`session is closing: ${this.agent.session.id}`)
  }

  private cancelPrompt(detail: string): void {
    const inflight = this.inflight
    if (inflight === undefined) return
    inflight.cancelRequested = true
    inflight.admissionController.abort(new Error(detail))
    this.settleAfterQuiescence(inflight)
    if (inflight.messageQueued) this.agent.cancel({ kind: 'user' })
  }
```

### session.ts:517-557 — settleAfterQuiescence: one-shot settlement with the precedence chain 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L245-L281〕

```ts
  private settleAfterQuiescence(inflight: InflightPrompt): void {
    if (inflight.settlementStarted) return
    inflight.settlementStarted = true
    void (async () => {
      await inflight.admissionDone
      if (inflight.messageQueued) {
        await this.agent.whenIdle()
        await this.outputTail
      }
      /* v8 ignore next -- this prompt owns the slot until this exact settlement clears it. */
      if (this.inflight !== inflight) return
      this.inflight = undefined
      if (inflight.cancelRequested) {
        inflight.resolve('cancelled')
        return
      }
      if (inflight.outputError !== undefined) {
        inflight.reject(internalError(`assistant output delivery failed: ${inflight.outputError.message}`))
        return
      }
      if (inflight.agentError !== undefined) {
        inflight.reject(internalError(`turn failed: ${inflight.agentError.message}`))
        return
      }
      const end = inflight.endReason
      if (end === undefined) {
        inflight.resolve('cancelled')
      } else if (end.kind === 'error') {
        inflight.reject(internalError(`turn failed: ${end.error.message}`))
      } else {
        inflight.resolve(turnEndToStopReason(end))
      }
    })()
```

## Production: packages/acp/cc-acp/src/codec.ts

### codec.ts:18-38 — turnEndToStopReason 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L285-L308〕

```ts
export function turnEndToStopReason(reason: TurnEndReason): StopReason {
  switch (reason.kind) {
    case 'completed':
      return 'end_turn'
    case 'max-tokens':
      return 'max_tokens'
    // `cancelled` is reserved for explicit client cancellation (`session/cancel`)
    // and disposal, both settled out of band; a turn aborted by a hook or
    // another owner is ordinary quiescence and reports `end_turn`.
    case 'aborted':
      return 'end_turn'
    case 'interrupted':
      return 'cancelled'
    case 'blocked':
    case 'error':
      return 'end_turn'
    default:
      return 'end_turn'
  }
}
```

## Production: packages/acp/cc-acp/src/index.ts

### index.ts:192-205 — bridge event wiring (ownership filtering) 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L312-L325〕

```ts
ctx.on('session/event', (session, event) => {
```
```ts
ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
```
```ts
ctx.on('agent/error', ({ agent, turn, error }) => {
```

(Wiring excerpted by grep; the handlers delegate to the owned AcpSession 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L312-L327〕
only after an exact agent/session identity check — see session.ts:210-221.)

## Regression tests: packages/acp/cc-acp/tests/turns.spec.ts

### turns.spec.ts:266-275 — permits only one in-flight prompt per session 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L329-L342〕

```ts
  it('permits only one in-flight prompt per session', async () => {
    harness = await makeBridgeHarness({ script: ['hang'] })
    const sessionId = await newSession(harness)
    const first = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'one' }] })
    await vi.waitFor(() => { expect(harness!.ctx.agents.get(SessionId(sessionId))?.status).toBe('running') })
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'two' }] }))
      .rejects.toThrow(/already in flight/)
    await harness.client.cancel({ sessionId })
    await expect(first).resolves.toEqual({ stopReason: 'cancelled' })
  })
```

### turns.spec.ts:306-332 — cancel during image admission never queues a message 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L344-L374〕

```ts
  it('reserves the prompt slot during image admission and cancels without a late followup', async () => {
    harness = await makeBridgeHarness({ imageCapable: true, script: [] })
    const validationStarted = Promise.withResolvers<undefined>()
    const releaseValidation = Promise.withResolvers<undefined>()
    harness.attachments!.beforeValidate = () => {
      validationStarted.resolve(undefined)
      return releaseValidation.promise
    }
    const sessionId = await newSession(harness)
    let settled = false
    const first = harness.client.prompt({
      sessionId,
      prompt: [{ type: 'image', data: 'AQ==', mimeType: 'image/png' }],
    }).finally(() => { settled = true })
    await validationStarted.promise

    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'second' }] }))
      .rejects.toThrow(/already in flight/)
    await harness.client.cancel({ sessionId })
    expect(settled).toBe(false)
    releaseValidation.resolve(undefined)

    await expect(first).resolves.toEqual({ stopReason: 'cancelled' })
    expect(harness.adapter.requests).toEqual([])
    const events = harness.ctx.agents.get(SessionId(sessionId))?.session.snapshotEvents() ?? []
    expect(events.some(event => event.type === 'user/message' || event.type === 'turn/start')).toBe(false)
  })
```

### turns.spec.ts:334-363 — admission cancel does not cancel unrelated Agent work 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L376-L389〕

```ts
  it('does not cancel unrelated Agent work while its prompt is still in admission', async () => {
```
```ts
    expect(harness.adapter.requests[0]?.signal?.aborted).toBe(false)
    releaseValidation.resolve(undefined)
    await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' })
    expect(agent.status).toBe('running')
    agent.cancel({ kind: 'hook', reason: 'test cleanup' })
    await agent.whenIdle()
  })
```

### turns.spec.ts:365-396 — an unrelated failure during admission is not attributed 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L391-L400〕

```ts
  it('does not attribute an unrelated Agent failure during prompt admission', async () => {
```
```ts
    await expect(prompt).resolves.toEqual({ stopReason: 'end_turn' })
    expect(messageText(harness)).toBe('answer')
  })
```

### turns.spec.ts:398-419 — agent retired during storage: prompt not queued 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L402-L412〕

```ts
  it('does not queue admitted content into an agent retired during storage', async () => {
```
```ts
    await expect(prompt).rejects.toThrow(/disposed outside the bridge/)
    expect(harness.attachments!.saved).toHaveLength(1)
    expect(harness.adapter.requests).toEqual([])
  })
```

### turns.spec.ts:421-436 — cancellation in the admission-to-followup handoff gap 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L414-L426〕

```ts
  it('honors cancellation in the admission-to-followup handoff gap', async () => {
```
```ts
    await expect(harness.client.prompt({
      sessionId,
      prompt: [{ type: 'image', data: 'AQ==', mimeType: 'image/png' }],
    })).resolves.toEqual({ stopReason: 'cancelled' })
    expect(harness.adapter.requests).toEqual([])
  })
```

### turns.spec.ts:448-459 — cancel of a running turn records the aborted outcome 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L428-L443〕

```ts
  it('cancels a running turn and records the aborted outcome', async () => {
    harness = await makeBridgeHarness({ script: ['hang'] })
    const sessionId = await newSession(harness)
    const prompt = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    await vi.waitFor(() => { expect(agent.status).toBe('running') })
    await harness.client.cancel({ sessionId })
    await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' })
    await agent.whenIdle()
    expect(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason)
      .toEqual({ kind: 'aborted', reason: { kind: 'user' } })
  })
```

### turns.spec.ts:461-471 — a hook-cancelled turn settles end_turn, not cancelled 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L445-L459〕

```ts
  it('settles a hook-cancelled turn as end_turn, not cancelled', async () => {
    harness = await makeBridgeHarness({ script: ['hang'] })
    const sessionId = await newSession(harness)
    const prompt = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    await vi.waitFor(() => { expect(agent.status).toBe('running') })
    // A hook or another owner cancels the agent: the ACP client never called
    // session/cancel, so this is ordinary quiescence and reports end_turn.
    agent.cancel({ kind: 'hook', reason: 'owner intervention' })
    await expect(prompt).resolves.toEqual({ stopReason: 'end_turn' })
  })
```

### turns.spec.ts:501-514 — a late end from a cancelled turn cannot settle the next prompt 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L461-L478〕

```ts
  it('a late end from a cancelled turn cannot settle the next prompt', async () => {
    harness = await makeBridgeHarness({ script: ['hang', textResponse('next')] })
    const sessionId = await newSession(harness)
    const first = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'one' }] })
    await vi.waitFor(() => { expect(harness!.ctx.agents.get(SessionId(sessionId))?.status).toBe('running') })
    await harness.client.cancel({ sessionId })
    await expect(first).resolves.toEqual({ stopReason: 'cancelled' })

    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'two' }] }))
      .resolves.toEqual({ stopReason: 'end_turn' })
    // 'partial' is the cancelled turn's finalized prefix update; 'next' proves
    // the second prompt settled independently of the aborted turn's late end.
    await vi.waitFor(() => { expect(messageText(harness!)).toBe('partialnext') })
  })
```

### turns.spec.ts:532-540 — a failed turn with no retry still rejects 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L480-L492〕

```ts
  it('a failed turn with no retry still rejects', async () => {
    harness = await makeBridgeHarness({ script: [errorResponse('terminal boom')] })
    let offered = 0
    harness.ctx.on('agent/request-error', async () => { offered += 1 })
    const sessionId = await newSession(harness)
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }))
      .rejects.toThrow(/turn failed: terminal boom/)
    expect(offered).toBe(1)
  })
```

### turns.spec.ts:554-563 — a prompt removed before its turn claims it settles cancelled 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L494-L508〕

```ts
  it('cancels a prompt removed before its turn claims it', async () => {
    harness = await makeBridgeHarness({ script: [] })
    const sessionId = await newSession(harness)
    const dispose = harness.ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (message.source.kind === 'user') agent.inbox.remove(message.id)
    })

    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }))
      .resolves.toEqual({ stopReason: 'cancelled' })
    dispose()
  })
```

### turns.spec.ts:253-264 — a synchronous followup failure frees the slot 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L510-L525〕

```ts
  it('frees the prompt slot when the agent rejects the send synchronously', async () => {
    harness = await makeBridgeHarness({ script: [] })
    const sessionId = await newSession(harness)
    // Reload the loop out from under the bridge: its agents dispose while the
    // bridge record survives, so the next send() throws synchronously.
    await harness.loopFiber.dispose()
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'one' }] }))
      .rejects.toThrow(/prompt was not queued/)
    // The failed prompt must not wedge the session's single prompt slot.
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'two' }] }))
      .rejects.toThrow(/prompt was not queued/)
  })
```

### turns.spec.ts:107-131 — settlement waits for ordered output delivery 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L527-L540〕

```ts
  it('does not settle a prompt before ordered output delivery drains', async () => {
```
```ts
    const prompt = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
      .finally(() => { settled = true })
    await readStarted.promise
    expect(settled).toBe(false)
    delivery.resolve(undefined)
    await expect(prompt).resolves.toEqual({ stopReason: 'end_turn' })
  })
```

### turns.spec.ts:133-151 — output delivery failure rejects the prompt 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L542-L552〕

```ts
  it('fails prompt delivery when a committed image attachment is missing', async () => {
```
```ts
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'image', data: 'AQ==', mimeType: 'image/png' }] }))
      .rejects.toThrow(/assistant output delivery failed/)
    expect(harness.updates).toEqual([])
  })
```

### turns.spec.ts:211-236 — an autonomous message turn is ignored while correlating the client turn 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L554-L563〕

```ts
  it('ignores an autonomous message turn while correlating the client turn', async () => {
```
```ts
    await harness.client.cancel({ sessionId })
    await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' })
  })
```

## Regression tests: packages/acp/cc-acp/tests/edges.spec.ts

### edges.spec.ts:106-121 — foreign in-process producers' turns deliver updates but own no prompt 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L567-L576〕

```ts
  it('delivers output from a bridge-owned session driven by another in-process producer', async () => {
```
```ts
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'test' } }))
    await agent.whenIdle()
    await vi.waitFor(() => { expect(harness!.updates.at(-1)?.sessionUpdate).toBe('usage_update' })
```

### edges.spec.ts:93-104 — events from agents the bridge does not own are ignored 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L578-L586〕

```ts
  it('ignores events from agents the bridge does not own', async () => {
```
```ts
    expect(harness.updates).toHaveLength(0)
  })
```

## Toolchain and runner pins

### scripts/toolchain.json — TLC pin (entire file, at packages/plugin/dsh-cc-agents/skills/formal-design/scripts/toolchain.json) 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L590-L598〕

```json
{
  "version": "1.7.4",
  "downloadUrl": "https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar",
  "sha1": "bee4a54f3ee3d4afc347c3240ec2d9e93b075104"
}
```

### packages/plugin/dsh-cc-agents/package.json — runner package identity (lines 2-3) 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L600-L605〕

```json
  "name": "@dsh-cc/plugin-dsh-cc-agents",
  "version": "0.9.2-rc.1",
```
