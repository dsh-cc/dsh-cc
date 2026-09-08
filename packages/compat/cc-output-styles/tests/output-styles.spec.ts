import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as ccOutputStyles from '../src/index.ts'
import { styleSectionText } from '../src/styles.ts'

/** In-memory settings provider exercising the real write/commit path. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

/** Build a live idle agent accepted by command dispatch and session append. */
function stubAgent(ctx: Context, id: string): { agent: Agent; session: Session } {
  const session = ctx.sessions.create(SessionId(id))
  // Plain-object fake: upstream no longer exports an `Inbox` constructor.
  const nextStep: unknown[] = []
  const inbox = {
    nextTurn: [],
    nextStep,
    clear: () => {},
    append: (target: string, message: unknown) => { if (target === 'next-step') nextStep.push(message) },
    prepend: () => {},
    replace: () => false,
    remove: () => false,
  }
  let status: AgentStatus = 'idle'
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox,
    ctx: new Context(),
    get status() { return status },
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject(input) { inbox.append('next-step', input) },
    cancel() { status = 'idle' },
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  return { agent, session }
}

interface Harness {
  ctx: Context
  agent: Agent
  changeCount: () => number
}

async function harness(config: Record<string, unknown> = {}, withSettings = true): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  if (withSettings) await ctx.plugin(MemorySettings)
  let count = 0
  ctx.on('system-prompt/change', () => { count += 1 })
  await ctx.plugin(ccOutputStyles, config)
  const { agent } = stubAgent(ctx, `cc-output-styles-${Math.random()}`)
  ctx.agents.register(agent)
  return { ctx, agent, changeCount: () => count }
}

/** The rendered text of the newer output-style system section, or undefined. */
async function styleSectionTextOf(h: Harness): Promise<string | undefined> {
  const assembly = await h.ctx.systemPrompt.assemble()
  return assembly.sections.find(section => section.name === ccOutputStyles.OUTPUT_STYLE_SECTION)?.text
}

async function runOutputStyle(h: Harness, suffix = ''): Promise<{ kind: string; text: string }> {
  const execution = await h.ctx.commands.execute(h.agent, `/output-style${suffix}`, [], new AbortController().signal)
  if (execution === undefined) throw new Error('output-style command was not registered')
  return execution.result as { kind: string; text: string }
}

describe('@dsh-cc/output-styles registration', () => {
  it('is a function plugin with commands + systemPrompt injection and no default export', async () => {
    expect(ccOutputStyles.name).toBe('cc-output-styles')
    expect(ccOutputStyles.inject).toEqual(['systemPrompt', 'commands'])
    expect('default' in ccOutputStyles).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(ccOutputStyles)).toBe(ccOutputStyles)

    const h = await harness()
    expect(h.ctx.commands.list(h.agent)).toContainEqual(expect.objectContaining({ name: 'output-style' }))
    await h.ctx.fiber.dispose()
  })

  it('restores the composition default when no style is configured', async () => {
    const h = await harness()
    await expect(styleSectionTextOf(h)).resolves.toBe('')
    await h.ctx.fiber.dispose()
  })
})

describe('output-style section text', () => {
  it('renders an empty section for the default style and prose for built-in styles', async () => {
    const h = await harness({ outputStyle: 'default' })
    await expect(styleSectionTextOf(h)).resolves.toBe('')

    const explanatory = await harness({ outputStyle: 'Explanatory' })
    const explanatoryText = await styleSectionTextOf(explanatory)
    expect(explanatoryText).not.toBe('')
    await explanatory.ctx.fiber.dispose()

    const learning = await harness({ outputStyle: 'Learning' })
    const learningText = await styleSectionTextOf(learning)
    expect(learningText).not.toBe('')
    expect(learningText).not.toBe(explanatoryText)
    await learning.ctx.fiber.dispose()
    await h.ctx.fiber.dispose()
  })

  it('switching through settings changes the live section and emits system-prompt/change', async () => {
    const h = await harness({ outputStyle: 'default' })
    expect(await styleSectionTextOf(h)).toBe('')
    const before = h.changeCount()

    await h.ctx.settings.update(ccOutputStyles.OUTPUT_STYLE_SETTINGS_NAMESPACE, { outputStyle: 'Learning' })
    const text = await styleSectionTextOf(h)
    expect(text).not.toBe('')
    expect(text!.toLowerCase()).toContain('todo(human)')
    expect(h.changeCount()).toBeGreaterThan(before)
    await h.ctx.fiber.dispose()
  })

  it('switching without a settings provider still takes effect in-session', async () => {
    const h = await harness({ outputStyle: 'default' }, false)
    expect(await styleSectionTextOf(h)).toBe('')

    const result = await runOutputStyle(h, ' Learning')
    expect(result.kind).toBe('success')
    expect(await styleSectionTextOf(h)).not.toBe('')
    await h.ctx.fiber.dispose()
  })

  it('keeps the default coding instructions by default but replaces them when keep-coding-instructions is false', async () => {
    expect(styleSectionText({
      name: 'concise', description: 'x', prompt: 'Be concise.', builtin: false, keepCodingInstructions: true,
    })).toBe('Be concise.')
    expect(styleSectionText({
      name: 'concise', description: 'x', prompt: 'Be concise.', builtin: false, keepCodingInstructions: false,
    })).not.toBe('Be concise.')
    expect(styleSectionText({
      name: 'concise', description: 'x', prompt: 'Be concise.', builtin: false, keepCodingInstructions: false,
    })).toContain('Be concise.')
  })
})

describe('/output-style human command', () => {
  it('lists the available styles and the current selection without arguments', async () => {
    const h = await harness()
    const result = await runOutputStyle(h)
    expect(result.kind).toBe('success')
    expect(result.text).toContain('Explanatory')
    expect(result.text).toContain('Learning')
    expect(result.text).toContain('default')
    await h.ctx.fiber.dispose()
  })

  it('switches the saved style through the settings provider', async () => {
    const h = await harness()
    const result = await runOutputStyle(h, ' Learning')
    expect(result.kind).toBe('success')
    expect(h.ctx.settings.get(ccOutputStyles.OUTPUT_STYLE_SETTINGS_NAMESPACE)).toMatchObject({ outputStyle: 'Learning' })
    await h.ctx.fiber.dispose()
  })

  it('reports an unknown style and lists the available styles', async () => {
    const h = await harness()
    const result = await runOutputStyle(h, ' no-such-style')
    expect(result.kind).toBe('error')
    expect(result.text.toLowerCase()).toContain('no-such-style')
    expect(result.text).toContain('Explanatory')
    expect(result.text).toContain('Learning')
    await h.ctx.fiber.dispose()
  })
})

describe('custom style loading over the composition', () => {
  it('loads custom styles from configured directories and renders the selected one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-output-styles-lib-'))
    const dir = join(root, 'styles')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'concise.md'), '---\ndescription: Short.\nkeep-coding-instructions: false\n---\nBe concise and skip the usual coding preamble.')

    const h = await harness({ outputStyle: 'concise', dirs: [dir] })
    const text = await styleSectionTextOf(h)
    expect(text).toBeDefined()
    expect(text!.toLowerCase()).toContain('concise')
    expect(text!.toLowerCase()).toContain('replaces')
    await h.ctx.fiber.dispose()
  })

  it('fails loud when a custom frontmatter is malformed at load', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-output-styles-bad-'))
    const dir = join(root, 'styles')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'bad.md'), '---\n[unclosed\n---\nbody')

    await expect(harness({ dirs: [dir] })).rejects.toThrow(/frontmatter/i)
  })
})
