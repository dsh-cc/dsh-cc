import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

/**
 * The background-agent integration specs (packages/subagent/task/tests,
 * packages/bundle/cc-shell/tests, packages/hooks/hooks-claude-code/tests)
 * import a few harness packages (`tool-subagent-control`, `tool-subagent-report`,
 * `subagent-spawn-in-process`, `session-projection`, …) that not every touched
 * package links in its own node_modules. Resolve them against the sibling
 * deepseek-harness checkout — the same directories the `link:` devDependencies
 * point at, so module identity matches the pnpm-linked case exactly. No-op
 * when the sibling checkout is absent.
 */
function harnessRoot(): string | undefined {
  let cur = process.cwd()
  for (let i = 0; i < 8; i++) {
    const cand = join(cur, 'deepseek-harness')
    if (existsSync(join(cand, 'packages', 'subagent', 'subagent', 'lib', 'index.js'))) return cand
    const next = dirname(cur)
    if (next === cur) return undefined
    cur = next
  }
  return undefined
}

const harness = harnessRoot()
const harnessDir = (...parts: string[]): string | undefined =>
  harness === undefined ? undefined : resolve(harness, ...parts)

/** Exact-match specifier → harness lib entry. Order is irrelevant (exact matches). */
const harnessAliases: Record<string, string | undefined> = {
  '@deepseek-ai/dsh-tool-subagent-control/list-agents': harnessDir('packages/subagent/tool-subagent-control/lib/types/list-agents.js'),
  '@deepseek-ai/dsh-tool-subagent-control': harnessDir('packages/subagent/tool-subagent-control/lib/index.js'),
  '@deepseek-ai/dsh-tool-subagent-report': harnessDir('packages/subagent/tool-subagent-report/lib/index.js'),
  '@deepseek-ai/dsh-subagent-spawn-in-process': harnessDir('packages/subagent/subagent-spawn-in-process/lib/index.js'),
  '@deepseek-ai/dsh-session-persistence-jsonl': harnessDir('packages/session/session-persistence-jsonl/lib/index.js'),
  '@deepseek-ai/dsh-session-projection': harnessDir('packages/session/session-projection/lib/index.js'),
  '@deepseek-ai/dsh-agent-loop-testkit': harnessDir('packages/test-support/agent-loop-testkit/lib/index.js'),
  '@deepseek-ai/dsh-agent-loop': harnessDir('packages/core/agent-loop/lib/index.js'),
  '@deepseek-ai/dsh-llm': harnessDir('packages/llm/llm/lib/index.js'),
  '@deepseek-ai/dsh-session': harnessDir('packages/core/session/lib/index.js'),
  // Not yet in tsconfig.base paths; consumed by tests and workspace links.
  '@dsh-cc/subagent-task': resolve('packages/subagent/task/src/index.ts'),
}

/**
 * Exact-match aliases ONLY. Vite string-key aliases prefix-match
 * (`'@deepseek-ai/dsh-llm'` would also capture `'@deepseek-ai/dsh-llm/brand'`
 * and rewrite it to `<replacement>/brand` — a file path plus a suffix, which
 * fails with ENOTDIR). Anchor every find with ^…$ so subpath imports fall
 * through to normal node_modules/exports resolution.
 */
const aliases = Object.entries(harnessAliases)
  .filter((entry): entry is [string, string] => entry[1] !== undefined)
  .map(([find, replacement]) => ({
    find: new RegExp(`^${find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
    replacement,
  }))

export default defineConfig({
  resolve: { alias: aliases },
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] })],
  test: {
    include: ['packages/*/*/tests/**/*.spec.ts', 'packages/launcher/*/tests/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/lib/**'],
  },
})
