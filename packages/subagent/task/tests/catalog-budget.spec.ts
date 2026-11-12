/**
 * Section B of design docs/plans/2026-11-12-selective-system-prompt-sections.md:
 * the `cc-subagent-catalog` byte budget for the "Available subagents" section.
 *
 * The contract these specs pin:
 * - `renderCatalog(defs, settings)` stays a pure total function over
 *   `(defs, settings)`, measured in UTF-8 bytes, sliced on code-point
 *   boundaries (CJK content never overflows the budget);
 * - under budget the render is byte-identical to the pre-budget catalog;
 * - first pass keeps every `agentType` name and slices `whenToUse` to
 *   `max(min-entry-bytes, floor((max-bytes - reserved) / N))` bytes;
 * - second pass keeps the first K entries and collapses the rest into a
 *   names-only line plus the ellipsis note;
 * - the oversized-names floor drops names only with the documented overflow
 *   line, and the property `bytes <= max-bytes` holds for every non-floor case;
 * - settings thread through the ONE production render path
 *   (`AgentCatalogSection.render`), so a settings write reaches the section
 *   callback, the readiness reconciliation and `system-prompt/change` re-renders.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { Buffer } from 'node:buffer'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { AgentDefinition } from '@dsh-cc/claude-code-agents'
import { AgentCatalogSection, CATALOG_SECTION_NAME, renderCatalog } from '../src/catalog.ts'
import { AgentRegistry } from '../src/registry.ts'
import {
  CATALOG_SETTINGS_NAMESPACE,
  DEFAULT_CATALOG_SETTINGS,
  MAX_CATALOG_ENTRY_BYTES,
  MAX_CATALOG_MAX_BYTES,
  MIN_CATALOG_ENTRY_BYTES,
  MIN_CATALOG_MAX_BYTES,
  SettingsSchema as CatalogSettingsSchema,
  catalogSettings,
  resolveCatalogSettings,
} from '../src/catalog-settings.ts'

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8')

/** One roster definition. */
function def(agentType: string, whenToUse: string): AgentDefinition {
  return { agentType, whenToUse, systemPrompt: 'You are it.' } as AgentDefinition
}

/** N definitions with predictable name/usage sizes, already alphabetical. */
function roster(count: number, usageLength = 120, nameLength = 12): AgentDefinition[] {
  return Array.from({ length: count }, (_unused, index) => {
    const suffix = String(index).padStart(2, '0')
    return def(`agent_${suffix}_${'n'.repeat(nameLength)}`, 'u'.repeat(usageLength))
  })
}

/** The exact pre-budget catalog text (the render `renderCatalog` must match). */
function preBudgetCatalog(defs: readonly AgentDefinition[]): string {
  return [
    '## Available subagents',
    '',
    ...defs.map(entry => `- ${entry.agentType} — ${entry.whenToUse}`),
    '',
    'To delegate to one, pass its name as the `subagent_type` argument of the Task tool.',
  ].join('\n')
}

/** The catalog's entry lines (everything the section lists). */
function entryLines(text: string): string[] {
  return text.split('\n').filter(line => line.startsWith('- '))
}

