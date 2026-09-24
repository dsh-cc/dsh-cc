import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vitest/config'

/**
 * Per-package runner so `pnpm --filter @dsh-cc/advisor-watchdog test` works
 * standalone. Workspace deps resolve to their src/ entry (the same mapping
 * tsconfig.base.json paths provides at the repo root; vite's tsconfigPaths
 * plugin mis-parses the extends chain from this directory).
 */
const WORKSPACE: Record<string, string> = {
  '@dsh-cc/side-query': '../../llm-tuning/side-query/src/index.ts',
  '@dsh-cc/permission-rules': '../permission-rules/src/index.ts',
  '@dsh-cc/model-aliases': '../../compat/cc-model-aliases/src/index.ts',
  '@dsh-cc/settings-ns': '../../settings/settings-ns/src/index.ts',
  '@dsh-cc/tools': '../../core/tools/src/index.ts',
  '@dsh-cc/session-cwd': '../../workspace/session-cwd/src/index.ts',
  '@dsh-cc/settings-cascade': '../../settings/settings-cascade/src/index.ts',
}

function workspaceAlias(): Plugin {
  return {
    name: 'advisor-watchdog-workspace-alias',
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
