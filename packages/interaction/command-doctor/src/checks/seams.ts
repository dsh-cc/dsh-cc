/**
 * `seams` compatibility checks for `/doctor`: today's seven seam names,
 * presence-only (absence is expected, so not-mounted is `skip`, not `fail`).
 * @module @dsh-cc/command-doctor/checks/seams
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Check } from '../report.ts'

/** The compatibility seam names kept from the pre-report `/doctor`. */
export const SEAM_NAMES: readonly string[] = [
  'shell', 'subprocess', 'fs', 'skills', 'web', 'lsp', 'llm',
]

/** Collect the seams group checks. */
export function seamChecks(ctx: Context): Check[] {
  return SEAM_NAMES.map(name => seamCheck(ctx, name))
}

/** One seam row; `llm` lists provider ids in detail when enumerable. */
function seamCheck(ctx: Context, name: string): Check {
  const mounted = ctx.get(name) !== undefined
  if (!mounted) {
    return {
      id: `seams.${name}`,
      group: 'seams',
      status: 'skip',
      summary: `${name} not mounted`,
    }
  }
  if (name === 'llm') {
    const providers = (ctx.get('llm') as { listProviders?(): { id: string }[] } | undefined)
      ?.listProviders?.() ?? []
    return {
      id: 'seams.llm',
      group: 'seams',
      status: 'ok',
      summary: 'llm mounted',
      detail: providers.length === 0 ? undefined : providers.map(provider => provider.id).join(', '),
      evidence: { providers: providers.length },
    }
  }
  return {
    id: `seams.${name}`,
    group: 'seams',
    status: 'ok',
    summary: `${name} mounted`,
  }
}
