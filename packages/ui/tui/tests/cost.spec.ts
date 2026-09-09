import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDriver } from '@dsh-cc/tui/harness/driver.ts'

/** Last status row emitted to the transcript, if any. */
function lastStatus(driver: { state: { rows: readonly { kind: string; text?: string }[] } }): string | undefined {
  for (let i = driver.state.rows.length - 1; i >= 0; i -= 1) {
    const row = driver.state.rows[i]!
    if (row.kind === 'status') return row.text
  }
  return undefined
}

/** The report text is distinctive so the echo guard can never suppress it. */
const COST_REPORT_TEXT = 'priced cost report from the registry'

describe('/cost routes through the harness command registry', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-driver-cost-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  it('forwards /cost to ctx.commands and echoes the registry result', async () => {
    const executeCalls: string[] = []
    const ctx: Record<string, unknown> = {
      get(key: string) {
        if (key === 'agentPresets') {
          return {
            defaultId: 'cc',
            resolve: async () => ({ id: 'cc' }),
            mount: async () => ({ id: 'cc' }),
          }
        }
        if (key === 'commands') {
          return {
            list: () => [],
            execute: async (_agent: unknown, line: string) => {
              executeCalls.push(line)
              return { result: { kind: 'success', text: COST_REPORT_TEXT } }
            },
          }
        }
        return undefined
      },
      on: () => () => {},
      agents: {
        create: async () => ({
          agent: {
            options: {},
            session: { id: 's-a', header: {}, events: [], snapshotEvents() { return this.events } },
            id: 'a-1',
            status: 'idle',
            followup: vi.fn(),
            steer: vi.fn(),
            cancel: vi.fn(),
          },
          dispose: async () => {},
        }),
        resume: async () => {
          throw new Error('not needed')
        },
      },
    }
    const driver = await createDriver(ctx as never, { cwd: '/w/proj', branchProbe: async () => undefined })

    await driver.submit('/cost')
    expect(executeCalls).toEqual(['/cost'])
    expect(lastStatus(driver)).toBe(COST_REPORT_TEXT)
  })
})
