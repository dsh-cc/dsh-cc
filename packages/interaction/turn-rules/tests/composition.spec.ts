/**
 * Turn-rules composition (real boot, plan §5): the REAL turn-rules plugin and
 * the REAL cc-plugin-loader discovery run against the REAL agent loop with a
 * scripted mock MODEL — only the model is mocked (context-crusher
 * composition.spec.ts bridge.spec.ts pattern). A fixture cursor plugin is
 * "installed+enabled" in a throwaway CLAUDE_CONFIG_DIR/DSH_HOME; a mock tool
 * whose call ARGUMENTS contain the forbidden pattern must surface the rule
 * body as an `additionalContexts` entry riding the SAME accept (content
 * untouched), and a second identical exec must NOT re-fire under `once`.
 *
 * @module
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent, SessionEvent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { defineContentToolFixture } from '@dsh-cc/tools'
import { MockAdapter, textResponse, toolCallResponse } from '@dsh-cc/agent-loop-mock'
import * as TurnRules from '../src/index.ts'

const FIXTURE_ROOT = join(import.meta.dirname, 'fixtures', 'turn-rules-fixture')
const MARKER = 'TURN_RULES_FORBIDDEN_MARKER'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const savedEnv: Record<string, string | undefined> = {}
afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tr-smoke-home-'))
  dirs.push(dir)
  return dir
}

/**
 * Install the fixture plugin into a throwaway claude/dsh home: enabled in the
 * user settings cascade, installed via installed_plugins.json (absolute path
 * into this repo's fixture tree).
 */
function installFixture(claudeHome: string): void {
  mkdirSync(join(claudeHome, 'plugins'), { recursive: true })
  writeFileSync(join(claudeHome, 'settings.json'), JSON.stringify({
    enabledPlugins: { 'turn-rules-fixture@test-marketplace': true },
  }), 'utf8')
  writeFileSync(join(claudeHome, 'plugins', 'installed_plugins.json'), JSON.stringify({
    plugins: {
      'turn-rules-fixture@test-marketplace': [
        { installPath: FIXTURE_ROOT, lastUpdated: '2026-09-23T00:00:00.000Z' },
      ],
    },
  }), 'utf8')
}

interface Booted {
  agent: Agent
  home: string
  ctx: Context
}

/** The real-boot composition harness (context-crusher composition.spec.ts:137 pattern). */
async function boot(adapter: MockAdapter): Promise<Booted> {
  const claudeHome = home()
  installFixture(claudeHome)
  // Discovery snapshot at apply() reads DEFAULT discovery options: point
  // CLAUDE_CONFIG_DIR + DSH_HOME at the throwaway home for this worker.
  savedEnv.CLAUDE_CONFIG_DIR ??= process.env.CLAUDE_CONFIG_DIR
  savedEnv.DSH_HOME ??= process.env.DSH_HOME
  process.env.CLAUDE_CONFIG_DIR = claudeHome
  process.env.DSH_HOME = claudeHome

  const homeDir = home()
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
  void new TokenMeter(ctx)
  ;(ctx as unknown as { dshHomePath: (...s: string[]) => string }).dshHomePath =
    (...segments: string[]) => join(homeDir, ...segments)
  await ctx.plugin(TurnRules)
  ctx.tools.register(defineContentToolFixture({
    name: 'patterntool', description: 'b', parameters: {},
    async execute() { return [{ type: 'text', text: 'plain tool output, no marker inside' }] },
  }))
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('tr-smoke-1'), { provider: 'mock', model: 'mock' })
  return { agent, home: homeDir, ctx }
}

async function run(agent: Agent): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'call the tool' }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

function events(agent: Agent): SessionEvent[] {
  return [...agent.session.snapshotEvents()]
}

/** Reminder events: user/message rows attributed to the turn-rules source kind. */
function reminders(agent: Agent): { text: string; seq: number }[] {
  return events(agent)
    .map((e, index) => ({ e, index }))
    .filter(({ e }) => e.type === 'user/message' && (e.data as { source?: { kind?: string } }).source?.kind === 'turn-rules')
    .map(({ e, index }) => ({
      text: (e.data as { content: { type: string; text?: string }[] }).content.map((b) => b.text ?? '').join('\n'),
      seq: index,
    }))
}

/** The committed tool-result text (surface text blocks). */
function resultTexts(agent: Agent): string[] {
  return events(agent)
    .filter((e) => e.type === 'tool/result')
    .map((e) => (e.data as { message: { content: { type: string; content?: { type: string; text?: string }[] }[] } }).message.content
      .map((b) => (b.type === 'tool-result' ? (b.content ?? []).map((x) => x.text ?? '').join('\n') : b.text ?? ''))
      .join('\n'))
}

describe('turn-rules composition (real boot)', () => {
  it('a triggered rule fires once off tool ARGUMENTS as an additionalContexts entry; the second identical exec does not re-fire', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'patterntool', { code: `value ${MARKER} used` }),
      textResponse('done-1'),
      toolCallResponse('c2', 'patterntool', { code: `value ${MARKER} used again` }),
      textResponse('done-2'),
    ])
    const { agent, home } = await boot(adapter)
    await run(agent) // turn 1: c1 → reminder sideband → done-1

    // Fired exactly once: the reminder rides the session log as an attributed
    // user/message AFTER the first tool/result (the additionalContexts sideband).
    const fired = reminders(agent)
    expect(fired).toHaveLength(1)
    expect(fired[0]!.text).toContain('Forbidden pattern advisory')
    const toolResultIdx = events(agent).findIndex((e) => e.type === 'tool/result')
    expect(fired[0]!.seq).toBeGreaterThan(toolResultIdx)

    // The tool result content is UNTOUCHED — the sideband never rewrites it.
    const texts = resultTexts(agent)
    expect(texts.length).toBe(1)
    expect(texts[0]).toBe('plain tool output, no marker inside')

    // Second identical exec: `once` claimed — no second reminder.
    await run(agent) // turn 2: c2 with the same marker
    expect(resultTexts(agent)[1]).toBe('plain tool output, no marker inside')
    expect(reminders(agent)).toHaveLength(1)

    // The fired claim is durable: the session ledger records the ruleKey.
    const ledger = join(home, 'turn-rules', 'tr-smoke-1.json')
    expect(existsSync(ledger)).toBe(true)
    expect(readFileSync(ledger, 'utf8')).toContain('turn-rules-fixture/rules/pattern.mdc')
  })
})
