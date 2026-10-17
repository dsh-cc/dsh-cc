import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vitest/config'

/**
 * Per-package runner so `pnpm --filter @dsh-cc/vwa-argument test` works
 * standalone. Same pattern as vwa-evidence's vitest.config.ts: workspace
 * deps resolve to their src/ entry (vite-tsconfig-paths mis-parses the
 * extends chain from this directory).
 */
const WORKSPACE: Record<string, string> = {
  '@dsh-cc/settings-ns': '../../settings/settings-ns/src/index.ts',
  '@dsh-cc/sidecar-io': '../../observability/sidecar-io/src/index.ts',
  '@dsh-cc/settings-provider': '../../settings/settings-provider/src/index.ts',
  '@dsh-cc/session-cwd': '../../workspace/session-cwd/src/index.ts',
  '@dsh-cc/vwa-evidence': '../vwa-evidence/src/index.ts',
}

function workspaceAlias(): Plugin {
  return {
    name: 'vwa-argument-workspace-alias',
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
