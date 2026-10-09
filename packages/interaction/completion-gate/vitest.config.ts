import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vitest/config'

/**
 * Per-package runner so `pnpm --filter @dsh-cc/completion-gate test` works
 * standalone. Workspace deps resolve to their src/ entry (the same mapping
 * tsconfig.base.json paths provides at the repo root; vite's tsconfigPaths
 * plugin mis-parses the extends chain from this directory).
 */
const WORKSPACE: Record<string, string> = {
  '@dsh-cc/settings-ns': '../../settings/settings-ns/src/index.ts',
  '@dsh-cc/settings-provider': '../../settings/settings-provider/src/index.ts',
  '@dsh-cc/tools': '../../core/tools/src/index.ts',
}

function workspaceAlias(): Plugin {
  return {
    name: 'completion-gate-workspace-alias',
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
