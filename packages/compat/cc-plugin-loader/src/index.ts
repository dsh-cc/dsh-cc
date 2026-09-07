/**
 * A Claude Code `plugin.json` compatibility loader: reads a CC plugin manifest
 * and mounts each component as an in-memory dsh plugin.
 *
 * The loader is peer-style: it parses the manifest subset, translates each
 * component with the pure helpers from `dsh-skill-claude-code` and
 * `dsh-claude-code-agents`, then consults the host seam for that component via
 * `ctx.get(...)`. A component whose seam is absent is reported skipped (never a
 * whole-load failure), matching "misconfiguration fails loud" for the manifest
 * itself but graceful degradation for missing host seams. Every component
 * mount is a Cordis effect, so disabling the plugin recalls all of it.
 *
 * @module @dsh-cc/plugin-loader
 */

import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { parsePluginManifest } from './manifest.ts'
import { ComponentTally } from './seams.ts'
import type { HooksSeam } from './hooks.ts'
import type { McpSeam } from './mcp.ts'
import type { CommandsSeam } from './commands.ts'
import type { SettingsSeam } from './settings.ts'
import type { ComponentResult, PluginLoadReport } from './types.ts'
import { mountSkills, type SkillsSeam } from './skills.ts'
import { mountAgents, type ResolveModel, type SubagentsSeam } from './agents.ts'
import { mountCommands, type MountedPluginCommand } from './commands.ts'
import { mountHooks } from './hooks.ts'
import { mountMcpServers } from './mcp.ts'
import { mountSettings } from './settings.ts'
import { resolvePluginManifest } from './resolve-manifest.ts'

export type { CcPluginManifest, CcCommand, CcSkillRef, CcAgentRef, CcMcpServer, ComponentKind, ComponentResult, PluginLoadReport } from './types.ts'
export type { CcPluginCommandInfo, MountedPluginCommand } from './commands.ts'
export { parsePluginManifest } from './manifest.ts'
export { discoverCcPluginRoots, resolveClaudeHome, NESTED_MANIFEST, TOP_LEVEL_MANIFEST } from './discovery.ts'
export type { DiscoveredCcPlugin, DiscoverCcPluginRootsOptions } from './discovery.ts'
export { AgentProvider, STANDARD_AGENTS_DIR, PLUGIN_AGENT_PROVIDER_BRAND, isPluginAgentProvider } from './agents.ts'
export type { ResolveModel } from './agents.ts'
export type { McpSeam, HooksSeam } from './seams.ts'
export {
  skillToolRestriction,
  resolveSkillExecution,
  forbidsInlineShell,
  activationFor,
  registerSkillPathActivator,
  applySkillRestriction,
  PROVIDER,
  type AgentScope,
  type SkillExecution,
  type SkillActivation,
} from './skill-semantics.ts'

/** The plugin.json file name at a plugin root (legacy / fixture path). */
export const MANIFEST_FILE = 'plugin.json'

/** The component host seams the loader probes. */
export interface MountedSeams {
  /** Skill registry seam. */
  skills?: SkillsSeam | undefined
  /** Subagent registry seam. */
  subagents?: SubagentsSeam | undefined
  /** Command registry seam. */
  commands?: CommandsSeam | undefined
  /** Settings seam. */
  settings?: SettingsSeam | undefined
  /** Hooks bridge seam (guest; absent in the harness today). */
  hooks?: HooksSeam | undefined
  /** MCP server seam (guest; absent in the harness today). */
  mcp?: McpSeam | undefined
}

/** Options for mounting one Claude Code plugin. */
export interface MountCcPluginOptions {
  /** The plugin root directory holding `plugin.json` and its components. */
  readonly root: string
  /** Installed plugin name (no `@marketplace`); matches a marketplace overlay. */
  readonly nameHint?: string
  /** Optional seam overrides; when omitted the loader probes `ctx.get(...)`. */
  readonly seams?: MountedSeams
  /** Optional spawn-time model resolver threaded into every mounted agent. */
  readonly resolveModel?: ResolveModel
}

