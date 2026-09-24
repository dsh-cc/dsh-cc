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
import { mountRules, type RulesSeam } from './rules.ts'
import { mountMcpServers } from './mcp.ts'
import { mountSettings } from './settings.ts'
import { resolvePluginManifest } from './resolve-manifest.ts'
import { mountActorContractGate, type ActorContractGate } from './actor-contract-gate.ts'
export {
  ACTOR_CONTRACT_NAMESPACE,
  DEFAULT_ACTOR_CONTRACT_MODELS,
  actorContractSettingsSchema,
  gateCandidates,
  mountActorContractGate,
  ActorContractGate,
} from './actor-contract-gate.ts'
export type { ActorContractSettings } from './actor-contract-gate.ts'

export type { CcPluginManifest, CcCommand, CcSkillRef, CcAgentRef, CcMcpServer, ComponentKind, ComponentResult, PluginLoadReport, PluginFlavor } from './types.ts'
export type { CcPluginCommandInfo, MountedPluginCommand } from './commands.ts'
export { parsePluginManifest, globPathKind } from './manifest.ts'
export {
  discoverCcPluginRoots,
  resolveClaudeHome,
  NESTED_MANIFEST,
  CURSOR_MANIFEST,
  TOP_LEVEL_MANIFEST,
  MANIFEST_CANDIDATE_DIRS,
  MARKETPLACE_CANDIDATE_FILES,
  findPluginManifestPath,
  findPluginManifestPaths,
  findMarketplaceManifestPath,
} from './discovery.ts'
export type { DiscoveredCcPlugin, DiscoverCcPluginRootsOptions } from './discovery.ts'
export { AgentProvider, STANDARD_AGENTS_DIR, PLUGIN_AGENT_PROVIDER_BRAND, isPluginAgentProvider } from './agents.ts'
export type { ResolveModel } from './agents.ts'
export type { McpSeam, HooksSeam, RulesSeam } from './seams.ts'
export { ComponentTally } from './seams.ts'
export type { RuleEntry, TurnRuleChannel } from './types.ts'
export { mountRules, parseRuleFile } from './rules.ts'
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
  /** Rules merge seam (guest; absent in the harness today). */
  rules?: RulesSeam | undefined
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
  /**
   * The plugin mount's local actor-contract gate (the live reader
   * `AgentProvider.start` consults; drive `setSource`/`onChange` to simulate
   * a settings hot reload).
   */
  gate: ActorContractGate
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
    flavor: resolved.flavor,
    warnings: resolved.warnings,
  })
  const probed = await probeSeams(ctx, options.seams)
  const disposers: (() => void)[] = []
  const components: ComponentResult[] = []
  const mountWarnings: string[] = []
  // Actor-contract gate (§3.2): install the settings section (no cordis
  // service — the task package owns `ccActorContractGate`) and thread the
  // live patterns into every mounted agent's spawn seam.
  const gate = mountActorContractGate(ctx)
  const gatePatterns = (): readonly string[] => gate.patterns()

  let commandMount: ReturnType<typeof mountCommands>
  try {
    fold(components, disposers, await mountSkills({
      ctx,
      pluginRoot: root,
      manifest,
      skills: probed.skills,
      subagentsPresent: probed.subagents !== undefined,
    }), mountWarnings)
    fold(components, disposers, await mountAgents({
      pluginRoot: root,
      manifest,
      subagents: probed.subagents,
      ...options.resolveModel !== undefined ? { resolveModel: options.resolveModel } : {},
      gatePatterns,
      // Same name-resolution chain as the manifest itself: manifest name (the
      // parse/synthesis in resolve-manifest already falls back to nameHint,
      // then the root basename), used to namespace agent provider names.
      namespacePrefix: manifest.name,
    }), mountWarnings)
    commandMount = mountCommands({ pluginRoot: root, manifest, commands: probed.commands })
    components.push(commandMount.tally.result())
    mountWarnings.push(...commandMount.warnings ?? [])
    disposers.push(...commandMount.disposers)
    fold(components, disposers, mountHooks({ pluginRoot: root, manifest, hooks: probed.hooks }), mountWarnings)
    // Rules (Cursor dialect) mount after hooks, before mcpServers (plan §3.3).
    // A manifest declaring no rules mounts no rules component (cc zero-change).
    if (manifest.rules.length > 0) {
      fold(components, disposers, await mountRules({ pluginRoot: root, manifest, rules: probed.rules }), mountWarnings)
    }
    fold(components, disposers, mountMcpServers({ pluginRoot: root, manifest, mcp: probed.mcp }), mountWarnings)
    fold(components, disposers, mountSettings({ manifest, settings: probed.settings }), mountWarnings)
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
    report: { name: manifest.name, flavor: manifest.flavor, warnings: [...manifest.warnings, ...mountWarnings], components },
    commands: commandMount.mounted,
    gate,
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
    rules: overrides?.rules ?? ctx.get('rules') as RulesSeam | undefined,
    mcp: overrides?.mcp ?? ctx.get('mcp') as McpSeam | undefined,
  }
}

/** Fold one component mount into the report and disposer list. */
function fold(
  components: ComponentResult[],
  disposers: (() => void)[],
  mount: { disposers: (() => void)[]; tally: ComponentTally; warnings?: readonly string[] },
  mountWarnings: string[],
): void {
  components.push(mount.tally.result())
  disposers.push(...mount.disposers)
  mountWarnings.push(...mount.warnings ?? [])
}
