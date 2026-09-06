/**
 * Dynamic recall: an `agent/pre-step` listener that asks a small-model side
 * query (a forked subagent) which topic files are relevant to the turn, then
 * injects their bodies through `agent.inject()`. Topic files already shown
 * this session are never re-injected. Recall runs for top-level agents only —
 * a forked child (including the selector itself) never recalls, so no chain of
 * memory-recall subagents can form. Best-effort: absence of the subagent
 * service or provider skips recall without error.
 * @module @dsh-cc/memory/recall
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { scanMemoryDirectory } from './scan.ts'
import { cwdOf, resolveWorkspaceMemoryDir } from './paths.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    memory: { kind: 'memory' }
  }
}

// The canonical `tools/post-execute` waterfall signature comes from
// @dsh-cc/tools (a real dependency since save.ts); memory only observes
// tool usage for recall suppression and delegates to `next()` unchanged.

/** How many topic files the selector may surface per query. */
export const MAX_RECALL_MEMORIES = 5

/** One topic file offered to the selector. */
export interface RecallCandidate {
  path: string
  filename: string
  description: string
}

/** The async relevance selector contract, injectable for tests. */
export interface MemorySelector {
  /**
   * Pick at most {@link MAX_RECALL_MEMORIES} filenames relevant to a query.
   * @param query - the user turn text.
   * @param candidates - topic files (filename + description) not yet shown.
   * @param signal - cancellation for the underlying model request.
   * @param recentTools - tool names used earlier this session; the selector
   *   should not surface usage-reference/API-doc memories for these tools.
   * @returns selected filenames.
   */
  select(
    query: string,
    candidates: readonly RecallCandidate[],
    signal: AbortSignal,
    recentTools: readonly string[],
  ): Promise<string[]>
}

/**
 * Default selector backed by `ctx.subagents`: asks a forked small-model
 * one-shot subagent to return the filenames most useful for the query. The
 * parent agent is supplied per query so the child seeds from the right turn.
 */
export class SubagentMemorySelector implements MemorySelector {
  /**
   * Create a subagent-backed selector for one parent agent.
   * @param ctx - host context with the optional `subagents` service.
   * @param parent - the agent whose turn triggers recall.
   * @param providerName - the one-shot provider to fork (default `fork`).
   * @param agentOptions - optional model selection passed to the child.
   */
  constructor(
    private readonly ctx: Context,
    private readonly parent: Agent,
    private readonly providerName = 'fork',
    private readonly agentOptions?: unknown,
  ) {}

  async select(query: string, candidates: readonly RecallCandidate[], signal: AbortSignal, recentTools: readonly string[]): Promise<string[]> {
    const subagents = this.ctx.get('subagents') as SubagentLike | undefined
    if (subagents === undefined) return []
    const manifest = candidates
      .map(candidate => `- ${candidate.filename}: ${candidate.description}`)
      .join('\n')
    const system = [
      'You select memories useful for processing a user query.',
      `Return a JSON object with a "selected_memories" array of filenames (at most ${MAX_RECALL_MEMORIES}).`,
      'Only include memories you are certain are helpful. If none are clearly useful, return an empty array.',
      'If a list of recently-used tools is provided, do not select memories that are usage reference or API documentation for those tools (the agent is already exercising them). DO still select memories containing warnings, gotchas, or known issues about those tools — active use is exactly when those matter.',
    ].join('\n')
    // When a tool is actively in use, its reference-doc memory is noise — the
    // conversation already contains working usage and keyword overlap would
    // otherwise false-positive the selector. Surface the list so it can suppress.
    const toolsSection = recentTools.length > 0
      ? `\n\nRecently used tools: ${recentTools.join(', ')}`
      : ''
    let run
    try {
      run = await subagents.start(this.providerName, {
        label: 'memory-recall',
        signal,
        prompt: [{ type: 'text', text: `${system}\n\nQuery: ${query}\n\nAvailable memories:\n${manifest}${toolsSection}` }],
        parent: this.parent,
        ...(this.agentOptions !== undefined ? { agentOptions: this.agentOptions } : {}),
      })
    } catch {
      // Provider absent or services unavailable: best-effort recall skips.
      return []
    }
    // run.result rejects only on infrastructure faults; child-level failures
    // arrive RESOLVED with a non-completed stopReason. Both must skip recall
    // quietly — this path is fire-and-forget, so a throw becomes an unhandled
    // rejection in the host.
    let result
    try {
      result = await run.result
    } catch {
      return []
    }
    if (result.stopReason === 'error') return []
    // SubagentResult carries the transcript blocks as `output` (not `content`).
    const text = (result.output ?? [])
      .filter(block => block.type === 'text')
      .map(block => block.text ?? '')
      .join('')
    const names = extractSelectedNames(text)
    const valid = new Set(candidates.map(candidate => candidate.filename))
    return names.filter(name => valid.has(name)).slice(0, MAX_RECALL_MEMORIES)
  }
}

/** Structural subset of the subagent seam used by the selector. */
interface SubagentLike {
  start(name: string, request: {
    label?: string
    prompt: readonly { type: 'text'; text: string }[]
    parent: Agent
    signal: AbortSignal
    agentOptions?: unknown
  }): Promise<{
    result: Promise<{ stopReason: string; output?: readonly { type: string; text?: string }[] }>
  }>
}

/** Loose JSON extraction tolerant of code fences and prose around the array. */
export function extractSelectedNames(text: string): string[] {
  const match = /"selected_memories"\s*:\s*(\[[^\]]*\])/.exec(text)
  const encoded = match?.[1]
  if (encoded === undefined) return []
  try {
    const parsed = JSON.parse(encoded) as unknown
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : []
  } catch {
    return []
  }
}

