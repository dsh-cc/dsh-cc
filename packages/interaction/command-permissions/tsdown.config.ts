import { defineConfig } from 'tsdown'

const ID = '@dsh-cc/command-permissions'

/**
 * Browser-only bundle: emits the ModuleLoader factory at `lib/client.js` (the
 * `exports["./client"].default` target) from `src/client/index.ts`. This is
 * deliberately NOT the harness `clientBundle` — that preset also rebuilds the
 * node half from `lib/types/...` which this package does not have. Type-only
 * imports of `@deepseek-ai/*` are erased, so there are no value imports of
 * them and no purity gate is needed.
 */
export default defineConfig({
  name: `${ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  sourcemap: true,
  clean: false,
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
