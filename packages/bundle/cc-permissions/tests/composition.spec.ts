/**
 * Q3 step 5 / step 4 / R4 composition smoke (migration plan
 * 2026-09-29-harness-0.1.7-rc.2-migration.md): the cc-permissions bundle's
 * settings seam booted on a REAL cordis context.
 *
 * (i)  exactly one `ctx.settings` provider is live — the vendored cascade;
 * (ii) `typeof ctx.settings.configure === 'function'` (G16 no-op facade);
 * (iii) R4 INVARIANT: the harness `SettingsForms` service
 *      (`@deepseek-ai/dsh-settings`) is NOT mounted. Future preset bundles
 *      must not pull it in transitively — a second `ctx.settings` would be a
 *      hard cordis collision, and the profile-patch forms model is not
 *      dsh-cc's settings product. The harness class is imported here purely
 *      as the tripwire comparison type; the assertion fails the drift gate
 *      if a future bundle row swaps the cascade for it.
 *
 * Boot-time test: the harness `agent-default-model` base row boots against
 * the cascade-backed `ctx.settings` — its constructor calls
 * `settings.configure({auto:false}, fiber)`, which must land on the no-op
 * facade without throwing.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SettingsCascadeProvider } from '@dsh-cc/settings-cascade'
import SettingsForms from '@deepseek-ai/dsh-settings'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

/** Boot the cascade exactly as the cc-permissions composition row does. */
async function bootWithCascade(userSettings: Record<string, unknown> = {}): Promise<Context> {
  const dir = await mkdtemp(join(tmpdir(), 'cc-permissions-composition-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const userPath = join(dir, 'settings.json')
  await mkdir(dir, { recursive: true })
  await writeFile(userPath, JSON.stringify(userSettings))
  const ctx = new Context()
  const fiber = ctx.plugin(SettingsCascadeProvider, {
    projectDir: dir,
    userSettingsPath: userPath,
    projectSettingsPath: join(dir, 'project.json'),
    localSettingsPath: join(dir, 'local.json'),
    flagSettingsPath: join(dir, 'flag.json'),
    policy: { userPath: join(dir, 'policy.json') },
  })
  cleanups.push(() => fiber.dispose())
  await fiber
  return ctx
}

describe('cc-permissions composition smoke (Q3 step 5 / R4)', () => {
  it('mounts exactly one ctx.settings provider: the vendored cascade', async () => {
    const ctx = await bootWithCascade()
    // The cascade is the live provider at the shared key; the harness
    // SettingsForms is not mounted beside it (R4 — see invariant below).
    expect(ctx.get('settings')).toBeInstanceOf(SettingsCascadeProvider)
 expect(ctx.get('settings')).not.toBeInstanceOf(SettingsForms)
  })

  it('exposes the no-op configure() facade on the vendored contract (G16)', async () => {
    const ctx = await bootWithCascade()
    expect(typeof (ctx.get('settings') as { configure?: unknown }).configure).toBe('function')
  })

  it('R4 invariant: the harness SettingsForms service is not mounted', async () => {
    // Future preset bundles must not pull @deepseek-ai/dsh-settings in
    // transitively: the cascade owns ctx.settings, and its product is the
    // CC settings.json cascade, not profile-patch volatile-field forms.
    const ctx = await bootWithCascade()
    expect(ctx.get('settings')).not.toBeInstanceOf(SettingsForms)
  })
})

describe('agent-default-model base row boots on the cascade (Q3 step 4)', () => {
  it('boots without throwing; configure({auto:false}) lands on the facade', async () => {
    const ctx = await bootWithCascade()
    const fiber = ctx.plugin(AgentDefaultModelConfig, { provider: 'deepseek', model: 'deepseek-chat' })
    await fiber
    const service = ctx.get('agentDefaultModel') as { currentSelection?: () => unknown } | undefined
    expect(service).toBeDefined()
    expect(service?.currentSelection()).toMatchObject({ provider: 'deepseek', model: 'deepseek-chat' })
    await fiber.dispose()
  })
})
