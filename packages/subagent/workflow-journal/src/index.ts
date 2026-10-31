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

export { CcWorkflowJournalProvider, admitJournalReplay, recordJournalOutcome } from './provider.ts'
export type { CcWorkflowJournalProviderOptions, JournalRun, SubagentServiceLike, WorkflowJournalRegistry } from './provider.ts'
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
  // Two standing preset mounts (agent.cordis.yml / agent.vwa.cordis.yml in packages/preset/cc/) run
  // this apply() in one runtime and share the host-plane provider map; register-if-absent is
  // load-bearing — the harness throws DUPLICATE_PROVIDER on a second registration of the same name.
  // The getProvider check and registerProvider run back-to-back with no await so the guard stays atomic.
  let unregister: (() => void) | undefined
  const prior = ctx.subagents.getProvider(provider.name)
  if (prior === undefined) {
    unregister = ctx.subagents.registerProvider(provider)
  } else if (prior instanceof CcWorkflowJournalProvider) {
    ctx.logger.info('cc-workflow-journal: provider already registered by a sibling preset mount; reusing it')
  } else {
    ctx.logger.warn('cc-workflow-journal: provider name taken by a foreign provider; deferring')
  }
  try {
    const { removed } = sweepExpiredSessionDirs(join(resolveDshHome(), 'workflows', 'runs'), resolved.sweepTtlMs ?? 86_400_000)
    if (removed.length > 0) ctx.logger.info(`cc-workflow-journal: swept ${removed.length} expired session journal director${removed.length === 1 ? 'y' : 'ies'}`)
  } catch (error) {
    ctx.logger.warn(`cc-workflow-journal: boot sweep failed: ${String(error)}`)
  }
  return () => {
    unregister?.()
    return provider.disposeAllJournals().catch(error => {
      ctx.logger.warn(`cc-workflow-journal: journal disposal failed: ${String(error)}`)
    })
  }
}
