import { describe, expect, it } from 'vitest'
import * as tui from '@dsh-cc/tui'

describe('P0 boot contract', () => {
  it('refuses a non-TTY stdout unless allowNoTty is set', async () => {
    const previous = process.env.DSH_CCTUI_ALLOW_NO_TTY
    delete process.env.DSH_CCTUI_ALLOW_NO_TTY
    const stdout = process.stdout as { isTTY?: boolean }
    const wasTty = stdout.isTTY
    stdout.isTTY = false
    try {
      await expect(tui.apply({} as never, {})).rejects.toThrow(/interactive terminal/)
    } finally {
      stdout.isTTY = wasTty
      if (previous === undefined) delete process.env.DSH_CCTUI_ALLOW_NO_TTY
      else process.env.DSH_CCTUI_ALLOW_NO_TTY = previous
    }
  })

  it('keeps agents as the only hard inject so optional seams degrade', () => {
    expect(tui.inject).toEqual(['agents'])
    expect(tui.name).toBe('dsh-cc-tui')
  })
})
