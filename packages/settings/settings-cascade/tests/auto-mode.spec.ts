import { describe, expect, it } from 'vitest'
import { AutoModeSchema } from '../src/auto-mode.ts'
import { mergeSettingsSection } from '../src/merge.ts'

/** Parse an autoMode object or throw. */
function parse(value: unknown): unknown {
  // Schemastery schemas are callable; a rejected value throws.
  return (AutoModeSchema as unknown as (v: unknown) => unknown)(value)
}

describe('AutoModeSchema', () => {
  it('parses a complete autoMode object', () => {
    const value = {
      soft_deny: ['$defaults', 'Never run terraform apply'],
      classifier: { enabled: true, route: 'haiku', timeoutMs: 8000, cacheMaxEntries: 256 },
    }
    expect(parse(value)).toEqual(value)
  })

  it('keeps absent keys absent — no defaults materialized (classifier stays disarmed)', () => {
    expect(parse({})).toEqual({})
    // classifyAllShell is absence-preserving: absent stays absent.
    expect(parse({ classifyAllShell: true })).toEqual({ classifyAllShell: true })
    expect(parse({ soft_deny: ['a'] })).toEqual({ soft_deny: ['a'] })
    // S4: hard_deny is absence-preserving (permissive array, no default).
    expect(parse({})).toEqual({})
    expect(parse({ hard_deny: ['never do X'] })).toEqual({ hard_deny: ['never do X'] })
    expect(() => parse({ hard_deny: 'never do X' })).toThrow()
    expect(parse({ classifier: {} })).toEqual({
      classifier: { enabled: false, timeoutMs: 8000, cacheMaxEntries: 256 },
    })
    // `route` is absence-preserving now (the policy helper decides when unset).
    expect(parse({ classifier: { route: 'sonnet' } })).toEqual({
      classifier: { enabled: false, route: 'sonnet', timeoutMs: 8000, cacheMaxEntries: 256 },
    })
    // backend / gaugeAllowThreshold are accepted and absence-preserving.
    expect(parse({ classifier: { backend: 'auto', gaugeAllowThreshold: 0.9 } })).toEqual({
      classifier: { enabled: false, backend: 'auto', gaugeAllowThreshold: 0.9, timeoutMs: 8000, cacheMaxEntries: 256 },
    })
    // gaugeAllowEvidence (Fix B) is absence-preserving too; the consumption
    // default is true (the gauge stage decides), false is the kill switch.
    expect(parse({ classifier: {} })).toEqual({
      classifier: { enabled: false, timeoutMs: 8000, cacheMaxEntries: 256 },
    })
    expect(parse({ classifier: { gaugeAllowEvidence: false } })).toEqual({
      classifier: { enabled: false, gaugeAllowEvidence: false, timeoutMs: 8000, cacheMaxEntries: 256 },
    })
    expect(() => parse({ classifier: { gaugeAllowEvidence: 'yes' } })).toThrow()
    expect(() => parse({ classifier: { backend: 'gpt' } })).toThrow()
  })

  it('normalizes a partial classifier object with defaults', () => {
    expect(parse({ classifier: { enabled: true } })).toEqual({
      classifier: { enabled: true, timeoutMs: 8000, cacheMaxEntries: 256 },
    })
  })

  it('preserves unknown fields (passthrough, mirroring PermissionsSchema)', () => {
    const result = parse({ soft_deny: ['a'], customField: { nested: 1 } }) as Record<string, unknown>
    expect(result['soft_deny']).toEqual(['a'])
    expect(result['customField']).toEqual({ nested: 1 })
  })

  it('rejects a non-array soft_deny', () => {
    expect(() => parse({ soft_deny: 'terraform apply' })).toThrow()
  })

  it('rejects non-boolean enabled and non-string route', () => {
    expect(() => parse({ classifier: { enabled: 'yes' } })).toThrow()
    expect(() => parse({ classifier: { route: 7 } })).toThrow()
  })

  it('probe sub-section (S7): defaults apply when the object is present, absent key stays absent', () => {
    // Absence-preserving: no probe key, no probe defaults.
    expect(parse({})).toEqual({})
    expect(parse({ probe: {} })).toEqual({
      probe: { enabled: true, timeoutMs: 5000 },
    })
    expect(parse({ probe: { enabled: false } })).toEqual({
      probe: { enabled: false, timeoutMs: 5000 },
    })
    // `route` is absence-preserving (the policy helper decides when unset).
    expect(parse({ probe: { route: 'fast-lane' } })).toEqual({
      probe: { enabled: true, route: 'fast-lane', timeoutMs: 5000 },
    })
    // backend is accepted and absence-preserving (PR-C).
    expect(parse({ probe: { backend: 'auto' } })).toEqual({
      probe: { enabled: true, backend: 'auto', timeoutMs: 5000 },
    })
    expect(() => parse({ probe: { backend: 'gpt' } })).toThrow()
    // toolPatterns is absence-preserving (permissive array, no default).
    expect(parse({ probe: { toolPatterns: ['grep*'] } })).toEqual({
      probe: { enabled: true, timeoutMs: 5000, toolPatterns: ['grep*'] },
    })
    expect(() => parse({ probe: { enabled: 'yes' } })).toThrow()
    expect(() => parse({ probe: { timeoutMs: 'slow' } })).toThrow()
    expect(() => parse({ probe: { toolPatterns: 'grep' } })).toThrow()
  })
})

