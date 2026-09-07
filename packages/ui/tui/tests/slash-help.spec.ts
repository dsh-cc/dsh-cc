import { describe, expect, it } from 'vitest'
import { LOCAL_SLASH } from '@dsh-cc/tui/slash.ts'
import { localHelpFor } from '@dsh-cc/tui/slash-help.ts'
import { createDriver } from '@dsh-cc/tui/harness/driver.ts'

/**
 * Wave 2: trailing-`help` support for TUI-local slash commands. Every
 * LOCAL_SLASH name has a rendered help entry, and runLocal answers
 * `<cmd> help` with that entry as a status row instead of falling into the
 * command's argument parser.
 */

interface FakeModel {
  provider: string
  id: string
  name: string
}

const CATALOG: FakeModel[] = [
  { provider: 'deepseek-official', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
  { provider: 'deepseek-official', id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  { provider: 'openai', id: 'gpt-5', name: 'GPT-5' },
]

/** Mirrors the harness fixture of driver-model.spec.ts. */
function makeModelCtx(models: FakeModel[]): Record<string, unknown> {
  return {
    get(key: string) {
      if (key === 'agentPresets') {
        return {
          defaultId: 'cc',
          resolve: async () => ({ id: 'cc' }),
          mount: async () => ({ id: 'cc' }),
        }
      }
      if (key === 'llm') {
        return {
          listProviders: () => models.map(m => ({ id: m.provider })).filter((p, i, arr) => arr.findIndex(x => x.id === p.id) === i),
          listModels: async (provider: string) => models.filter(m => m.provider === provider),
          resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'high', name: 'high' }] } }),
        }
      }
      return undefined
    },
    on: () => () => {},
    agents: {
      create: async (opts: unknown) => {
        const agentOpts = (opts as { agentOptions?: Record<string, unknown> })?.agentOptions ?? {}
        return {
          agent: {
            options: agentOpts,
            session: { id: 's-test', header: {}, events: [] },
            id: 'a-test',
            status: 'idle',
            followup() {},
            cancel() {},
          },
          dispose: async () => {},
        }
      },
    },
  }
}

const lastText = (driver: { state: { rows: { kind: string }[] } }): string =>
  ((driver.state.rows.at(-1) as { text?: string })?.text ?? '')

describe('LOCAL_HELP catalog', () => {
  it('covers every LOCAL_SLASH name and includes the command name and Usage:', () => {
    for (const name of LOCAL_SLASH) {
      const help = localHelpFor(name)
      expect(help, `missing help entry for /${name}`).toBeDefined()
      expect(help!).toContain(`/${name}`)
      expect(help!).toContain('Usage:')
    }
  })

  it('documents the /provider subcommand grammar', () => {
    const help = localHelpFor('provider')!
    expect(help).toContain('list')
    expect(help).toContain('add <preset-id>')
    expect(help).toContain('remove <route>')
  })

  it('documents the /model argument grammar (index and provider/id)', () => {
    const help = localHelpFor('model')!
    expect(help).toMatch(/index|<n/)
    expect(help).toContain('provider/id')
  })

  it('documents the /effort reserved keyword', () => {
    expect(localHelpFor('effort')).toContain('default')
  })
})

describe('runLocal trailing-help interception', () => {
  it('/model help renders help instead of the Unknown-model notice', async () => {
    const driver = await createDriver(makeModelCtx(CATALOG) as never, {})
    await driver.submit('/model help')
    const text = lastText(driver)
    expect(text).toContain('/model')
    expect(text).toContain('provider/id')
    expect(text).not.toContain('Unknown model')
  })

  it('/model -h also renders help', async () => {
    const driver = await createDriver(makeModelCtx(CATALOG) as never, {})
    await driver.submit('/model -h')
    expect(lastText(driver)).toContain('Usage:')
  })

  it('/provider help renders help instead of the bare PROVIDER_USAGE error', async () => {
    const driver = await createDriver(makeModelCtx(CATALOG) as never, {})
    await driver.submit('/provider help')
    const text = lastText(driver)
    expect(text).toContain('add <preset-id>')
    expect(text).not.toBe('Usage: /provider [list | add <preset-id> | remove <route>]')
  })

  it('/resume help renders help and does not switch to session "help"', async () => {
    const driver = await createDriver(makeModelCtx(CATALOG) as never, {})
    await driver.submit('/resume help')
    const text = lastText(driver)
    expect(text).toContain('/resume')
    expect(text).toContain('<sessionId>')
  })

  it('a non-help argument is untouched: /model 2 still switches', async () => {
    const driver = await createDriver(makeModelCtx(CATALOG) as never, {})
    await driver.submit('/model 2')
    expect(lastText(driver)).toBe('Model is now deepseek-official/deepseek-v4-pro.')
  })

  // Busy path note: TUI-local commands are never parked when busy — only
  // plugin (colon-form) commands enqueue at driver-run-local.ts:303, and
  // driver-queue.ts:65 forwards LOCAL_SLASH text verbatim without parking.
  // `runLocal` therefore has no busy/parked branch for local names, and
  // `<local-cmd> help` renders its status row identically during a turn;
  // there is no distinct behavior to pin here.
})
