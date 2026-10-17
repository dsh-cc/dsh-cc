/** User command dependencies: frozen settings and receipts from the caller's own session ledger. */
import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { receiptLedgerPath, receiptHashOf, type ReceiptV2 } from '@dsh-cc/vwa-evidence'
import { freezeReviewSettings } from './review-config.ts'
import { readUserSettingsSync } from './settings.ts'
import { VwaArgumentService } from './report.ts'
import { hostDeliveryDeps } from './host-delivery.ts'
import type { VwaCommandDeps } from './commands.ts'
export function commandDeps(ctx: Context, workspaceRoot: VwaCommandDeps['workspaceRoot']): VwaCommandDeps {
  const home = () => (ctx as unknown as { dshHomePath?: () => string | undefined }).dshHomePath?.()
  const settings = () => readUserSettingsSync(home() ?? '')
  return {
    workspaceRoot,
    reviewSettings: () => freezeReviewSettings(settings()),
    defaultMode: () => settings()['semantic-mode'],
    delivery: (root, agent) => new VwaArgumentService({ root, ...hostDeliveryDeps(ctx, home() ?? '', agent, root) }),
    readReceipt(agent, hash) {
      const session = (agent as { session?: { id?: string; header?: { id?: string } } })?.session
      const id = session?.header?.id ?? session?.id,
        dshHome = home()
      if (!id || !dshHome) return undefined
      try {
        const rows = readFileSync(receiptLedgerPath(dshHome, id), 'utf8')
          .split('\n')
          .flatMap((line) => {
            try {
              return [JSON.parse(line) as ReceiptV2]
            } catch {
              return []
            }
          })
        return rows.findLast((row) => row.v === 2 && receiptHashOf(row) === hash)
      } catch {
        return undefined
      }
    },
  }
}

/** The default contract candidate for `/vwa init` (displayed, never auto-searched). */
export function defaultContract(question: string): import('./types.ts').ProjectContract {
  return {
    question,
    language: 'en',
    domain: 'research',
    requiredQuestions: [],
    plannedCorpus: [],
    expectedCoreTopics: [],
    mode: 'draft',
  }
}
