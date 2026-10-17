/** VWA argument foundations. User entry points are added by the delivery integration PR. */
import type { Context } from '@deepseek-ai/cordis'
import { registerSettings } from './settings.ts'
export * from './types.ts'
export * from './schema.ts'
export * from './settings.ts'
export * from './review-config.ts'
export * from './review-budget.ts'
export * from './store.ts'
export * from './lock.ts'
export * from './sources.ts'
export * from './dependencies.ts'
export * from './graph.ts'
export * from './artifact.ts'
export { rootBlocks } from './markdown-blocks.ts'
export const name = 'vwa-argument'
export const inject: string[] = []
/** Foundation-only mount; no author/review tools, command or delivery service. */
export function apply(ctx: Context): void {
  registerSettings(ctx)
}
export * from './policy.ts'
export * from './review-adapter.ts'
export * from './review-plan.ts'
export * from './review-run-store.ts'
export * from './review-runner.ts'
export * from './audit.ts'
