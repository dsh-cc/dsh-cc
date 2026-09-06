import { describe, expect, it } from 'vitest'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as tui from '@dsh-cc/tui'

describe('@dsh-cc/tui plugin surface', () => {
  it('exports a Loader-safe cordis plugin with agents inject', () => {
    expect(tui.name).toBe('dsh-cc-tui')
    expect(tui.inject).toEqual(['agents'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(tui)).toBe(tui)
  })

  it('declares the autoResume and continueRequested config fields (boolean)', () => {
    // Schema.object exposes per-field schemas under `.dict`; both new fields
    // must be declared boolean so the plugin accepts them from the launcher
    // env.
    const dict = (tui.Config as unknown as { dict?: Record<string, { type?: unknown }> }).dict
    expect(dict?.autoResume?.type).toBe('boolean')
    expect(dict?.continueRequested?.type).toBe('boolean')
    expect(dict?.sessionId?.type).toBe('string') // sibling sanity check
  })
})