/** The doc's documented oversized-names overflow line. */
const OVERFLOW_NOTE = /… \(\d+ more agents omitted by cc-subagent-catalog\.max-bytes; the catalog's usage line stays\)/

/** The mandatory skeleton with the overflow note for `count` omitted agents. */
function overflowSkeleton(count: number): string {
  return [
    '## Available subagents',
    '',
    `… (${count} more agents omitted by cc-subagent-catalog.max-bytes; the catalog's usage line stays)`,
    '',
    'To delegate to one, pass its name as the `subagent_type` argument of the Task tool.',
  ].join('\n')
}

describe('cc-subagent-catalog settings namespace', () => {
  it('names the namespace exactly `cc-subagent-catalog` and defaults to on/8192/40', () => {
    expect(CATALOG_SETTINGS_NAMESPACE).toBe('cc-subagent-catalog')
    expect(DEFAULT_CATALOG_SETTINGS).toEqual({ truncate: true, maxBytes: 8192, minEntryBytes: 40 })
    expect(catalogSettings(undefined)).toEqual(DEFAULT_CATALOG_SETTINGS)
    expect(resolveCatalogSettings(undefined)).toEqual(DEFAULT_CATALOG_SETTINGS)
  })

  it('maps the kebab-case user section onto the internal shape', () => {
    expect(catalogSettings({ truncate: false, 'max-bytes': 2048, 'min-entry-bytes': 120 }))
      .toEqual({ truncate: false, maxBytes: 2048, minEntryBytes: 120 })
  })

  it('rejects out-of-range and non-integer values (never clamps)', () => {
    const schema = CatalogSettingsSchema as unknown as (input: unknown) => unknown
    expect(() => schema({ 'max-bytes': MIN_CATALOG_MAX_BYTES - 1 })).toThrow()
    expect(() => schema({ 'max-bytes': MAX_CATALOG_MAX_BYTES + 1 })).toThrow()
    expect(() => schema({ 'max-bytes': 2048.5 })).toThrow()
    expect(() => schema({ 'min-entry-bytes': MIN_CATALOG_ENTRY_BYTES - 1 })).toThrow()
    expect(() => schema({ 'min-entry-bytes': MAX_CATALOG_ENTRY_BYTES + 1 })).toThrow()
    expect(() => schema({ 'min-entry-bytes': 40.5 })).toThrow()
    expect(() => schema({ 'max-bytes': MIN_CATALOG_MAX_BYTES, 'min-entry-bytes': MAX_CATALOG_ENTRY_BYTES }))
      .not.toThrow()
  })

  it('keeps an absent namespace absent instead of materializing defaults', () => {
    const schema = CatalogSettingsSchema as unknown as (input: unknown) => unknown
    expect(schema(undefined)).toBeUndefined()
  })
})

describe('renderCatalog budget', () => {
  it('renders byte-identically to the pre-budget catalog when under budget', () => {
    const defs = [def('alpha', 'Short usage'), def('beta', 'Another usage')]
    const rendered = renderCatalog(defs, { truncate: true, maxBytes: 8192 })
    expect(rendered).toBe(preBudgetCatalog(defs))
    expect(rendered).not.toContain('names only')
    expect(rendered).not.toContain('cc-subagent-catalog.max-bytes')
  })

  it('renders an empty string for an empty roster', () => {
    expect(renderCatalog([], { truncate: true, maxBytes: 1024 })).toBe('')
  })

  it('truncate: false renders the catalog uncapped', () => {
    const defs = roster(20, 200)
    expect(renderCatalog(defs, { truncate: false, maxBytes: 1024 })).toBe(preBudgetCatalog(defs))
  })

  it('preserves every agentType name down to the names-only collapse', () => {
    const defs = roster(10, 200)
    const rendered = renderCatalog(defs, { truncate: true, maxBytes: 1024 })
    expect(bytes(rendered)).toBeLessThanOrEqual(1024)
    for (const entry of defs) expect(rendered).toContain(entry.agentType)
    // Names survive in a dedicated names-only line for the collapsed agents.
    expect(rendered).toContain('… names only: ')
    expect(rendered).toContain('usage text omitted by cc-subagent-catalog.max-bytes')
    expect(rendered).toContain('## Available subagents')
    expect(rendered).toContain('To delegate to one, pass its name as the `subagent_type` argument of the Task tool.')
  })

  it('slices CJK whenToUse byte-accurately: never overflows, never splits a character', () => {
    const cjk = '审查重型工作并给出结论'.repeat(40)
    const defs = [
      def('critic', cjk),
      def('executor', cjk),
      def('marathon', cjk),
    ]
    for (const maxBytes of [1024, 1500, 2000, 3000]) {
      const rendered = renderCatalog(defs, { truncate: true, maxBytes, minEntryBytes: 20 })
      expect(bytes(rendered), `maxBytes=${maxBytes}`).toBeLessThanOrEqual(maxBytes)
      expect(rendered).not.toContain('\uFFFD')
      for (const line of entryLines(rendered)) {
        const [, usage] = line.split(' — ')
        // Every rendered usage text is a whole-character prefix of the original.
        expect(cjk.startsWith(usage ?? '')).toBe(true)
      }
    }
  })

  it('honours the min-entry-bytes floor when the even share falls below it', () => {
    const defs = roster(10, 400)
    const generous = renderCatalog(defs, { truncate: true, maxBytes: 1024, minEntryBytes: 200 })
    const thrifty = renderCatalog(defs, { truncate: true, maxBytes: 1024, minEntryBytes: 20 })
    expect(bytes(generous)).toBeLessThanOrEqual(1024)
    expect(bytes(thrifty)).toBeLessThanOrEqual(1024)
    const usageBytes = (text: string): number => {
      const first = entryLines(text)[0]
      if (first === undefined) throw new Error('expected a retained entry')
      return bytes(first.split(' — ')[1] ?? '')
    }
    // The floor raises the per-entry slice above the even share; the default
    // floor leaves the even share in charge.
    expect(usageBytes(generous)).toBeGreaterThanOrEqual(200)
    expect(usageBytes(thrifty)).toBeGreaterThanOrEqual(20)
    expect(usageBytes(thrifty)).toBeLessThan(usageBytes(generous))
  })

  it('oversized-names floor drops names only with the documented overflow line', () => {
    const defs = roster(30, 200, 40)
    const rendered = renderCatalog(defs, { truncate: true, maxBytes: 1024 })
    expect(rendered).toMatch(OVERFLOW_NOTE)
    expect(rendered).toContain('## Available subagents')
    expect(rendered).toContain('To delegate to one, pass its name as the `subagent_type` argument of the Task tool.')
    // Bytes stay inside the budget as long as the skeleton itself fits.
    if (bytes(overflowSkeleton(30)) <= 1024) {
      expect(bytes(rendered)).toBeLessThanOrEqual(1024)
    }
    // The first (alphabetical) names survive; the tail is what got cut.
    expect(rendered).toContain('agent_00_')
    expect(rendered).not.toContain(defs[29]!.agentType)
    // No usage text survives in the overflow form.
    for (const line of entryLines(rendered)) expect(line).not.toContain(' — uuu')
  })

  it('property: every non-floor render fits max-bytes over random rosters', () => {
    let seed = 0x5eed
    const next = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed / 2_147_483_648
    }
    const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)]!
    const alphabet = 'abcXYZ日本語漢字éü'
    let truncations = 0

    for (let round = 0; round < 120; round++) {
      const count = 1 + Math.floor(next() * 40)
      // Budgets stay in the tight half of the legal range so the cap (and the
      // floor) are actually exercised, not just the pass-through branch.
      const maxBytes = MIN_CATALOG_MAX_BYTES + Math.floor(next() * 3072)
      const minEntryBytes = MIN_CATALOG_ENTRY_BYTES + Math.floor(next() * (MAX_CATALOG_ENTRY_BYTES - MIN_CATALOG_ENTRY_BYTES))
      const defs = Array.from({ length: count }, (_unused, index) => {
        const nameLength = 3 + Math.floor(next() * 40)
        const usageLength = Math.floor(next() * 400)
        const name = `${String(index).padStart(2, '0')}-` + Array.from(
          { length: nameLength },
          () => pick(alphabet.split('')),
        ).join('')
        const usage = Array.from({ length: usageLength }, () => pick(alphabet.split(''))).join('')
        return def(name, usage)
      }).sort((a, b) => a.agentType.localeCompare(b.agentType))

      const rendered = renderCatalog(defs, { truncate: true, maxBytes, minEntryBytes })
      const size = bytes(rendered)
      if (rendered !== preBudgetCatalog(defs)) truncations++
      // The usage trailer is mandatory: it must survive every form.
      expect(rendered).toContain('To delegate to one, pass its name as the `subagent_type` argument of the Task tool.')
      const floor = rendered.match(OVERFLOW_NOTE) !== null
      if (size > maxBytes) {
        // Only the documented floor may exceed, and only when the mandatory
        // skeleton plus the overflow note itself exceeds the budget.
        expect(floor, `round ${round}: over budget without the floor form`).toBe(true)
        expect(bytes(overflowSkeleton(count)), `round ${round}: skeleton fits, render must too`)
          .toBeGreaterThan(maxBytes)
      }
      if (!floor) {
        // Names-only collapse keeps every name; overflow drops only with the note.
        for (const entry of defs) expect(rendered).toContain(entry.agentType)
      }
    }
    // The property above is only meaningful if the cap actually fired.
    expect(truncations).toBeGreaterThan(20)
  })
})

