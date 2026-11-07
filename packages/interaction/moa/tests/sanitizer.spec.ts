/**
 * The model-selection notice sanitizer — unit spec (harness-0.2.2 D3.2 form).
 *
 * §7.1 (listener behavior, direct invocation): the sanitizer publishes the
 * frozen per-step pair from `payload.modelSelection` (never a ref — 0.2.2
 * stamps the frozen selection on the `agent/pre-step` payload) and then
 * passes every decision through byte-identical. Notices are truthful by
 * construction under pre-admission routing (moa's select IS the step
 * selection), so the phantom-drop rule is retired — while ARMED, zero
 * `model-selection` rows are filtered (the spec tripwire: a phantom would
 * show up as a filtered row here).
 *
 * §7.2 (wiring pins, static source scan): the co-located registration
 * (`installModelSelectionSanitizer` immediately after the 1-arg
 * `installModelSelection`) exists at BOTH call sites (tui driver
 * `withSelection`, acp model-control `install`), and the sanitizer subpath's
 * import graph (sanitizer.ts → runtime-state.ts → …) never reaches the
 * plugin `apply()` path (index.ts).
 * @module
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readPublishedSelection, resetRuntimeCore, setRuntimeCore } from '../src/runtime-state.ts'
import { ArmingMachine } from '../src/arming.ts'
import { installModelSelectionSanitizer } from '../src/sanitizer.ts'
import { BOOT_PAIR } from './rig.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const MOA_SRC = join(HERE, '..', 'src')

type Listener = (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>

/** Grab the installed pre-step listener out of a minimal context double. */
function install(): Listener {
  let listener: Listener | undefined
  installModelSelectionSanitizer(
    { on: (_event: string, fn: unknown) => { listener = fn as Listener; return () => {} } } as never,
  )
  if (listener === undefined) throw new Error('sanitizer did not register a listener')
  return listener
}

interface Row { text?: string; source?: { kind?: string } }
type Decision = { kind?: string; messages?: Row[] } | undefined

const decisionOf = (...rows: Row[]): Decision => ({ kind: 'allow', messages: rows })
const noticeRow = (): Row => ({ text: '[model changed: …]', source: { kind: 'model-selection' } })
const userRow = (): Row => ({ text: 'hello', source: { kind: 'user' } })
const moaRow = (): Row => ({ text: 'moa: routed → draft', source: { kind: 'moa', form: 'notice' } })
const nextReturning = (decision: Decision) => async (): Promise<Decision> => decision

/** Wire a live runtime core with the given armed/validation state. */
function liveCore(options: { enabled?: boolean; boot?: { provider: string; model: string } | undefined; ok?: boolean } = {}): ArmingMachine {
  const enabled = options.enabled ?? true
  const arming = new ArmingMachine(() => enabled)
  setRuntimeCore({ arming, validation: { ok: options.ok ?? true } })
  if (options.boot !== undefined) arming.noteBootPair(options.boot)
  if (enabled) arming.arm()
  return arming
}

describe('sanitizer pre-step publisher (§7.1)', () => {
  it('publishes the frozen payload.modelSelection pair before next() (the step freeze)', async () => {
    liveCore({ boot: BOOT_PAIR })
    const agent = {}
    const listener = install()
    const frozen = { ...BOOT_PAIR, reasoningEffort: 'max' }
    let publishedAtNext: unknown
    await listener(
      { agent, modelSelection: frozen },
      async () => {
        publishedAtNext = readPublishedSelection(agent)
        return decisionOf(userRow())
      },
    )
    expect(publishedAtNext).toEqual(BOOT_PAIR)
    expect(readPublishedSelection(agent)).toEqual(BOOT_PAIR)
  })

  it('publishes nothing when modelSelection is absent or model-less; never throws plugin-absent', async () => {
    resetRuntimeCore()
    const agent = {}
    const listener = install()
    await listener({ agent }, nextReturning(decisionOf(userRow())))
    expect(readPublishedSelection(agent)).toBeUndefined()
    await listener({ agent, modelSelection: { provider: 'x' } }, nextReturning(decisionOf(userRow())))
    expect(readPublishedSelection(agent)).toBeUndefined()
  })

  it('subagent payloads are never published (publish is subagent-guarded)', async () => {
    liveCore({ boot: BOOT_PAIR })
    const listener = install()
    const subagent = { session: { header: { origin: 'subagent' } } }
    await listener({ agent: subagent, modelSelection: { ...BOOT_PAIR } }, nextReturning(decisionOf(userRow())))
    expect(readPublishedSelection(subagent)).toBeUndefined()
  })
})

