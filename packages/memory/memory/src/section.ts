/**
 * The `memory` system-prompt section: save-channel guidance plus one layer
 * per memory scope — the workspace-private directory, the global directory,
 * and (when `teamEnabled`) the workspace's team directory. Plugins mount once
 * on the root context, so a single global section serves every agent: the
 * text callback receives the assembling agent through `AssembleContext.scope`
 * (the agent loop passes `scope: agent`) and renders that agent's workspace
 * layer. Delegated children (`delegationDepth > 0`) render an empty string so
 * the section drops out of the child prompt. Directory scans run in the
 * background through `ctx.fs`; rendered per-layer fragments are cached and
 * `system-prompt/change` fires only when a fragment actually changed. The
 * section always renders for a top-level agent (a memoryless layer shows a
 * placeholder) so the save guidance never disappears.
 * @module @dsh-cc/memory/section
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'
import { ENTRYPOINT_NAME, truncateEntrypointContent } from './truncate.ts'
import { scanMemoryDirectory } from './scan.ts'
import type { MemoryDirectoryState } from './scan.ts'
import { cwdOf, resolveWorkspaceMemoryDir } from './paths.ts'
import { resolveTeamMemoryRoot } from './team.ts'

/** Default order slot for the memory section (before tool guidance). */
export const MEMORY_SECTION_ORDER = 90

/** The section's unique name. */
export const MEMORY_SECTION_NAME = 'memory'

/**
 * How long the assemble waterfall may wait for a workspace's in-flight first
 * scan before giving up and shipping the placeholder. Bounded so a slow or
 * wedged scan delays the first request by at most this much; the background
 * `system-prompt/change` path remains the fallback.
 */
const READINESS_BUDGET_MS = 500

/**
 * Join `promise`, but reject after `ms` milliseconds either way. The loser
 * keeps running in the background (its eventual rejection is contained); the
 * caller gets a rejection to degrade on.
 */
function withinBudget<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const budget = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`readiness budget of ${ms}ms expired`)), ms)
  })
  budget.catch(() => {})
  return Promise.race([promise, budget]).finally(() => clearTimeout(timer))
}

/** A memory layer surfaced in the section. */
export interface MemoryLayer {
  /** Scope tag shown in the combined index. */
  scope: 'workspace' | 'global' | 'team'
  /** Heading label for the layer's entrypoint block. */
  label: string
  /** The layer's directory. */
  dir: string
  /** The last scanned state, or `undefined` while the first scan is pending. */
  state: MemoryDirectoryState | undefined
}

/**
 * Extract the assembling agent from an `AssembleContext`. The agent loop
 * assembles with `scope: agent` (a runtime contract; `ScopeKey` is opaque),
 * so the scope IS the agent whenever a session drives the assembly.
 */
function agentFromScope(scope: unknown): Agent | undefined {
  if (typeof scope === 'object' && scope !== null && 'session' in scope) {
    return scope as Agent
  }
  return undefined
}

/**
 * Owner of the cached `memory` section text. Holds one scanned state per
 * memory directory so the synchronous section provider can compose the text,
 * and refreshes states from disk.
 */
export class MemorySection {
  private readonly states = new Map<string, MemoryDirectoryState>()
  private readonly fragments = new Map<string, string>()
  private readonly refreshers = new Map<string, Promise<void>>()
  private readonly teamEnabled: boolean

  /**
   * Create a cache holder bounded to a memory home.
   * @param ctx - the host context whose `fs` seam and `system-prompt/change`
   *   channel drive refresh.
   * @param home - the memory home: the global layer's directory, and the root
   *   under which each workspace's private directory lives (`projects/<slug>`).
   * @param options - when `teamEnabled` is set, each workspace also surfaces
   *   its shared team directory (`<workspaceDir>/team`).
   */
  constructor(
    private readonly ctx: Context,
    private readonly home: string,
    options: { teamEnabled?: boolean } = {},
  ) {
    this.teamEnabled = options.teamEnabled ?? false
  }

