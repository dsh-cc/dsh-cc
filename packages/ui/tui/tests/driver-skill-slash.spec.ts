import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDriver } from '@dsh-cc/tui/harness/driver.ts'
import { loadHistory } from '@dsh-cc/tui/history.ts'

/**
 * Submit routing for slash lines: known harness commands (success or error)
 * stay in the command plane, an UNKNOWN name falls through to the user-prompt
 * path (source.kind === 'user' so dsh-tool-skill's pre-step gesture boundary
 * can inject <skill_content>), bare `/` is refused, and the no-registry case
 * keeps its notice without falling through.
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
    session: { id: 's-skill', header: {}, events: [] },
    id: 'a-skill',
    status,
    followup: vi.fn(),
    steer: vi.fn(),
    cancel: vi.fn(),
  }
}

function makeCtx(
  agent: FakeAgent,
  opts: {
    execute?: (line: string) => Promise<{ result?: { kind: string; text?: string } } | undefined>
    withCommands?: boolean
  } = {},
): { ctx: Record<string, unknown> } {
  const ctx: Record<string, unknown> = {
    get(key: string) {
      if (key === 'agentPresets') {
        return {
          defaultId: 'cc',
          resolve: async () => ({ id: 'cc' }),
          mount: async () => ({ id: 'cc' }),
        }
      }
      if (key === 'commands' && opts.withCommands !== false) {
        return {
          list: () => [
            { name: 'status', description: 'harness status' },
            { name: 'permissions', description: 'rules', input: { hint: '[mode]' } },
          ],
          execute: async (_agent: unknown, line: string) => {
            if (opts.execute !== undefined) return opts.execute(line)
            if (line === '/status') return { result: { kind: 'success', text: 'ok' } }
            return undefined
          },
        }
      }
      return undefined
    },
    on: () => () => {},
    agents: {
      create: async () => ({ agent, dispose: async () => {} }),
      resume: async () => ({ agent, dispose: async () => {} }),
    },
  }
  return { ctx }
}

const sentMessages = (agent: FakeAgent): { text: string; source: unknown }[] =>
  agent.followup.mock.calls.map(call => {
    const message = call[0] as { content?: readonly { type?: string; text?: string }[]; source?: unknown }
    return {
      text: (message.content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join(''),
      source: message.source,
    }
  })

describe('createDriver skill slash submit routing', () => {
  let prevHome: string | undefined
  let tempHome: string
  let historyDir: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-skill-slash-'))
    historyDir = join(tempHome, 'hist')
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  it('known harness command with a success result does not fall through', async () => {
    const agent = makeFakeAgent('idle')
    const { ctx } = makeCtx(agent, { execute: async () => ({ result: { kind: 'success', text: 'ok' } }) })
    const driver = await createDriver(ctx as never, { historyDir })
    await driver.submit('/status')
    expect(agent.followup).not.toHaveBeenCalled()
    expect(driver.promptHistory).toEqual([])
    expect(loadHistory(historyDir)).toEqual([])
  })

  it('known command returning an ERROR result still does not fall through', async () => {
    const agent = makeFakeAgent('idle')
    const { ctx } = makeCtx(agent, { execute: async () => ({ result: { kind: 'error', text: 'boom' } }) })
    const driver = await createDriver(ctx as never, { historyDir })
    await driver.submit('/status')
    expect(agent.followup).not.toHaveBeenCalled()
    expect(driver.promptHistory).toEqual([])
  })

  it('unknown slash falls through as a user prompt with the full line and persists', async () => {
    const agent = makeFakeAgent('idle')
    const { ctx } = makeCtx(agent) // default execute returns undefined for unknowns
    const driver = await createDriver(ctx as never, { historyDir })
    await driver.submit('/unknown-skill-name extra')
    expect(agent.followup).toHaveBeenCalledOnce()
    const sent = sentMessages(agent)[0]!
    expect(sent.text).toBe('/unknown-skill-name extra')
    expect(sent.source).toEqual({ kind: 'user' })
    // Persisted as a prompt.
    expect(driver.promptHistory).toEqual(['/unknown-skill-name extra'])
    expect(loadHistory(historyDir)).toEqual(['/unknown-skill-name extra'])
  })

  it('busy unknown slash enqueues without steering or followup', async () => {
    const agent = makeFakeAgent('running')
    const { ctx } = makeCtx(agent)
    const driver = await createDriver(ctx as never, { historyDir })
    await driver.submit('/unknown-skill')
    expect(agent.steer).not.toHaveBeenCalled()
    expect(agent.followup).not.toHaveBeenCalled()
    expect(driver.state.queued).toEqual(['/unknown-skill'])
  })

  it('bare /permissions still opens the picker without followup', async () => {
    const agent = makeFakeAgent('idle')
    const { ctx } = makeCtx(agent)
    const driver = await createDriver(ctx as never, { historyDir })
    await driver.submit('/permissions')
    expect(agent.followup).not.toHaveBeenCalled()
    expect(driver.state.permissionPicker).toBeDefined()
  })

  it('bare / shows a notice and does not fall through', async () => {
    const agent = makeFakeAgent('idle')
    const { ctx } = makeCtx(agent)
    const driver = await createDriver(ctx as never, { historyDir })
    await driver.submit('/')
    expect(agent.followup).not.toHaveBeenCalled()
    expect(driver.state.notice).toBeDefined()
  })

  it('no commands service: unknown slash does not follow through (null-stop)', async () => {
    const agent = makeFakeAgent('idle')
    const { ctx } = makeCtx(agent, { withCommands: false })
    const driver = await createDriver(ctx as never, { historyDir })
    await driver.submit('/foo')
    expect(agent.followup).not.toHaveBeenCalled()
    expect(driver.state.notice).toBeDefined()
  })
})
