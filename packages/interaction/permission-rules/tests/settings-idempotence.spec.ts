/**
 * Regression spec (plan §3.3): permission-rules installs its settings section
 * on every mount via `installSectionSafe`; mounting the plugin TWICE against
 * the SAME (fake) settings provider — the `/clear` overlap — must not throw,
 * must not call `installSection` a second time (the preflight path), and the
 * second mount must still reload on a `settings/updated` commit.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@dsh-cc/tools'
import PermissionRules, { PERMISSION_SETTINGS_NAMESPACE } from '@dsh-cc/permission-rules'

type Listener = (ns: string, ...rest: unknown[]) => unknown

/**
 * Fake settings provider (NOT a SettingsProvider subclass): records
 * installSection calls, throws the pinned duplicate message on re-register,
 * and exposes the `settings/updated` commit seam the preflight path listens
 * on. Mirrors the real provider's semantics: a registered namespace's `get`
 * returns the base-resolved entry (never undefined while registered).
 */
function fakeSettingsProvider() {
  const registrations = new Set<string>()
  const doc: Record<string, Record<string, unknown>> = {}
  const listeners = new Set<Listener>()
  const watchers = new Set<(ns: string) => void>()
  let installCalls = 0
  const provider = {
    installCalls: () => installCalls,
    register(ns: string) {
      if (registrations.has(ns)) throw new Error(`settings namespace "${ns}" is already registered`)
      registrations.add(ns)
    },
    get(ns: string) {
      return registrations.has(ns) ? structuredClone(doc[ns] ?? {}) : undefined
    },
    installSection(_owner: unknown, ns: string, _schema: unknown, entry: Record<string, unknown>, hooks: {
      setSource(current: () => unknown): void
      onChange(): void
    }) {
      installCalls++
      if (registrations.has(ns)) throw new Error(`settings namespace "${ns}" is already registered`)
      registrations.add(ns)
      doc[ns] = structuredClone(entry)
      hooks.setSource(() => provider.get(ns))
      // Mirror the real provider's scope.watch: the fresh-path consumer
      // reloads when the namespace commits.
      watchers.add(committedNs => { if (committedNs === ns) hooks.onChange() })
      hooks.onChange()
    },
    ctx: {
      on(_event: string, listener: Listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    /** Test seam: commit a section and fan out the settings/updated event. */
    commit(ns: string, value: Record<string, unknown>) {
      doc[ns] = value
      for (const listener of listeners) listener(ns, structuredClone(value))
      for (const watch of watchers) watch(ns)
    },
  }
  return provider
}

/** Mount the permission-rules plugin over a shared fake settings provider. */
async function mount(provider: unknown): Promise<Context> {
  const ctx = new Context()
  ctx.provide('settings', provider)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(PermissionRules, {
    fileEditTools: ['edit'],
    readOnlyTools: ['read'],
    bashToolName: 'Bash',
  })
  return ctx
}

describe('permission-rules duplicate settings-section tolerance', () => {
  it('mounts twice against the same provider; the second falls to the preflight path and still reloads', async () => {
    const provider = fakeSettingsProvider()
    const ctxA = await mount(provider)
    expect(ctxA.permissionRules.defaultMode).toBe('default')

    // Second mount against the SAME provider: installSection must NOT fire
    // again (its internal register would throw); the preflight path wires
    // live reads + the settings/updated event instead.
    const ctxB = await mount(provider)
    expect(provider.installCalls()).toBe(1)

    provider.commit(PERMISSION_SETTINGS_NAMESPACE, { defaultMode: 'acceptEdits' })
    expect(ctxA.permissionRules.defaultMode).toBe('acceptEdits')
    expect(ctxB.permissionRules.defaultMode).toBe('acceptEdits')
  })

  it('absent settings leaves only the Config rules in force (inject contract)', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(PermissionRules, {
      fileEditTools: ['edit'],
      readOnlyTools: ['read'],
      bashToolName: 'Bash',
      defaultMode: 'acceptEdits',
    })
    expect(ctx.permissionRules.defaultMode).toBe('acceptEdits')
  })
})