/** The structural report plus a disposer that recalls every mounted component. */
export interface CcPluginMount {
  /** The structural load report. */
  report: PluginLoadReport
  /** The plugin's mounted slash commands (colon display names, host-served). */
  commands: MountedPluginCommand[]
  /**
   * Recall every mounted component. Effect-scoped: calling it also releases
   * the Cordis effect, and a context teardown calls it automatically.
   */
  dispose(): void
}

/**
 * Load a Claude Code plugin manifest and mount its components.
 * @param ctx - active context carrying the component host seams.
 * @param options - plugin root and optional seam overrides.
 * @returns the structural report and a disposer that recalls every mount.
 * @throws when the manifest itself is invalid (with the plugin path/name).
 */
export async function mountCcPlugin(ctx: Context, options: MountCcPluginOptions): Promise<CcPluginMount> {
  const root = resolve(options.root)
  const resolved = resolvePluginManifest(root, options.nameHint)
  const manifest = parsePluginManifest(resolved.raw, root, {
    skillsReplaceDefault: resolved.skillsReplaceDefault,
  })
  const probed = await probeSeams(ctx, options.seams)
  const disposers: (() => void)[] = []
  const components: ComponentResult[] = []

  let commandMount: ReturnType<typeof mountCommands>
  try {
    fold(components, disposers, await mountSkills({
      ctx,
      pluginRoot: root,
      manifest,
      skills: probed.skills,
      subagentsPresent: probed.subagents !== undefined,
    }))
    fold(components, disposers, await mountAgents({
      pluginRoot: root,
      manifest,
      subagents: probed.subagents,
      ...options.resolveModel !== undefined ? { resolveModel: options.resolveModel } : {},
      // Same name-resolution chain as the manifest itself: manifest name (the
      // parse/synthesis in resolve-manifest already falls back to nameHint,
      // then the root basename), used to namespace agent provider names.
      namespacePrefix: manifest.name,
    }))
    commandMount = mountCommands({ pluginRoot: root, manifest, commands: probed.commands })
    components.push(commandMount.tally.result())
    disposers.push(...commandMount.disposers)
    fold(components, disposers, mountHooks({ pluginRoot: root, manifest, hooks: probed.hooks }))
    fold(components, disposers, mountMcpServers({ pluginRoot: root, manifest, mcp: probed.mcp }))
    fold(components, disposers, mountSettings({ manifest, settings: probed.settings }))
  } catch (error) {
    // Component-level rollback: a component mount that throws after earlier
    // components succeeded recalls everything mounted so far, so a failed
    // plugin load leaves nothing mounted.
    for (const dispose of disposers) dispose()
    throw error
  }

  const tearDown = () => {
    for (const dispose of disposers) dispose()
  }
  const effectDisposer = ctx.effect(() => tearDown, 'cc-plugin-loader.mount')

  return {
    report: { name: manifest.name, components },
    commands: commandMount.mounted,
    dispose: () => effectDisposer(),
  }
}

/** Probe each component host seam, preferring explicit overrides. */
async function probeSeams(ctx: Context, overrides: MountedSeams | undefined): Promise<MountedSeams> {
  return {
    skills: overrides?.skills ?? ctx.get('skills') as SkillsSeam | undefined,
    subagents: overrides?.subagents ?? ctx.get('subagents') as SubagentsSeam | undefined,
    commands: overrides?.commands ?? ctx.get('commands') as CommandsSeam | undefined,
    settings: overrides?.settings ?? ctx.get('settings') as SettingsSeam | undefined,
    hooks: overrides?.hooks ?? ctx.get('hooks') as HooksSeam | undefined,
    mcp: overrides?.mcp ?? ctx.get('mcp') as McpSeam | undefined,
  }
}

/** Fold one component mount into the report and disposer list. */
function fold(
  components: ComponentResult[],
  disposers: (() => void)[],
  mount: { disposers: (() => void)[]; tally: ComponentTally },
): void {
  components.push(mount.tally.result())
  disposers.push(...mount.disposers)
}