  /** Register the `memory` section, its assemble-waterfall reconciliation,
   * and start the global layer's first scan.
   *
   * The waterfall listener removes the first-assembly placeholder jitter:
   * `systemPrompt.assemble()` runs BEFORE the agent pre-step, so the section
   * text callback cannot await the directory scans — but the waterfall can.
   * After the base assembly, a scope with unscanned layers joins the
   * in-flight `refresh(agent)` (bounded by {@linkcode READINESS_BUDGET_MS};
   * per-directory refreshers self-deduplicate, so this is the same promise
   * the background scan already started) and re-renders the section with the
   * same render function the section callback uses, so the first assembly
   * already carries the scanned text and no later request sees a different
   * prefix. Timeout or failure keeps the placeholder; the scan lands on a
   * later assembly through `system-prompt/change`. */
  start(): void {
    this.ctx.systemPrompt.section({
      name: MEMORY_SECTION_NAME,
      order: MEMORY_SECTION_ORDER,
      text: (context: { scope?: unknown }): string => this.render(context.scope),
    })
    this.ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const result = await next()
      const agent = agentFromScope(context.scope)
      if (agent === undefined) return result
      if (!isTopLevel(agent)) return result
      if (!this.layersFor(agent).some(layer => layer.state === undefined)) return result
      try {
        await withinBudget(this.refresh(agent), READINESS_BUDGET_MS)
      } catch (error) {
        this.ctx.logger.warn(
          `memory: first-assembly scan did not land within ${READINESS_BUDGET_MS}ms: ${String(error)}; keeping the placeholder`,
        )
        return result
      }
      return {
        ...result,
        sections: result.sections.map(section => section.name === MEMORY_SECTION_NAME
          ? { ...section, text: this.render(agent) }
          : section),
      }
    })
    void this.refresh()
  }

  /**
   * The layers an agent's section renders: its workspace directory plus the
   * global directory, and the workspace's team directory when enabled.
   */
  private layersFor(agent: Agent | undefined): MemoryLayer[] {
    const layers: MemoryLayer[] = []
    if (agent !== undefined) {
      const workspaceDir = resolveWorkspaceMemoryDir(this.home, cwdOf(agent))
      layers.push({
        scope: 'workspace',
        label: 'this workspace',
        dir: workspaceDir,
        state: this.states.get(workspaceDir),
      })
      if (this.teamEnabled) {
        const teamDir = resolveTeamMemoryRoot(workspaceDir)
        layers.push({
          scope: 'team',
          label: 'team',
          dir: teamDir,
          state: this.states.get(teamDir),
        })
      }
    }
    layers.push({
      scope: 'global',
      label: 'global',
      dir: this.home,
      state: this.states.get(this.home),
    })
    return layers
  }

  /** Compose the section text for the agent behind an assemble scope. */
  private render(scope: unknown): string {
    const agent = agentFromScope(scope)
    // Delegated children start fresh (CC Task isolation). The parent prompt
    // must pass any facts the child needs; dumping MEMORY.md into every
    // subagent is the token cost this mute removes. Fail closed: a throw
    // from reading depth treats the agent as a child.
    if (agent !== undefined && !isTopLevel(agent)) return ''
    if (agent !== undefined) {
      // First assembly for this workspace: render placeholders now and scan
      // its directories in the background so the next step sees real content.
      const unknown = this.layersFor(agent).some(layer => layer.state === undefined)
      if (unknown) void this.refresh(agent)
    }
    return renderLayers(this.layersFor(agent))
  }

  /**
   * Re-scan the global directory plus the agent's workspace (and team)
   * directories. Overlapping scans of one directory share a single background
   * promise. Emits `system-prompt/change` only when a rendered fragment
   * actually changed, so an unchanged disk does not churn reassembly.
   * @param agent - whose workspace layers to refresh; omitted = global only.
   */
  async refresh(agent?: Agent): Promise<void> {
    const dirs = this.layersFor(agent).map(layer => layer.dir)
    const scans = dirs.map(dir => this.refreshDir(dir))
    await Promise.all(scans)
  }

  private refreshDir(dir: string): Promise<void> {
    const previous = this.refreshers.get(dir)
    if (previous !== undefined) {
      previous.catch(() => {})
      return previous
    }
    const current = this.scanDir(dir)
    this.refreshers.set(dir, current)
    void current.finally(() => {
      if (this.refreshers.get(dir) === current) this.refreshers.delete(dir)
    })
    return current
  }

  private async scanDir(dir: string): Promise<void> {
    const fileSystem = this.ctx.get('fs')
    if (fileSystem === undefined) return
    const state = await scanMemoryDirectory(fileSystem, dir)
    const fragment = renderLayerFragment({ scope: 'global', label: '', dir, state })
    if (fragment === this.fragments.get(dir)) {
      this.states.set(dir, state)
      return
    }
    this.states.set(dir, state)
    this.fragments.set(dir, fragment)
    this.ctx.emit('system-prompt/change')
  }
}

