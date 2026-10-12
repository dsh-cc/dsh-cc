/**
 * The model-selection notice sanitizer — unit spec (effective-model-truth
 * design §7.1 + §7.2).
 *
 * §7.1 (listener behavior, direct invocation): the drop rule fires ONLY under
 * `moaOverlayActive() && pair(selection.assembled) == moaBootDefault()`
 * (FIELD comparison, never identity); every other state passes through
 * byte-identical, including all plugin-absent / undefined shapes. The
 * filtered decision is a COPY (mutating the original afterwards must not
 * affect the result), and only `source.kind === 'model-selection'` rows are
 * removed.
 *
 * §7.2 (wiring pins, static source scan): the co-located registration
 * (`installModelSelectionSanitizer` immediately after `installModelSelection`)
 * exists at BOTH call sites (tui driver `withSelection`, acp model-control
 * `install`), and the sanitizer subpath's import graph (sanitizer.ts →
 * runtime-state.ts → …) never reaches the plugin `apply()` path (index.ts).
 * @module
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resetRuntimeCore, setRuntimeCore } from '../src/runtime-state.ts'
import { ArmingMachine } from '../src/arming.ts'
import { installModelSelectionSanitizer } from '../src/sanitizer.ts'
import { BOOT_PAIR } from './rig.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const MOA_SRC = join(HERE, '..', 'src')

type Listener = (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>

/** Grab the installed pre-step listener out of a minimal context double. */
function install(selection: { assembled: unknown; current: unknown }): Listener {
  let listener: Listener | undefined
  installModelSelectionSanitizer(
    { on: (_event: string, fn: unknown) => { listener = fn as Listener; return () => {} } } as never,
    selection as never,
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
function liveCore(options: { enabled?: boolean; armed?: boolean; boot?: { provider: string; model: string } | undefined } = {}): ArmingMachine {
  const enabled = options.enabled ?? true
  const arming = new ArmingMachine(() => enabled)
  setRuntimeCore({ arming, validation: { ok: true } })
  if (options.boot !== undefined) arming.noteBootPair(options.boot)
  if ((options.armed ?? true) && enabled) {
    arming.arm()
    arming.observeRequestModel(options.boot ?? BOOT_PAIR)
  }
  return arming
}

describe('sanitizer drop rule (§7.1)', () => {
  it('drops model-selection rows under armed overlay when assembled == boot (field comparison, not identity)', async () => {
    liveCore({ boot: BOOT_PAIR })
    // Distinct OBJECT, same FIELDS — identity must not matter.
    const selection = { assembled: { ...BOOT_PAIR, reasoningEffort: 'max' }, current: undefined }
    const listener = install(selection)
    const original = decisionOf(noticeRow(), userRow())
    const result = (await listener({ agent: {} }, nextReturning(original))) as { messages: Row[] }
    expect(result.messages).toEqual([userRow()])
  })

  it('also drops moa-adjacent rows? no — keeps every non-model-selection row (moa rows survive)', async () => {
    liveCore({ boot: BOOT_PAIR })
    const listener = install({ assembled: { ...BOOT_PAIR }, current: undefined })
    const original = decisionOf(noticeRow(), moaRow(), userRow(), noticeRow())
    const result = (await listener({ agent: undefined }, nextReturning(original))) as { messages: Row[] }
    expect(result.messages).toEqual([moaRow(), userRow()])
  })

  it('passes through when disarmed (overlay not active even though assembled == boot)', async () => {
    const arming = liveCore({ boot: BOOT_PAIR, armed: true })
    arming.observeRequestModel({ provider: 'acme', model: 'opus-y' }) // /model away → disarmed
    expect(arming.isArmed()).toBe(false)
    const listener = install({ assembled: { ...BOOT_PAIR }, current: undefined })
    const original = decisionOf(noticeRow(), userRow())
    const result = (await listener({ agent: undefined }, nextReturning(original))) as { messages: Row[] }
    expect(result.messages).toEqual([noticeRow(), userRow()])
  })

  it('passes through when validation failed (validation.ok false → moaOverlayActive false)', async () => {
    const arming = new ArmingMachine(() => true)
    setRuntimeCore({ arming, validation: { ok: false, reason: 'degenerate ladder' } })
    arming.arm()
    arming.noteBootPair(BOOT_PAIR)
    arming.observeRequestModel(BOOT_PAIR)
    const listener = install({ assembled: { ...BOOT_PAIR }, current: undefined })
    const original = decisionOf(noticeRow(), userRow())
    const result = (await listener({ agent: undefined }, nextReturning(original))) as { messages: Row[] }
    expect(result.messages).toEqual([noticeRow(), userRow()])
  })

  it('passes through when the moa plugin was never applied (accessors inert, never throw)', async () => {
    resetRuntimeCore()
    const listener = install({ assembled: { ...BOOT_PAIR }, current: undefined })
    const original = decisionOf(noticeRow(), userRow())
    const result = (await listener({ agent: undefined }, nextReturning(original))) as { messages: Row[] }
    expect(result.messages).toEqual([noticeRow(), userRow()])
  })

  it('passes through when assembled is undefined or boot is undefined', async () => {
    liveCore({ boot: BOOT_PAIR })
    const assembledUndefined = install({ assembled: undefined, current: undefined })
    const original = decisionOf(noticeRow())
    expect(((await assembledUndefined({ agent: undefined }, nextReturning(original))) as { messages: Row[] }).messages).toEqual([noticeRow()])
    liveCore({ boot: undefined })
    const bootUndefined = install({ assembled: { ...BOOT_PAIR }, current: undefined })
    expect(((await bootUndefined({ agent: undefined }, nextReturning(original))) as { messages: Row[] }).messages).toEqual([noticeRow()])
  })

  it('passes through non-allow shapes: undefined decisions, reject decisions, messages undefined', async () => {
    liveCore({ boot: BOOT_PAIR })
    const listener = install({ assembled: { ...BOOT_PAIR }, current: undefined })
    expect(await listener({ agent: undefined }, nextReturning(undefined))).toBeUndefined()
    const reject = { kind: 'reject', messages: [noticeRow()] }
    expect(await listener({ agent: undefined }, nextReturning(reject))).toBe(reject)
    const noMessages = { kind: 'allow' }
    expect(await listener({ agent: undefined }, nextReturning(noMessages))).toBe(noMessages)
  })

  it('returns a COPIED decision: mutating the original afterwards must not affect the result', async () => {
    liveCore({ boot: BOOT_PAIR })
    const listener = install({ assembled: { ...BOOT_PAIR }, current: undefined })
    const original = decisionOf(noticeRow(), userRow())
    const result = (await listener({ agent: undefined }, nextReturning(original))) as { messages: Row[] }
    expect(result.messages).toEqual([userRow()])
    // Late mutation of the original array/object must not leak into the result.
    original.messages?.push(noticeRow())
    expect(result.messages).toEqual([userRow()])
  })

  it('subagent payloads are never published (publish is subagent-guarded)', async () => {
    liveCore({ boot: BOOT_PAIR })
    const listener = install({ assembled: { ...BOOT_PAIR }, current: undefined })
    const subagent = { session: { header: { origin: 'subagent' } } }
    await listener({ agent: subagent }, nextReturning(decisionOf(noticeRow())))
    // The publish half is observable via runtime state; a child's frozen
    // snapshot must not be recorded (root-scoped contract, §5.2 part 2).
    const { readPublishedSelection } = await import('../src/runtime-state.ts')
    expect(readPublishedSelection(subagent)).toBeUndefined()
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

  it('tui driver withSelection co-locates the sanitizer', () => {
    // driver.ts (at the 500-line size cap) delegates to a wiring helper; the
    // co-location pin therefore targets the helper, plus the driver using it.
    const driver = join(HERE, '../../../ui/tui/src/harness/driver.ts')
    const driverSource = readFileSync(driver, 'utf8')
    expect(driverSource, 'driver.ts delegates to the co-located wiring helper').toContain('installModelSelectionWithSanitizer(agentCtx, selection)')
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