/**
 * Settings threading: production has ONE render call site
 * (`AgentCatalogSection.render`), shared by the section callback, the readiness
 * reconciliation and every `system-prompt/change` re-render — so the stored
 * reader is consulted per render there and nowhere else.
 */
describe('AgentCatalogSection hot settings', () => {
  const tmpRoots: string[] = []

  function freshDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'catalog-budget-'))
    tmpRoots.push(dir)
    return dir
  }

  function writeAgents(root: string, count: number): void {
    const agents = join(root, '.claude', 'agents')
    mkdirSync(agents, { recursive: true })
    for (let index = 0; index < count; index++) {
      const suffix = String(index).padStart(2, '0')
      writeFileSync(
        join(agents, `agent_${suffix}.md`),
        `---\nname: agent_${suffix}\ndescription: ${'d'.repeat(200)}\n---\nBody.\n`,
        'utf8',
      )
    }
  }

  const agentAt = (cwd: string): Agent => ({ session: { header: { cwd } } }) as unknown as Agent

  afterEach(() => {
    for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  async function mount() {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    let settings = { truncate: false, maxBytes: 1024, minEntryBytes: 40 }
    const section = new AgentCatalogSection(ctx, new AgentRegistry(), undefined, () => settings)
    section.start()
    const textOf = async (agent: Agent): Promise<string> => {
      const assembly = await ctx.systemPrompt.assemble({ scope: agent })
      return assembly.sections.find(entry => entry.name === CATALOG_SECTION_NAME)?.text ?? ''
    }
    return { ctx, textOf, setSettings: (next: typeof settings) => { settings = next } }
  }

  it('re-reads the settings getter on the shared render path', async () => {
    const ws = freshDir()
    writeAgents(ws, 8)
    const { ctx, textOf, setSettings } = await mount()
    const agent = agentAt(ws)

    const uncapped = await textOf(agent)
    expect(uncapped).toContain('agent_07')
    expect(uncapped).not.toContain('cc-subagent-catalog.max-bytes')

    setSettings({ truncate: true, maxBytes: 1024, minEntryBytes: 40 })
    const capped = await textOf(agent)
    expect(bytes(capped)).toBeLessThanOrEqual(1024)
    expect(capped).toContain('## Available subagents')
    expect(capped).toContain('To delegate to one, pass its name as the `subagent_type` argument of the Task tool.')
    for (let index = 0; index < 8; index++) {
      expect(capped).toContain(`agent_${String(index).padStart(2, '0')}`)
    }

    // The readiness-completion re-render consults the same reader.
    setSettings({ truncate: false, maxBytes: 1024, minEntryBytes: 40 })
    expect(await textOf(agent)).toBe(uncapped)
    await ctx.fiber.dispose()
  })
})