/**
 * The save-channel guidance every memory section carries. It names the ONLY
 * working save path: direct write/edit calls aimed at a memory directory are
 * fenced by the fs sandbox (memory directories live outside every session
 * workspace), so the model must call `memory_save` instead. Without this line
 * a memoryless session presents no guidance at all and the model falls back
 * to its Claude Code prior (`~/.claude/projects/<slug>/memory/`), whose
 * writes fail the same fence.
 * @param workspaceDir - the workspace memory directory, when known.
 * @param globalDir - the global memory directory.
 * @returns the guidance lines.
 */
export function saveGuidance(workspaceDir: string | undefined, globalDir: string): string[] {
  const target = workspaceDir !== undefined
    ? `this workspace's directory (\`${workspaceDir}\`)`
    : 'the current workspace\'s directory'
  return [
    `To save a durable fact, call the \`memory_save\` tool — it writes the topic file and updates ${ENTRYPOINT_NAME} for you. `
    + `By default the memory lands in ${target}, visible only to sessions of this workspace; `
    + `pass \`scope: "global"\` for facts useful across ALL workspaces (saved to \`${globalDir}\`).`,
    'Never write or edit files under a memory directory directly: the sandbox fences writes outside the session workspace, so direct writes always fail.',
  ]
}

/**
 * Render the memory section from the observed layers (workspace + global).
 * The section is ALWAYS present (even with no memories) so the save guidance
 * is stable model-visible context; an unscanned or empty layer renders a
 * placeholder entrypoint body.
 * @param globalDir - the global memory directory.
 * @param workspaceDir - this workspace's private memory directory.
 * @param globalState - the scanned global state, if available.
 * @param workspaceState - the scanned workspace state, if available.
 * @returns the rendered section.
 */
export function renderMemorySection(
  globalDir: string,
  workspaceDir: string,
  globalState?: MemoryDirectoryState,
  workspaceState?: MemoryDirectoryState,
): string {
  return renderLayers([
    { scope: 'workspace', label: 'this workspace', dir: workspaceDir, state: workspaceState },
    { scope: 'global', label: 'global', dir: globalDir, state: globalState },
  ])
}

/**
 * Render the combined section with the workspace's team layer added.
 * @param globalDir - the global memory directory.
 * @param workspaceDir - this workspace's private memory directory.
 * @param teamDir - this workspace's shared team directory.
 * @param globalState - the scanned global state, if available.
 * @param workspaceState - the scanned workspace state, if available.
 * @param teamState - the scanned team state, if available.
 * @returns the rendered section.
 */
export function renderTeamMemorySection(
  globalDir: string,
  workspaceDir: string,
  teamDir: string,
  globalState?: MemoryDirectoryState,
  workspaceState?: MemoryDirectoryState,
  teamState?: MemoryDirectoryState,
): string {
  return renderLayers([
    { scope: 'workspace', label: 'this workspace', dir: workspaceDir, state: workspaceState },
    { scope: 'team', label: 'team', dir: teamDir, state: teamState },
    { scope: 'global', label: 'global', dir: globalDir, state: globalState },
  ])
}

