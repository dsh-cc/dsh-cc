import { describe, expect, it } from 'vitest'
import { buildArgCompleters } from '@dsh-cc/tui/components/arg-completers.ts'

/**
 * Driver-backed slash argument completers: `/model` completes from the live
 * model catalog (both `provider/id` and unique bare-id forms, matching
 * parseModelChoice), `/resume` completes session short ids.
 */

interface FakeEntry {
  provider: string
  id: string
  name: string
}

function fakeDriver(
  catalog: FakeEntry[],
  sessions: { id: string; createdAt: number }[],
  efforts: readonly string[] = [],
) {
  return {
    loadModelCatalog: async () => catalog,
    listSessions: async () => sessions,
    loadModelEfforts: async () => efforts,
  }
}

describe('buildArgCompleters — /model', () => {
  it('offers provider/id for every entry and a bare id only for unique ids', async () => {
    const completers = buildArgCompleters(fakeDriver(
      [
        { provider: 'prov-a', id: 'shared', name: 'Shared Model' },
        { provider: 'prov-b', id: 'shared', name: 'Shared Model (other)' },
        { provider: 'prov-a', id: 'unique', name: 'Unique Model' },
      ],
      [],
    ))
    const items = await completers.model!('', new AbortController().signal)
    expect(items.map(i => i.value)).toEqual([
      'prov-a/shared',
      'prov-b/shared',
      'prov-a/unique',
      'unique',
    ])
  })

  it('labels provider/id items with the key and describes with the model name', async () => {
    const completers = buildArgCompleters(fakeDriver(
      [{ provider: 'prov-a', id: 'unique', name: 'Unique Model' }],
      [],
    ))
    const items = await completers.model!('', new AbortController().signal)
    expect(items[0]).toEqual({
      value: 'prov-a/unique',
      label: 'prov-a/unique',
      description: 'Unique Model',
    })
    expect(items[1]).toEqual({
      value: 'unique',
      label: 'unique',
      description: 'Unique Model',
    })
  })

  it('omits the description when the catalog entry has an empty name', async () => {
    const completers = buildArgCompleters(fakeDriver(
      [{ provider: 'prov-a', id: 'unique', name: '' }],
      [],
    ))
    const items = await completers.model!('', new AbortController().signal)
    expect(items[0]).toEqual({ value: 'prov-a/unique', label: 'prov-a/unique' })
  })
})

describe('buildArgCompleters — /effort', () => {
  it('offers the live effort levels with the trailing default entry last', async () => {
    const completers = buildArgCompleters(fakeDriver([], [], ['minimal', 'high', 'default']))
    const items = await completers.effort!('', new AbortController().signal)
    expect(items.map(i => i.value)).toEqual(['minimal', 'high', 'default'])
    expect(items.map(i => i.label)).toEqual(['minimal', 'high', 'default'])
  })

  it('offers nothing when no model is resolved (loadModelEfforts returns [])', async () => {
    const completers = buildArgCompleters(fakeDriver([], [], []))
    const items = await completers.effort!('', new AbortController().signal)
    expect(items).toEqual([])
  })
})

describe('buildArgCompleters — /permissions', () => {
  it('offers the five CC rule-engine modes in advertisement order', async () => {
    const completers = buildArgCompleters(fakeDriver([], []))
    const items = await completers.permissions!('', new AbortController().signal)
    expect(items.map(i => i.value)).toEqual([
      'default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions',
    ])
    expect(items.map(i => i.label)).toEqual([
      'default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions',
    ])
  })
})

describe('buildArgCompleters — /resume', () => {
  it('offers short session ids newest-first with the full id as description', async () => {
    const completers = buildArgCompleters(fakeDriver([], [
      { id: 'tui-0011223344556677', createdAt: 1 },
      { id: 'tui-aabbccdd11223344', createdAt: 2 },
    ]))
    const items = await completers.resume!('', new AbortController().signal)
    expect(items.map(i => i.value)).toEqual(['tui-aabbccdd', 'tui-00112233'])
    expect(items.map(i => i.description)).toEqual([
      'tui-aabbccdd11223344',
      'tui-0011223344556677',
    ])
  })

  it('falls back to the full id when it has no shortenable shape', async () => {
    const completers = buildArgCompleters(fakeDriver([], [
      { id: 'plain-id', createdAt: 1 },
    ]))
    const items = await completers.resume!('', new AbortController().signal)
    expect(items).toEqual([{ value: 'plain-id', label: 'plain-id' }])
  })
})
