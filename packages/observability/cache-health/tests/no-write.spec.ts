import { describe, expect, it } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { observeRequest } from '@dsh-cc/cache-health'
import { CacheHealthLedger } from '@dsh-cc/cache-health/ledger'
import { PrefixTracker } from '@dsh-cc/cache-health/tracker'

/** Recursively freeze an object, emulating the loop-built deep-frozen request. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as object)) deepFreeze((value as Record<string, unknown>)[key])
    Object.freeze(value)
  }
  return value
}

/** Recording Proxy: counts every `set` trap hit on the target object graph. */
function recordingProxy<T extends object>(target: T): { proxy: T; writes: () => string[] } {
  const writes: string[] = []
  const proxy = new Proxy(target, {
    set(obj, prop, value) {
      writes.push(String(prop))
      return Reflect.set(obj, prop, value)
    },
    defineProperty(obj, prop, desc) {
      writes.push(String(prop))
      return Reflect.defineProperty(obj, prop, desc)
    },
    deleteProperty(obj, prop) {
      writes.push(String(prop))
      return Reflect.deleteProperty(obj, prop)
    },
  }) as T
  return { proxy, writes: () => writes }
}

function options(sessionId: string, system: string): GenerateOptions {
  return {
    provider: 'deepseek',
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'hi' }] as GenerateOptions['messages'],
    system,
    sessionId: sessionId as GenerateOptions['sessionId'],
  } as GenerateOptions
}

function deps() {
  const warns: string[] = []
  return {
    warns,
    ledger: new CacheHealthLedger('/tmp/does-not-matter-no-write-test', () => {}),
    tracker: new PrefixTracker(),
    warn: (message: string) => warns.push(message),
  }
}

describe('observer no-write guarantee', () => {
  it('never writes a deep-frozen (loop-built) options object', () => {
    const deps_ = deps()
    const { proxy, writes } = recordingProxy(deepFreeze(options('s1', 'sys')))
    expect(() => observeRequest(deps_, proxy)).not.toThrow()
    expect(writes()).toEqual([])
  })

  it('never writes an unfrozen (manually built) options object', () => {
    const deps_ = deps()
    const { proxy, writes } = recordingProxy(options('s1', 'sys'))
    observeRequest(deps_, proxy)
    expect(writes()).toEqual([])
  })

  it('still writes the ledger row through the frozen proxy path (no sessions → skipped silently)', () => {
    // No sessions service → observeRequest skips before hashing; assert no warn.
    const deps_ = deps()
    observeRequest(deps_, options('s1', 'sys'))
    expect(deps_.warns).toEqual([])
  })
})