/** Render one layer's entrypoint block (heading + truncated body). */
function renderLayerFragment(layer: MemoryLayer): string {
  const entry = layer.state?.entrypoint?.trim()
  const body = entry !== undefined && entry.length > 0
    ? truncateEntrypointContent(entry).content
    : '(no memories yet)'
  return `## ${ENTRYPOINT_NAME} (${layer.label})\n\n${body}`
}

/** Compose the full section text from the observed layers. */
export function renderLayers(layers: readonly MemoryLayer[]): string {
  const workspace = layers.find(layer => layer.scope === 'workspace')
  const global = layers.find(layer => layer.scope === 'global')
  const team = layers.find(layer => layer.scope === 'team')
  const globalDir = global?.dir ?? ''
  const lines = [
    '# Memory',
    '',
    'You have a persistent, file-based memory system. Use it to recall context across conversations and to save durable facts.',
    '',
    'There are two scope levels:',
    `- workspace: memories private to the current workspace${workspace !== undefined ? `, stored at \`${workspace.dir}\`` : ''}.`,
    `- global: memories shared by every workspace${global !== undefined ? `, stored at \`${global.dir}\`` : ''}.`,
  ]
  if (team !== undefined) {
    lines.push(`- team: memories shared with and contributed by all users of this project, stored at \`${team.dir}\`.`)
  }
  lines.push(
    '',
    'Each directory keeps its own index and topic files. Save each memory to the directory matching its scope; never write memory content directly into a MEMORY.md.',
    '',
    ...saveGuidance(workspace?.dir, globalDir),
    '',
  )
  const ordered = [workspace, team, global].filter((layer): layer is MemoryLayer => layer !== undefined)
  lines.push(ordered.map(layer => renderLayerFragment(layer)).join('\n\n'))
  const index = renderCombinedIndex(ordered)
  if (index.length > 0) lines.push('', ...index)
  const search = renderSearch(ordered)
  if (search.length > 0) lines.push('', ...search)
  return lines.join('\n')
}

/** A combined topic index with each layer's scope tagged, sorted by filename. */
function renderCombinedIndex(layers: readonly MemoryLayer[]): string[] {
  const combined = layers.flatMap(layer =>
    (layer.state?.topics ?? []).map(topic => ({ ...topic, scope: layer.scope })),
  )
  if (combined.length === 0) return []
  combined.sort((a, b) => a.filename.localeCompare(b.filename))
  const lines = combined.map((topic) => {
    const type = topic.frontmatter.type === undefined ? '' : ` [${topic.frontmatter.type}]`
    return `- [${escapeLinkText(topic.frontmatter.name)}](${topic.filename}) — ${topic.frontmatter.description} (${topic.scope})${type}`
  })
  return ['## Memory index', '', ...lines]
}

function renderSearch(layers: readonly MemoryLayer[]): string[] {
  const populated = layers.filter(layer => (layer.state?.topics.length ?? 0) > 0)
  if (populated.length === 0) return []
  const dirs = populated.map(layer => `${layer.dir}/`).join(' ')
  return [
    '## Searching past context',
    'When a MEMORY.md entry is not enough, search topic files and the transcript log with narrow terms (error messages, file paths, function names):',
    '```',
    `grep -rn "<search term>" ${dirs} --include="*.md"`,
    '```',
  ]
}

function escapeLinkText(name: string): string {
  return name.replace(/[\\[\]]/g, '\\$&')
}

/**
 * Whether an assembling agent is top-level (not a delegated subagent).
 * Fail closed: any throw from reading depth treats the agent as a child so
 * the section never dumps MEMORY.md into a mis-stamped child.
 */
function isTopLevel(agent: Agent): boolean {
  try {
    return delegationDepthOf(agent) === 0
  } catch {
    return false
  }
}
