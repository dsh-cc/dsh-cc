import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Package-local mirror of the root vitest config: the worktree root
// node_modules is a symlink the sandbox cannot write into (.vite-temp), so
// tests in this package run against this local config with the
// `--configLoader runner` flag (no bundle step, no .vite-temp write).
// Aliases mirror the tsconfig.base.json `paths` entries these tests rely on.
const here = new URL('.', import.meta.url)
const src = (relative) => fileURLToPath(new URL(relative, here))
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@dsh-cc\/dsh-cc-session-cwd$/, replacement: src('./src/index.ts') },
      { find: '@dsh-cc/session-cwd/', replacement: src('./src/') },
      { find: /^@dsh-cc\/dsh-cc-tools$/, replacement: src('../../core/tools/src/index.ts') },
      { find: /^@dsh-cc\/dsh-cc-permission-rules$/, replacement: src('../../interaction/permission-rules/src/index.ts') },
    ],
  },
  test: {
    include: ['tests/**/*.spec.ts'],
  },
})
