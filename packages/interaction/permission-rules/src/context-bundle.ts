/**
 * The S3/D7 context-bundle assembly for the auto-mode classifier stage:
 * transcript fold (user intent + tool history), per-cwd project instructions
 * (AGENTS.md else CLAUDE.md, read once per build), and the work-discarding
 * git-status enrichment. Extracted from auto-stage.ts for the file-size
 * budget — behavior identical to the inline block.
 * @module @dsh-cc/permission-rules/context-bundle
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolExecution } from '@dsh-cc/tools'
import type { ClassifierContext } from './llm-classifier.ts'
import { enrichContext } from './enrichment.ts'
import { foldClassifierContext } from './transcript.ts'

/** Structural deps the bundler needs from the auto stage. */
export type ContextBundlerDeps = {
  /** Read-only tool names — the tool-history fold filter (same set the waterfall uses). */
  readOnlyTools: ReadonlySet<string>
  /** Optional shell runner for enrichment (absent ⇒ enrichment skipped, fail-open). */
  runCommand?: (cmd: string, opts: { cwd?: string; timeoutMs: number }) => Promise<string>
}

export type ContextBundler = {
  /** Assemble the classifier context for one call (empty sections omitted). */
  build(exec: ToolExecution): Promise<ClassifierContext>
  /** Clear per-cwd caches (settings reload / stage rebuild). */
  reset(): void
}

/** Create the bundler; project instructions are cached per cwd until reset(). */
export function createContextBundler(deps: ContextBundlerDeps): ContextBundler {
  /** Project instructions per cwd, read once per build; reset() clears. */
  const instructionsByCwd = new Map<string, string>()

  /**
   * Read `<cwd>/AGENTS.md` else `<cwd>/CLAUDE.md` (≤1024 chars), once per
   * build. Absent/unreadable ⇒ '' (the section is omitted).
   */
  const readProjectInstructions = (cwd: string): string => {
    const cached = instructionsByCwd.get(cwd)
    if (cached !== undefined) return cached
    let body = ''
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      try {
        body = readFileSync(join(cwd, name), 'utf8').slice(0, 1024)
        break
      } catch {
        // absent or unreadable ⇒ try the next candidate
      }
    }
    instructionsByCwd.set(cwd, body)
    return body
  }

  return {
    async build(exec) {
      const session = exec.agent?.session
      const fold = session === undefined
        ? { userIntent: '', toolHistory: '' }
        : foldClassifierContext(session.snapshotEvents(), { readOnlyTools: deps.readOnlyTools })
      const cwd = session?.header?.cwd ?? ''
      const command = (exec.arguments as Record<string, unknown>).command
      const runCommand = deps.runCommand
      const siteContext = typeof command === 'string' && runCommand !== undefined
        ? await enrichContext(command, (cmd, opts) => runCommand(cmd, { ...opts, ...(cwd === '' ? {} : { cwd }) }))
        : ''
      return {
        ...(fold.userIntent.length === 0 ? {} : { userIntent: fold.userIntent }),
        ...(fold.toolHistory.length === 0 ? {} : { toolHistory: fold.toolHistory }),
        ...(cwd === '' ? {} : { projectInstructions: readProjectInstructions(cwd) }),
        ...(siteContext.length === 0 ? {} : { siteContext }),
      }
    },
    reset() {
      instructionsByCwd.clear()
    },
  }
}
