/**
 * `storage` checks for `/doctor`: a verbose-only write probe against the
 * session persistence store.
 * @module @dsh-cc/command-doctor/checks/storage
 */

import { unlink, writeFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import type { Check } from '../report.ts'

/** Collect the storage group checks. */
export async function storageChecks(ctx: Context, invocation: CommandInvocation, options: { verbose: boolean }): Promise<Check[]> {
  if (!options.verbose) {
    return [{
      id: 'storage.session',
      group: 'storage',
      status: 'skip',
      summary: 'not probed (use --verbose)',
    }]
  }
  const persistence = ctx.get('sessionPersistence') as
    | { locate?(header: unknown): { path?: string } | undefined }
    | undefined
  const located = persistence?.locate?.(invocation.agent.session.header)
  const path = located?.path
  if (path === undefined) {
    return [{
      id: 'storage.session',
      group: 'storage',
      status: 'skip',
      summary: 'session store path unavailable',
    }]
  }
  const probe = `${path}.${process.pid}.doctor-tmp`
  try {
    await writeFile(probe, 'dsh-cc doctor write probe\n', 'utf8')
    return [{
      id: 'storage.session',
      group: 'storage',
      status: 'ok',
      summary: `store directory writable: ${path}`,
      evidence: { path },
    }]
  } catch (error) {
    return [{
      id: 'storage.session',
      group: 'storage',
      status: 'fail',
      summary: `store directory not writable: ${String(error)}`,
      fix: 'check filesystem permissions for the session store directory',
      evidence: { path },
    }]
  } finally {
    await unlink(probe).catch(() => undefined)
  }
}
