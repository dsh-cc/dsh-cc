import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDriver } from '@dsh-cc/tui/harness/driver.ts'
import type { PastedImage } from '@dsh-cc/pi-tui'

/**
 * Composer -> agent image threading (plan 3.4-3.7): the images the editor
 * captured at paste time must reach `agent.followup`/`agent.steer` as image
 * blocks, at BOTH dispatch sites (the idle submit and the outbox flush), with
 * the `[Image #N]` markers stripped from the prose and every failure degrading
 * to a text-only prompt plus a notice.
 *
 * The fake ctx/agent pair mirrors driver-busy.spec.ts / driver-queue-reconcile.spec.ts
 * (the established doubles for the cordis context and the agent object), plus a
 * fake `attachments` service. The store is a double, not a reimplementation:
 * `saveImage` mints one durable ref per admitted image in call order, which is
 * exactly the contract the driver depends on (validation and normalization
 * belong to the provider, dsh-attachment).
 */

interface FakeAgent extends Record<string, unknown> {
  options: Record<string, unknown>
  session: { id: string; header: Record<string, unknown>; events: unknown[] }
  id: string
  status: string
  followup: ReturnType<typeof vi.fn>
  steer: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
}

function makeFakeAgent(status: string): FakeAgent {
  return {
    options: {},
    session: { id: 's-image', header: {}, events: [], snapshotEvents() { return this.events } },
    id: 'a-image',
    status,
    followup: vi.fn(),
    steer: vi.fn(),
    cancel: vi.fn(),
  }
}

/** The attachments double: one minted ref per call, in call order. */
interface FakeStore {
  saveImage: (input: { data: Uint8Array; mediaType: string; name?: string }) => Promise<unknown>
  calls: { data: Uint8Array; mediaType: string; name?: string }[]
  refs: Record<string, unknown>[]
  /** When set, every saveImage call rejects with this message. */
  failWith?: string
}

function makeStore(): FakeStore {
  const store: FakeStore = {
    calls: [],
    refs: [],
    async saveImage(input) {
      store.calls.push(input)
      if (store.failWith !== undefined) throw new Error(store.failWith)
      // Mirrors dsh-attachment's ref: identity comes from the stored bytes, so
      // the driver must pass the provider's ref through untouched.
      const ref = {
        attachmentId: `sha256:${String(store.refs.length).padStart(64, '0')}`,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 3,
        height: 2,
      }
      store.refs.push(ref)
      return ref
    },
  }
  return store
}

/**
 * The llm metadata seam the §3.7 gate reads. Complete enough for the driver's
 * boot path (the /model catalog seams and the /effort validation both come
 * through this service), like the stubs in driver-model/driver-effort specs.
 */
interface LlmStub {
  listProviders(): { id: string }[]
  listModels(provider: string): Promise<{ provider: string; id: string; name: string }[]>
  resolveModelInfo: (provider: string, model: string) => Promise<{ inputModalities?: readonly string[] }>
}

function makeLlm(info: { inputModalities?: readonly string[] }): LlmStub {
  return {
    listProviders: () => [],
    listModels: async () => [],
    resolveModelInfo: async () => info,
  }
}

interface CtxOptions {
  store?: FakeStore
  llm?: LlmStub
}

function makeCtx(agent: FakeAgent, opts: CtxOptions = {}): {
  ctx: Record<string, unknown>
  getKeys: string[]
  emitSession: (event: unknown) => void
} {
  const sessionHandlers = new Set<(session: unknown, event: unknown) => void>()
  const getKeys: string[] = []
  const ctx: Record<string, unknown> = {
    get(key: string) {
      // Recorded so the image-free path can be pinned as lookup-free.
      getKeys.push(key)
      if (key === 'agentPresets') {
        return {
          defaultId: 'cc',
          resolve: async () => ({ id: 'cc' }),
          mount: async () => ({ id: 'cc' }),
        }
      }
      if (key === 'attachments') return opts.store
      if (key === 'llm') return opts.llm
      return undefined
    },
    on(event: string, handler: (...args: unknown[]) => void) {
      if (event === 'session/event') {
        const fn = handler as (session: unknown, event: unknown) => void
        sessionHandlers.add(fn)
        return () => { sessionHandlers.delete(fn) }
      }
      return () => {}
    },
    agents: {
      // Mirror the harness: createDriver hands the explicit provider/model
      // override to the agent, and the boot seed reads it back off
      // agent.options (driver-agent.seedDefaultModel). The route gate depends on
      // that round trip, so the double must honor it rather than fake it.
      create: async (options: unknown) => {
        Object.assign(agent.options, (options as { agentOptions?: Record<string, unknown> } | undefined)?.agentOptions ?? {})
        return { agent, dispose: async () => {} }
      },
      resume: async () => ({ agent, dispose: async () => {} }),
    },
  }
  return {
    ctx,
    getKeys,
    emitSession: (event: unknown) => {
      for (const handler of sessionHandlers) handler(agent.session, event)
    },
  }
}