describe('sanitizer passthrough + armed tripwire (§7.1, drop rule retired)', () => {
  it('ARMED: zero model-selection rows are filtered — notices are truthful by construction (the S4 tripwire)', async () => {
    liveCore({ boot: BOOT_PAIR })
    const listener = install()
    const original = decisionOf(noticeRow(), userRow(), noticeRow())
    const result = (await listener({ agent: {}, modelSelection: { ...BOOT_PAIR } }, nextReturning(original))) as { messages: Row[] }
    // A phantom would appear here as a dropped row; under truthful notices
    // every row survives.
    expect(result.messages).toEqual([noticeRow(), userRow(), noticeRow()])
    expect(result).toBe(original) // identity — nothing copied, nothing filtered
  })

  it('keeps moa status rows and user rows byte-identical (G5)', async () => {
    liveCore({ boot: BOOT_PAIR })
    const listener = install()
    const original = decisionOf(noticeRow(), moaRow(), userRow())
    const result = await listener({ agent: {}, modelSelection: { ...BOOT_PAIR } }, nextReturning(original))
    expect(result).toBe(original)
  })

  it('passes through non-decision shapes untouched: undefined, reject, messages-undefined', async () => {
    liveCore({ boot: BOOT_PAIR })
    const listener = install()
    expect(await listener({ agent: {} }, nextReturning(undefined))).toBeUndefined()
    const reject = { kind: 'reject', messages: [noticeRow()] }
    expect(await listener({ agent: {} }, nextReturning(reject))).toBe(reject)
    const noMessages = { kind: 'allow' }
    expect(await listener({ agent: {} }, nextReturning(noMessages))).toBe(noMessages)
  })

  it('passes through without a runtime core (plugin absent: inert, never throws)', async () => {
    resetRuntimeCore()
    const listener = install()
    const original = decisionOf(noticeRow(), userRow())
    const result = await listener({ agent: {}, modelSelection: { ...BOOT_PAIR } }, nextReturning(original))
    expect(result).toBe(original)
  })
})

describe('sanitizer wiring (§7.2 static pins)', () => {
  const src = (p: string): string => readFileSync(join(MOA_SRC, p), 'utf8')

  /** The co-located registration exists: installModelSelection then, within the same function, the sanitizer. */
  function assertColocated(path: string, source: string): void {
    const lines = source.split('\n')
    const idx = lines.findIndex((l) => l.includes('installModelSelection('))
    expect(idx, `${path}: installModelSelection call site`).toBeGreaterThanOrEqual(0)
    const window = lines.slice(idx, idx + 6).join('\n')
    expect(window, `${path}: sanitizer co-located immediately after installModelSelection`).toContain('installModelSelectionSanitizer(')
  }

  it('tui driver withSelection co-locates the sanitizer (1-arg install, D3.1)', () => {
    // driver.ts (at the 500-line size cap) delegates to a wiring helper; the
    // co-location pin therefore targets the helper, plus the driver using it.
    const driver = join(HERE, '../../../ui/tui/src/harness/driver.ts')
    const driverSource = readFileSync(driver, 'utf8')
    expect(driverSource, 'driver.ts delegates to the co-located wiring helper').toContain('installModelSelectionWithSanitizer(agentCtx)')
    const wiring = join(HERE, '../../../ui/tui/src/harness/model-selection-wiring.ts')
    const wiringSource = readFileSync(wiring, 'utf8')
    assertColocated(wiring, wiringSource)
  })

  it('acp model-control install co-locates the sanitizer', () => {
    const file = join(HERE, '../../../acp/cc-acp/src/model-control.ts')
    assertColocated(file, readFileSync(file, 'utf8'))
  })

  /** sanitizer.ts's transitive import graph (relative imports only). */
  function importGraph(entry: string, seen = new Set<string>()): Set<string> {
    if (seen.has(entry)) return seen
    seen.add(entry)
    const text = readFileSync(join(MOA_SRC, entry), 'utf8')
    for (const m of text.matchAll(/from\s+'(\.[^']+)'/g)) {
      const target = m[1].replace(/\.ts$/, '').replace(/^\.\//, '')
      importGraph(`${target}.ts`, seen)
    }
    return seen
  }

  it('the @dsh-cc/moa/sanitizer import graph never reaches the apply() path (index.ts)', () => {
    const graph = importGraph('sanitizer.ts')
    expect(graph.has('sanitizer.ts')).toBe(true)
    expect(graph.has('index.ts'), `sanitizer import graph: ${[...graph].join(', ')}`).toBe(false)
  })
})