describe('autoMode cascade layering (permissions.autoMode delivery route)', () => {
  /**
   * The delivery route is `permissions.autoMode` — an `autoMode` key INSIDE
   * the existing `permissions` namespace (camelCase key inside a kebab
   * namespace section, like `defaultMode`/`protectedFiles`). Claude Code's
   * root-level `autoMode` key is NOT honored: top-level namespace names must
   * be kebab-case upstream, and the cascade never claims a root `autoMode`
   * section. These tests drive the exact cross-file merge path
   * (`mergeSettingsSection`, the `load()` reducer) with full
   * `{ permissions: { autoMode } }` documents.
   */
  function mergedAutoMode(lower: unknown, higher: unknown): unknown {
    const merged = mergeSettingsSection(
      { permissions: { autoMode: lower } },
      { permissions: { autoMode: higher } },
    )
    const permissions = merged['permissions'] as Record<string, unknown>
    return parse(permissions['autoMode'])
  }

  it('deep-merges permissions.autoMode.classifier across file layers, higher layer winning scalars', () => {
    const user = {
      soft_deny: ['$defaults'],
      classifier: { route: 'haiku' },
    }
    const local = {
      classifier: { enabled: true, timeoutMs: 9000 },
    }
    expect(mergedAutoMode(user, local)).toEqual({
      soft_deny: ['$defaults'],
      classifier: { enabled: true, route: 'haiku', timeoutMs: 9000, cacheMaxEntries: 256 },
    })
  })

  it('overrides soft_deny arrays across layers (no union)', () => {
    const user = { soft_deny: ['a', 'b'] }
    const project = { soft_deny: ['b', 'c'] }
    expect(mergedAutoMode(user, project)).toEqual({ soft_deny: ['b', 'c'] })
  })

  it('keeps autoMode absent end to end when no layer provides it', () => {
    // Absence must survive both the merge (no key materialized) and the
    // schema parse (no defaults injected) so the classifier stays disarmed.
    const merged = mergeSettingsSection(
      { permissions: { allow: ['Read'] } },
      { env: { FOO: 'bar' } },
    )
    const permissions = merged['permissions'] as Record<string, unknown>
    expect('autoMode' in permissions).toBe(false)
    expect(parse(permissions['autoMode'])).toBeUndefined()
  })

  it('adds autoMode from a higher layer when the lower layer lacks it', () => {
    const user = { permissions: { allow: ['Read'] } }
    const local = { permissions: { autoMode: { soft_deny: ['x'] } } }
    const merged = mergeSettingsSection(user, local)
    const permissions = merged['permissions'] as Record<string, unknown>
    expect(parse(permissions['autoMode'])).toEqual({ soft_deny: ['x'] })
  })

  it('keeps rule keys and autoMode coexisting inside one permissions section', () => {
    const merged = mergeSettingsSection(
      { permissions: { allow: ['Read'], autoMode: { classifier: { route: 'haiku' } } } },
      { permissions: { deny: ['Bash(rm -rf)'] } },
    )
    const permissions = merged['permissions'] as Record<string, unknown>
    expect(permissions['allow']).toEqual(['Read'])
    expect(permissions['deny']).toEqual(['Bash(rm -rf)'])
    expect(parse(permissions['autoMode'])).toEqual({ classifier: { enabled: false, route: 'haiku', timeoutMs: 8000, cacheMaxEntries: 256 } })
  })

  it('S5 auditFullText is absence-preserving: absent stays absent; present round-trips; non-boolean rejects', () => {
    expect(parse({ classifier: { enabled: true } })).toEqual({ classifier: { enabled: true, timeoutMs: 8000, cacheMaxEntries: 256 } })
    expect(parse({ classifier: { enabled: true, auditFullText: true } })).toEqual({ classifier: { enabled: true, timeoutMs: 8000, cacheMaxEntries: 256, auditFullText: true } })
    expect(() => parse({ classifier: { auditFullText: 'yes' } })).toThrow()
  })

  it('D13 secondPass is absence-preserving: absent stays absent; present round-trips', () => {
    expect(parse({ classifier: { enabled: true } })).toEqual({ classifier: { enabled: true, timeoutMs: 8000, cacheMaxEntries: 256 } })
    expect(parse({ classifier: { enabled: true, secondPass: true } })).toEqual({ classifier: { enabled: true, timeoutMs: 8000, cacheMaxEntries: 256, secondPass: true } })
  })
})
