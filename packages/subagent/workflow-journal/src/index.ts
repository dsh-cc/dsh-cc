/**
 * The cordis plugin: mounts the `cc-workflow-journal` provider over the
 * core slice's `ccWorkflowRunRegistry` service and runs the boot TTL sweep
 * over `<dshHome>/workflows/runs`.
 * @module @dsh-cc/workflow-journal
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { sweepExpiredSessionDirs } from './journal-io.ts'
import { CcWorkflowJournalProvider } from './provider.ts'

export const name = 'subagent-workflow-journal'
export const inject = ['subagents', 'ccWorkflowRunRegistry']

export { CcWorkflowJournalProvider } from './provider.ts'
export type { CcWorkflowJournalProviderOptions, SubagentServiceLike, WorkflowJournalRegistry } from './provider.ts'
export { canonicalJson, fnv1a32hex, hashSubagentRequest, JournalWriter, sweepExpiredSessionDirs } from './journal-io.ts'

/** Plugin config. */
export interface Config {
  /** Journal file byte cap; a longer journal stops recording further lines (default 8 MiB). */
  maxJournalBytes?: number
  /** Boot sweep TTL for session journal directories (default 24h). */
  sweepTtlMs?: number
}

export const Config: z<Config> = z.object({
  maxJournalBytes: z.natural().default(8_388_608),
  sweepTtlMs: z.natural().default(86_400_000),
})

export async function apply(ctx: Context, config: Config): Promise<() => void> {
  const resolved = Config(config)
  const provider = new CcWorkflowJournalProvider(ctx.subagents, ctx.ccWorkflowRunRegistry, {
    maxJournalBytes: resolved.maxJournalBytes ?? 8_388_608,
    warn: message => ctx.logger.warn(message),
  })
  const unregister = ctx.subagents.registerProvider(provider)
  try {
    const { removed } = sweepExpiredSessionDirs(join(resolveDshHome(), 'workflows', 'runs'), resolved.sweepTtlMs ?? 86_400_000)
    if (removed.length > 0) ctx.logger.info(`cc-workflow-journal: swept ${removed.length} expired session journal director${removed.length === 1 ? 'y' : 'ies'}`)
  } catch (error) {
    ctx.logger.warn(`cc-workflow-journal: boot sweep failed: ${String(error)}`)
  }
  return () => {
    unregister()
    return provider.disposeAllJournals().catch(error => {
      ctx.logger.warn(`cc-workflow-journal: journal disposal failed: ${String(error)}`)
    })
  }
}
