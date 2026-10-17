import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vitest/config'

/**
 * Per-package runner so `pnpm --filter @dsh-cc/vwa-eval test` works
 * standalone (same completion-gate pattern as vwa-evidence/vitest.config.ts;
 * the repo-root include pattern does not cover the three-level evaluation/
 * package layout). Workspace deps resolve to their src/
 * entry — vite's tsconfigPaths plugin mis-parses the extends chain from
 * this directory.
 */
const WORKSPACE: Record<string, string> = {
  '@dsh-cc/vwa-evidence': '../../interaction/vwa-evidence/src/index.ts',
}

function workspaceAlias(): Plugin {
  return {
    name: 'vwa-eval-workspace-alias',
    enforce: 'pre',
    resolveId(source) {
      const mapped = WORKSPACE[source]
      if (mapped === undefined) return null
      const target = resolve(import.meta.dirname, mapped)
      return existsSync(target) ? target : null
    },
  }
}

export default defineConfig({
  plugins: [workspaceAlias()],
  test: {
    include: ['tests/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/lib/**'],
  },
})
