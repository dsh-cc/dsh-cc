import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vitest/config'

/**
 * Per-package runner so `pnpm --filter @dsh-cc/moa test` works standalone
 * (advisor-watchdog precedent). Workspace deps resolve to their src/ entry.
 */
const WORKSPACE: Record<string, string> = {
  '@dsh-cc/model-aliases': '../../compat/cc-model-aliases/src/index.ts',
  '@dsh-cc/settings-ns': '../../settings/settings-ns/src/index.ts',
  '@dsh-cc/settings-provider': '../../settings/settings-provider/src/index.ts',
  '@dsh-cc/systemone': '../../llm-tuning/systemone/src/index.ts',
  '@dsh-cc/sidecar-io': '../../observability/sidecar-io/src/index.ts',
}

function workspaceAlias(): Plugin {
  return {
    name: 'moa-workspace-alias',
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
