/**
 * Shared plumbing of the active recall coordinator (design
 * docs/plans/2026-11-02-systemone-03-memory-recall.md §"Candidate identity and
 * input contract", §"Privacy, caching and logging").
 *
 * The coordinator proper (`recall-coordinator.ts`) owns the dispatch-key
 * lifecycle; the shadow comparison (`recall-shadow.ts`) reuses the same scanned
 * pool. Both need the optional decision service's face and the same
 * metadata-only view of a scanned pool, so they live here instead of being
 * duplicated (or imported across each other).
 *
 * @module @dsh-cc/memory/recall-coordinator-support
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { DecisionScope } from '@dsh-cc/systemone'
import { scanMemoryDirectory } from './scan.ts'
import type { MemoryIndexEntry } from './types.ts'
import type { RecallDecisionRunner } from './recall-decision-runner.ts'
import type { RecallScope, RecallTopicSeed } from './recall-decision.ts'
import { parseIndexedBasenames } from './recall-preselect.ts'

/**
 * The optional SystemOne decision face the coordinator consumes. A
 * `BoundDecisionRunner` from `ctx.systemoneDecisions.forAgent(agent)` satisfies
 * it structurally; the memory plugin never imports the hosting service, never
 * resolves a provider and never assembles a scope itself.
 */
export type RecallDecisionBinding = RecallDecisionRunner & {
  /** The host-supplied metering scope for one origin seq. */
  scope(originSeq?: number): DecisionScope
}

/** The optional `ctx.systemoneDecisions` service face (structural; absent degrades). */
export interface SystemOneDecisionsLike {
  forAgent(agent: Agent): RecallDecisionBinding
}

/** The live session id of one agent, '' when unreadable. */
export function sessionIdOf(agent: Agent): string {
  try {
    const id = agent.session.id as unknown
    return typeof id === 'string' ? id : String(id ?? '')
  } catch {
    return ''
  }
}

/** Sorted copy of tool names (UTF-8 byte order, never locale order). */
export function sortedTools(tools: readonly string[]): string[] {
  return [...tools].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')))
}

/** Read one memory file, mapping an absent file to `undefined` (any other fault throws). */
export async function readOptionalText(
  fileSystem: FileSystem,
  path: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const target = await fileSystem.resolve(path, { signal })
    return await fileSystem.readText(target, signal)
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error
      && ((error as { code?: string }).code === 'FS_NOT_FOUND'
        || (error as { code?: string }).code === 'ENOENT')) return undefined
    throw error
  }
}

/** Map one scanned entry onto an id-less candidate seed of its layer. */
function topicSeed(entry: MemoryIndexEntry, scope: RecallScope): RecallTopicSeed {
  return {
    scope,
    path: entry.path,
    filename: entry.filename,
    name: entry.frontmatter.name,
    description: entry.frontmatter.description,
    contentHash: entry.contentHash ?? '',
  }
}

/** Both scanned layers plus each layer's memory-index membership. */
export interface RecallLayerScan {
  /** The complete ID-less candidate pool (workspace first, then global). */
  seeds: RecallTopicSeed[]
  /** Per-layer MEMORY.md basenames for the pre-selection tie-break. */
  indexed: Readonly<{ workspace: ReadonlySet<string>; global: ReadonlySet<string> }>
}

/**
 * Scan both layers of one agent (`workspace` then `global`) into the complete
 * id-less candidate pool. Content hashes are computed from the bytes the scan
 * already read, so this costs no extra file reads.
 * @param fileSystem - the host filesystem seam.
 * @param memoryDir - the agent's canonical workspace memory directory.
 * @param home - the memory home (the global layer root).
 * @param signal - cancellation for the underlying fs reads.
 * @returns the complete pool, workspace entries first.
 */
export async function scanRecallLayers(
  fileSystem: FileSystem,
  memoryDir: string,
  home: string,
  signal: AbortSignal,
): Promise<RecallLayerScan> {
  const [workspaceScan, globalScan] = await Promise.all([
    scanMemoryDirectory(fileSystem, memoryDir, signal, { withContentHash: true }),
    scanMemoryDirectory(fileSystem, home, signal, { withContentHash: true }),
  ])
  return {
    seeds: [
      ...workspaceScan.topics.map(entry => topicSeed(entry, 'workspace')),
      ...globalScan.topics.map(entry => topicSeed(entry, 'global')),
    ],
    indexed: {
      workspace: parseIndexedBasenames(workspaceScan.entrypoint ?? ''),
      global: parseIndexedBasenames(globalScan.entrypoint ?? ''),
    },
  }
}
