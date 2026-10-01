/**
 * Q1 integration leg (docs/plans/2026-09-30-harness-0.2.0-rc.2-migration.md §4 Q1):
 * mounts the provider-bridge against the REAL linked-harness ConfigEditor
 * (@deepseek-ai/dsh-config-editor) booted through a real Loader composition —
 * NOT the contract doubles of provider-bridge.spec.ts (its header at :27 and
 * its "real provider" fixture at :213 both double ConfigEditor). This closes
 * the incident-#3 blind spot: the migration guard must treat ONLY a
 * profile-layer override that diverges from the incoming settings.json value
 * as a conflict; a pure composition/inherited composite default (the stock
 * base bundle's agent-default-model row) must not block migration.
 *
 * If upstream's configuration()/entries() layered contract drifts, the
 * sanity leg below fails loudly instead of degrading to the presence
 * fallback.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import DefaultModel from '@deepseek-ai/dsh-agent-default-model'
import { SettingsProvider, type SettingsNamespace } from '@dsh-cc/settings-provider'
import { DEFAULT_MODEL_ENTRY_ID, ensureProviderBridge } from '../src/provider-bridge.ts'

/** In-memory provider over which the bridge's settings seam runs (same shape
 * as provider-bridge.spec.ts's MemorySettings — real vendored provider). */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown>

  constructor(ctx: ConstructorParameters<typeof SettingsProvider>[0], options?: { doc?: Record<string, unknown> }) {
    super(ctx)
    this.doc = structuredClone(options?.doc ?? {})
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected async persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
  }

  get writable(): boolean {
    return true
  }
}

/** Stand-in for the harness settings builtin: DefaultModel requires a
 * `settings` service (it calls `configure({ auto: false })` at setup); the
 * bridge's own settings seam comes from the MemorySettings root instead. */
class FakeSettingsBuiltin extends Service {
  configure(): { dispose(): void } {
    return { dispose() {} }
  }
}

type CfgRow = { entry: { options: { id?: unknown; config?: Record<string, unknown> } }; inherited: Record<string, unknown>; override: Record<string, unknown> }

/**
 * Mount a real composition: bundle patch carries the config-editor +
 * settings + agent-default-model rows (composite default mirrors the stock
 * base bundle pair), the given profile patch (if any) is written to the
 * profile patch path BEFORE boot, and the settings.json user doc lives on a
 * separate real SettingsProvider root. Returns the overlay ctx the bridge
 * consumes, the live ConfigEditor, the warns spy, and the patch file text.
 */
async function mount(opts: { userDoc?: Record<string, unknown>; profilePatch?: unknown[] } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'bridge-cfg-editor-')))
  const dir = join(home, 'profiles', 'test')
  onTestFinished(() => { rmSync(home, { recursive: true, force: true }) })
  initProfile(dir, ['test-bundle'])
  const bundle = join(dir, 'node_modules', 'test-bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(home, 'package.json'), '{"name":"test-installation"}\n')
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: DEFAULT_MODEL_ENTRY_ID, name: 'cordis:model', config: { provider: 'deepseek-official', model: 'deepseek-flash' } },
  ] }]))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  if (opts.profilePatch !== undefined) writeFileSync(join(dir, 'cordis.patch.yml'), JSON.stringify(opts.profilePatch))
  const profile: ProfileContext = {
    name: 'test', startedBundles: ['test-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
  }
  const root = new Context()
  await root.plugin(MemorySettings, { doc: opts.userDoc ?? {} })
  const settings = root.get('settings') as MemorySettings
  const warns: unknown[] = []
  const warn = vi.fn((message: unknown) => warns.push(message))
  const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (bctx) => {
    bctx.provide('profileContext', profile)
    bctx.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
    Object.assign(bctx.loader.builtins, { editor: ConfigEditor, model: DefaultModel, settings: FakeSettingsBuiltin })
  })
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const editor = (ctx as unknown as { configEditor: ConfigEditor }).configEditor
  // Overlay ctx: the bridge sees the REAL mounted configEditor, the real
  // vendored SettingsProvider (settings.json sections), and a warn spy.
  const bridgeCtx = {
    get: (key: string) => key === 'settings' ? settings
      : key === 'logger' ? { warn }
        : key === 'configEditor' ? editor
          : (ctx as unknown as Record<string, unknown>)[key],
  }
  return {
    bridgeCtx, editor, warns, profile,
    rows: () => editor.configuration(),
    row: () => editor.configuration().find(candidate => candidate.entry.options.id === DEFAULT_MODEL_ENTRY_ID)!,
    patchFileText: () => readFileSync(profile.patchPath, 'utf8'),
  }
}

const USER = { provider: 'orchestrix', model: 'llmbox_ant/glm-5.3' }
const COMPOSITE = { provider: 'deepseek-official', model: 'deepseek-flash' }
const OVERRIDE = { provider: 'user-anthropic', model: 'user-claude' }

it('leg A — pure composite default: migration proceeds, no conflict warn', async () => {
  const { bridgeCtx, editor, warns, row, patchFileText } = await mount({
    userDoc: { 'agent-default-model': USER },
    // No profile patch row for agent-default-model: only the bundle's
    // composite default (inherited layer) is present.
  })
  await ensureProviderBridge(bridgeCtx)
  // Observable: NO conflict warn, and the mirrored user section landed as the
  // profile-layer override (edit() wrote the patch file — the incident-#3 fix,
  // "pure inherited must not block").
  expect(warns).toHaveLength(0)
  const current = row()
  expect(current.override).toEqual(USER)
  expect((current.entry.options.config ?? {})['provider']).toBe(USER.provider)
  expect(patchFileText()).toContain(USER.provider)
  void editor
}, 30_000)

it('leg B — diverging profile-layer override wins: warn once, no clobber', async () => {
  const { bridgeCtx, warns, row, patchFileText } = await mount({
    userDoc: { 'agent-default-model': USER },
    profilePatch: [{ id: DEFAULT_MODEL_ENTRY_ID, config: OVERRIDE }],
  })
  await ensureProviderBridge(bridgeCtx)
  // Observable: exactly one conflict warn, the user's profile override is
  // still the row's override/current, and the incoming value never clobbered it.
  expect(warns).toHaveLength(1)
  expect(String(warns[0])).toContain(DEFAULT_MODEL_ENTRY_ID)
  const current = row()
  expect(current.override).toEqual(OVERRIDE)
  expect((current.entry.options.config ?? {})).toEqual(expect.objectContaining(OVERRIDE))
  expect(patchFileText()).not.toContain(USER.provider)
}, 30_000)

it('sanity — the mounted ConfigEditor genuinely yields the layered view', async () => {
  const { rows, row } = await mount({})
  const current = row()
  // A drift that removes the layered view must fail LOUDLY here (the bridge
  // would then degrade to the presence fallback and silently regress Q1).
  expect(Object.keys(current)).toEqual(expect.arrayContaining(['override', 'inherited']))
  expect(current.inherited).toEqual(COMPOSITE)
  expect(current.override).toEqual({})
  expect(rows().map(r => String(r.entry.options.id))).toContain(DEFAULT_MODEL_ENTRY_ID)
}, 30_000)
