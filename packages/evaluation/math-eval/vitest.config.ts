import { defineConfig } from 'vitest/config'

/**
 * Per-package runner so `pnpm --filter @dsh-cc/math-eval test` works
 * standalone (same completion-gate pattern as vwa-eval/vitest.config.ts; the
 * repo-root include pattern does cover the evaluation-package layout, but a
 * bare `vitest run` from this directory would otherwise see no specs). The
 * package has no workspace dependencies yet — the wave that lands kernel-check
 * integration adds the alias map here.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/lib/**'],
  },
})
