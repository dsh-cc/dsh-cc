/**
 * Package-local vitest config: the root config's `include` globs are relative
 * to the repo root, so `pnpm --filter @dsh-cc/input-budget test` (cwd = this
 * package) needs its own scope. The root `pnpm test` run is unaffected — it
 * collects this package through the root config.
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
  },
})