/** The per-agent recall coordinator. Holds the shown-path set per agent. */
export class MemoryRecall {
  private readonly state = new WeakMap<Agent, { shown: Set<string>; inFlight: boolean }>()
  private readonly providerName: string
  private readonly createSelector: (ctx: Context, agent: Agent) => MemorySelector
  private readonly recentTools = new Set<string>()
  private readonly disposers: Array<() => void> = []

  /**
   * Register the `agent/pre-step` and `tools/post-execute` listeners.
   * @param ctx - host context with `fs`, `subagents`, and the agent channel.
   * @param home - the memory home: the global directory and the root under
   *   which each agent's workspace directory (`projects/<slug>`) is resolved.
   * @param options - provider name, whether recall is enabled, and an optional
   *   selector factory (defaults to {@link SubagentMemorySelector}; inject a
   *   fake for deterministic tests).
   */
  constructor(
    private readonly ctx: Context,
    private readonly home: string,
    options: {
      providerName?: string
      enabled?: boolean
      createSelector?: (ctx: Context, agent: Agent) => MemorySelector
    } = {},
  ) {
    this.providerName = options.providerName ?? 'fork'
    this.createSelector = options.createSelector
      ?? ((ctx, agent) => new SubagentMemorySelector(ctx, agent, this.providerName))
    if (options.enabled ?? true) {
      this.disposers.push(
        this.ctx.on('agent/pre-step', (payload, next) => this.onPreStep(payload, next)),
      )
    }
    // Track tools used this session so recall can suppress reference-doc
    // memories for the tools the agent is already exercising. This is a
    // waterfall observer: it must delegate to `next()` so the tools pipeline
    // continues unchanged.
    this.disposers.push(
      this.ctx.on('tools/post-execute', (exec, _result, next) => {
        if (exec.name.length > 0) this.recentTools.add(exec.name)
        return next()
      }),
    )
  }

  /** Remove both the pre-step and post-execute listeners. */
  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose()
    this.recentTools.clear()
  }

  private async onPreStep(
    {
      agent,
      messages,
      signal,
    }: {
      agent: Agent
      messages: ReadonlyArray<{ content: readonly { type: string; text?: string }[] }>
      signal: AbortSignal
    },
    next: () => Promise<PreStepDecision>,
  ): Promise<PreStepDecision> {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    signal.throwIfAborted()
    // Recall enriches top-level agents only. Every agent runs this same
    // waterfall — including the forked memory-recall selector itself — so
    // recalling inside a subagent would spawn another selector whose own
    // pre-step recalls again: an unbounded chain of memory-recall subagents.
    const header = agent.session.header
    if (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0) return decision
    // Fire-and-forget: recall is model-visible enrichment, never worth an
    // unhandled rejection in the host — any fault inside skips quietly.
    void this.maybeRecall(agent, messages, signal, this.createSelector(this.ctx, agent))
      .catch(() => {})
    return decision
  }

  private async maybeRecall(
    agent: Agent,
    messages: ReadonlyArray<{ content: readonly { type: string; text?: string }[] }>,
    signal: AbortSignal,
    selector: MemorySelector,
  ): Promise<void> {
    const fileSystem = this.ctx.get('fs')
    if (fileSystem === undefined) return
    const query = messages
      .map(message => message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join(' '))
      .join('\n')
      .trim()
    if (query.length === 0) return
    // Recall spans both layers: the agent's workspace directory and the
    // global directory. Shown-tracking keys on full paths, so identical
    // filenames across layers never collide.
    const workspaceDir = resolveWorkspaceMemoryDir(this.home, cwdOf(agent))
    const [workspaceScan, globalScan] = await Promise.all([
      scanMemoryDirectory(fileSystem, workspaceDir, signal),
      scanMemoryDirectory(fileSystem, this.home, signal),
    ])
    const topics = [...workspaceScan.topics, ...globalScan.topics]
    if (topics.length === 0) return
    let entry = this.state.get(agent)
    if (entry === undefined) {
      entry = { shown: new Set(), inFlight: false }
      this.state.set(agent, entry)
    }
    const fresh = topics.filter(topic => !entry.shown.has(topic.path))
    if (fresh.length === 0) return
    // Pre-step fires once per step while a turn runs; a pending selection must
    // not pile up overlapping selectors for the same agent.
    if (entry.inFlight) return
    entry.inFlight = true
    try {
      const selected = await selector.select(
        query,
        fresh.map(topic => ({ path: topic.path, filename: topic.filename, description: topic.frontmatter.description })),
        signal,
        Array.from(this.recentTools),
      )
      if (signal.aborted || selected.length === 0) return
      const byFilename = new Map(topics.map(topic => [topic.filename, topic]))
      const bodies: string[] = []
      for (const filename of selected) {
        const topic = byFilename.get(filename)
        if (topic === undefined) continue
        entry.shown.add(topic.path)
        const raw = await readOptionalText(fileSystem, topic.path, signal)
        if (raw !== undefined && raw.trim().length > 0) {
          bodies.push(`## Memory: ${topic.frontmatter.name}\n\n${raw.trim()}`)
        }
      }
      signal.throwIfAborted()
      if (bodies.length === 0) return
      agent.inject(createUserMessage({
        content: [{ type: 'text', text: bodies.join('\n\n') }],
        source: { kind: 'memory' },
      }))
    } finally {
      entry.inFlight = false
    }
  }
}

async function readOptionalText(fs: FileSystem, path: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const target = signal !== undefined
      ? await fs.resolve(path, { signal })
      : await fs.resolve(path)
    return await fs.readText(target, signal)
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error
      && ((error as { code?: string }).code === 'FS_NOT_FOUND'
        || (error as { code?: string }).code === 'ENOENT')) return undefined
    throw error
  }
}
