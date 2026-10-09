// CC divergence tests: ACP branding and identity (§5.3 of
// docs/plans/2026-10-09-acp-m2-own-plugin.md).
import { afterEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { makeBridgeHarness, type BridgeHarness } from './harness.ts'

const pkgVersion = (JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version

describe('ACP branding (§5.3)', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('initialize advertises the dsh-cc identity with the package version', async () => {
    harness = await makeBridgeHarness()
    const response = await harness.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    })
    expect(response.agentInfo).toEqual({ name: 'dsh-cc', version: pkgVersion })
  })
})