/** Let the microtask-deferred outbox flush (and its admission) settle. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

type SentBlock = { type?: string; text?: string; attachment?: { attachmentId?: unknown } }

/** Content blocks of the message handed to followup/steer at `index`. */
const blocksOf = (calls: readonly unknown[][], index = 0): readonly SentBlock[] => {
  const message = calls[index]?.[0] as { content?: readonly SentBlock[] } | undefined
  return message?.content ?? []
}

const blockTypes = (calls: readonly unknown[][], index = 0): (string | undefined)[] =>
  blocksOf(calls, index).map(block => block.type)

/** Joined text blocks of every dispatch, so order is assertable. */
const sentTexts = (calls: readonly unknown[][]): string[] =>
  calls.map(call => blocksOf([call]).filter(block => block.type === 'text').map(block => block.text ?? '').join(''))

/**
 * Real 3x2 PNG bytes (the fixture clipboard-image.spec.ts validates with), so
 * the spilled file the driver reads is a real image rather than a placeholder.
 */
const PNG_3X2 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAG0lEQVR4nGNgYDjxPwCIFwAxA0MFkAPEC4AYAJ91DfM4bJ6DAAAAAElFTkSuQmCC',
  'base64',
)

describe('createDriver image submission threading', () => {
  let prevHome: string | undefined
  let tempHome: string
  let spillDir: string
  let spillCounter = 0

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-driver-image-'))
    spillDir = mkdtempSync(join(tmpdir(), 'dsh-driver-image-spill-'))
    spillCounter = 0
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  /** A spilled clipboard image: a real file on disk plus the handle the editor hands over. */
  const spilledImage = (): PastedImage => {
    spillCounter += 1
    const path = join(spillDir, `${spillCounter}-image.png`)
    writeFileSync(path, PNG_3X2)
    return { path, mediaType: 'image/png', width: 3, height: 2 }
  }

  it('idle submit dispatches image blocks in capture order, then the stripped prose', async () => {
    const agent = makeFakeAgent('idle')
    const store = makeStore()
    const { ctx } = makeCtx(agent, { store })
    const driver = await createDriver(ctx as never, { cwd: tempHome, branchProbe: async () => undefined })

    const first = spilledImage()
    const second = spilledImage()
    await driver.submit('look at [Image #1 3x2] then [Image #2 3x2]', [first, second])

    expect(blockTypes(agent.followup.mock.calls)).toEqual(['image', 'image', 'text'])
    expect(sentTexts(agent.followup.mock.calls)).toEqual(['look at then'])
    expect(store.calls).toHaveLength(2)
    // Both spilled files were read: same bytes here, but two separate reads
    // (content-addressing is the provider's business, not the driver's).
    expect(store.calls.map(call => call.mediaType)).toEqual(['image/png', 'image/png'])
    // The refs travel through untouched - the provider verifies the digest of
    // the stored bytes at read time, so a hand-built ref would fail the turn.
    expect(blocksOf(agent.followup.mock.calls)[0]?.attachment).toBe(store.refs[0])
    expect(blocksOf(agent.followup.mock.calls)[1]?.attachment).toBe(store.refs[1])
    expect(driver.state.notice).toBeUndefined()
  })

  it('a queued submission keeps its images across the busy path, and the flush dispatches them', async () => {
    const agent = makeFakeAgent('running')
    const store = makeStore()
    const { ctx, emitSession } = makeCtx(agent, { store })
    const driver = await createDriver(ctx as never, { cwd: tempHome, branchProbe: async () => undefined })

    const image = spilledImage()
    await driver.submit('queued [Image #1 3x2]', [image])

    // The chip carries the images (plan 3.5); admission is deferred to
    // dispatch, so nothing has been saved yet.
    expect(driver.state.queued).toEqual([{ text: 'queued [Image #1 3x2]', images: [image] }])
    expect(store.calls).toEqual([])
    expect(agent.followup).not.toHaveBeenCalled()

    emitSession({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await settle()

    expect(blockTypes(agent.followup.mock.calls)).toEqual(['image', 'text'])
    expect(sentTexts(agent.followup.mock.calls)).toEqual(['queued'])
    expect(blocksOf(agent.followup.mock.calls)[0]?.attachment).toBe(store.refs[0])
    expect(driver.state.queued).toEqual([])
  })

  it('Ctrl+S steers a queued chip with its images', async () => {
    const agent = makeFakeAgent('running')
    const store = makeStore()
    const { ctx } = makeCtx(agent, { store })
    const driver = await createDriver(ctx as never, { cwd: tempHome, branchProbe: async () => undefined })

    await driver.submit('jump [Image #1 3x2]', [spilledImage()])
    driver.steerQueued()
    await settle()

    expect(blockTypes(agent.steer.mock.calls)).toEqual(['image', 'text'])
    expect(sentTexts(agent.steer.mock.calls)).toEqual(['jump'])
    expect(driver.state.queued).toEqual([])
  })

  it('two queued submissions keep their own images and FIFO order across a flush', async () => {
    const agent = makeFakeAgent('running')
    const store = makeStore()
    const { ctx, emitSession } = makeCtx(agent, { store })
    const driver = await createDriver(ctx as never, { cwd: tempHome, branchProbe: async () => undefined })

    const first = spilledImage()
    const second = spilledImage()
    // The second entry is image-free: its dispatch must not overtake the first
    // one's admission.
    await driver.submit('one [Image #1 3x2]', [first])
    await driver.submit('two')

    emitSession({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await settle()

    expect(sentTexts(agent.followup.mock.calls)).toEqual(['one', 'two'])
    expect(blockTypes(agent.followup.mock.calls, 0)).toEqual(['image', 'text'])
    expect(blockTypes(agent.followup.mock.calls, 1)).toEqual(['text'])
    expect(blocksOf(agent.followup.mock.calls, 0)[0]?.attachment).toBe(store.refs[0])
  })

  it('an image-only submission sends no empty text block', async () => {
    const agent = makeFakeAgent('idle')
    const store = makeStore()
    const { ctx } = makeCtx(agent, { store })
    const driver = await createDriver(ctx as never, { cwd: tempHome, branchProbe: async () => undefined })

    await driver.submit('[Image #1 3x2]', [spilledImage()])

    expect(blockTypes(agent.followup.mock.calls)).toEqual(['image'])
  })

  it('a missing attachments service still sends the text, marker stripped, with a notice', async () => {
    const agent = makeFakeAgent('idle')
    const { ctx, getKeys } = makeCtx(agent)
    const driver = await createDriver(ctx as never, { cwd: tempHome, branchProbe: async () => undefined })

    await driver.submit('no service [Image #1 3x2]', [spilledImage()])

    expect(getKeys).toContain('attachments')
    expect(blockTypes(agent.followup.mock.calls)).toEqual(['text'])
    expect(sentTexts(agent.followup.mock.calls)).toEqual(['no service'])
    expect(driver.state.notice).toBe('Image not attached: no attachments service is mounted.')
  })

  it('a refused save still sends the text, marker stripped, with a notice', async () => {
    const agent = makeFakeAgent('idle')
    const store = makeStore()
    store.failWith = 'attachment store is full'
    const { ctx } = makeCtx(agent, { store })
    const driver = await createDriver(ctx as never, { cwd: tempHome, branchProbe: async () => undefined })

    await driver.submit('keep my words [Image #1 3x2]', [spilledImage()])

    expect(blockTypes(agent.followup.mock.calls)).toEqual(['text'])
    expect(sentTexts(agent.followup.mock.calls)).toEqual(['keep my words'])
    expect(driver.state.notice).toBe('Image not attached: the pasted image could not be saved.')
  })

  it('one refused image of two still attaches the other and names the count', async () => {
    const agent = makeFakeAgent('idle')
    const store = makeStore()
    const { ctx } = makeCtx(agent, { store })
    const driver = await createDriver(ctx as never, { cwd: tempHome, branchProbe: async () => undefined })

    const good = spilledImage()
    // A marker whose spilled file is gone: the read fails before saveImage.
    const gone: PastedImage = { path: join(spillDir, 'never-written.png'), mediaType: 'image/png', width: 3, height: 2 }
    await driver.submit('mixed [Image #1 3x2] [Image #2 3x2]', [good, gone])

    expect(blockTypes(agent.followup.mock.calls)).toEqual(['image', 'text'])
    expect(sentTexts(agent.followup.mock.calls)).toEqual(['mixed'])
    expect(store.calls).toHaveLength(1)
    expect(driver.state.notice).toBe('Image not attached: 1 of 2 images could not be saved.')
  })

  it('a route whose model declares no image input is refused before admission, naming the model', async () => {
    const agent = makeFakeAgent('idle')
    const store = makeStore()
    const llm = makeLlm({ inputModalities: ['text'] })
    const { ctx } = makeCtx(agent, { store, llm })
    const driver = await createDriver(ctx as never, {
      cwd: tempHome,
      provider: 'deepseek',
      model: 'deepseek-chat',
      branchProbe: async () => undefined,
    })

    await driver.submit('vision please [Image #1 3x2]', [spilledImage()])

    expect(blockTypes(agent.followup.mock.calls)).toEqual(['text'])
    expect(sentTexts(agent.followup.mock.calls)).toEqual(['vision please'])
    expect(driver.state.notice).toBe('Image not attached: deepseek-chat does not declare image input.')
    // The gate runs before admission, so nothing was written to the store.
    expect(store.calls).toEqual([])
  })

  it('an unknown image capability proceeds optimistically (absent modalities are not a verdict)', async () => {
    const agent = makeFakeAgent('idle')
    const store = makeStore()
    const llm = makeLlm({})
    const { ctx } = makeCtx(agent, { store, llm })
    const driver = await createDriver(ctx as never, {
      cwd: tempHome,
      provider: 'deepseek',
      model: 'deepseek-chat',
      branchProbe: async () => undefined,
    })

    await driver.submit('maybe [Image #1 3x2]', [spilledImage()])

    expect(blockTypes(agent.followup.mock.calls)).toEqual(['image', 'text'])
    expect(driver.state.notice).toBeUndefined()
  })

  it('recalling an image-bearing chip strips its markers and says the image is not restored', async () => {
    const agent = makeFakeAgent('running')
    const store = makeStore()
    const { ctx } = makeCtx(agent, { store })
    const driver = await createDriver(ctx as never, { cwd: tempHome, branchProbe: async () => undefined })

    await driver.submit('recalled [Image #1 3x2]', [spilledImage()])

    expect(driver.recallQueued()).toBe('recalled')
    expect(driver.state.queued).toEqual([])
    expect(driver.state.notice).toBe('Image not restored with the recalled text; paste it again to re-attach.')
  })

  it('an image-free submit is byte-identical to the pre-feature path (no lookup, no notice)', async () => {
    const agent = makeFakeAgent('idle')
    const store = makeStore()
    const { ctx, getKeys } = makeCtx(agent, { store })
    const driver = await createDriver(ctx as never, { cwd: tempHome, branchProbe: async () => undefined })

    await driver.submit('plain prompt')

    // The regression pin: exactly the single text block the composer always sent.
    expect(blocksOf(agent.followup.mock.calls)).toEqual([{ type: 'text', text: 'plain prompt' }])
    expect(sentTexts(agent.followup.mock.calls)).toEqual(['plain prompt'])
    expect(driver.state.notice).toBeUndefined()
    expect(store.calls).toEqual([])
    // Neither the attachment service nor the llm metadata is consulted.
    expect(getKeys).not.toContain('attachments')
    expect(getKeys).not.toContain('llm')
  })

  it('a queued image-free chip stores no images field and dispatches unchanged', async () => {
    const agent = makeFakeAgent('running')
    const store = makeStore()
    const { ctx, emitSession } = makeCtx(agent, { store })
    const driver = await createDriver(ctx as never, { cwd: tempHome, branchProbe: async () => undefined })

    await driver.submit('busy text')
    expect(driver.state.queued).toEqual([{ text: 'busy text' }])

    emitSession({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await settle()

    expect(blocksOf(agent.followup.mock.calls)).toEqual([{ type: 'text', text: 'busy text' }])
    expect(store.calls).toEqual([])
    expect(driver.state.notice).toBeUndefined()
  })
})
