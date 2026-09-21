import { describe, expect, it } from 'vitest'
import { burstLabel } from '../src/burst.ts'

describe('burstLabel', () => {
  it('labels within the debounce window', () => {
    expect(burstLabel('k', 10000, 6000, 5000)).toBe(
      '[auto-verify] burst — result may overlap edits from 4000ms ago',
    )
  })

  it('returns undefined at exactly the debounce boundary', () => {
    expect(burstLabel('k', 10000, 5000, 5000)).toBeUndefined()
  })

  it('returns undefined after the window', () => {
    expect(burstLabel('k', 10001, 5000, 5000)).toBeUndefined()
  })

  it('returns undefined for a first run', () => {
    expect(burstLabel('k', 1000, undefined, 5000)).toBeUndefined()
  })
})
