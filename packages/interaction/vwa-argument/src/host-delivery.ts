/** Host-backed mechanical gates and current reviewer identity for each caller. */
import type { Context } from '@deepseek-ai/cordis'
import { runGates, shellExecutorOf } from '@dsh-cc/vwa-evidence'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createReviewFactory } from './review-host.ts'
import { sha256Hex, stableJson } from './schema.ts'
import { ProjectStore } from './store.ts'
import type { VwaArgumentServiceDeps } from './report.ts'
export function hostDeliveryDeps(
  ctx: Context,
  dshHome: string,
  agent: unknown,
  root?: string,
): Omit<VwaArgumentServiceDeps, 'root'> {
  return {
    async gates(path, root) {
      const shell = ctx.get('shell') as Parameters<typeof shellExecutorOf>[0] | undefined
      const exec = shell
        ? shellExecutorOf(shell)
        : async () => {
            throw new Error('exec runner unavailable')
          }
      const rows = await runGates([path], root, exec)
      const text = readFileSync(join(root, path), 'utf8')
      const count = [...text.matchAll(/^\s*(`{3,}|~{3,})[^\n]*\n/gm)].length / 2
      return rows.map((g) => ({
        ...g,
        ...(g.gate === 'exec' ? { fenceCount: Math.ceil(count) } : {}),
        ...(g.gate === 'style' ? { rulesetLoaded: false } : {}),
      }))
    },
    async currentReviewerConfigHash(projectId) {
      const review = createReviewFactory(ctx, dshHome)(agent)
      if ('ok' in review) return sha256Hex(stableJson({ unavailable: review.code }))
      const head = root ? new ProjectStore(root, projectId).readHead() : undefined
      const budget = head?.ok ? (head.data.snapshot.contract.reviewSettings?.budget ?? review.budget) : review.budget
      await review.adapter.initialize?.(budget.maxOutputTokensPerCall, new AbortController().signal)
      return sha256Hex(stableJson(review.adapter.configFingerprint()))
    },
  }
}
