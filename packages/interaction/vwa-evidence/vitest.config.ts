import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vitest/config'

/**
 * Per-package runner so `pnpm --filter @dsh-cc/vwa-evidence test` works
 * standalone. Workspace deps resolve to their src/ entry (the same mapping
 * tsconfig.base.json paths provides at the repo root; vite's tsconfigPaths
 * plugin mis-parses the extends chain from this directory) — completion-gate
 * vitest.config.ts pattern. The self-package alias keeps the inject pin
 * (`import('../src/index.ts')`) honest.
 */
const WORKSPACE: Record<string, string> = {
  '@dsh-cc/settings-ns': '../../settings/settings-ns/src/index.ts',
  '@dsh-cc/settings-provider': '../../settings/settings-provider/src/index.ts',
  '@dsh-cc/session-cwd': '../../workspace/session-cwd/src/index.ts',
  '@dsh-cc/tools': '../../core/tools/src/index.ts',
  '@dsh-cc/agent-loop-mock': '../agent-loop-mock/src/index.ts',
}

function workspaceAlias(): Plugin {
  return {
    name: 'vwa-evidence-workspace-alias',
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
