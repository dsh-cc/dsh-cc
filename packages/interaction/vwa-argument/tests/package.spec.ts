/** Verify shipped bytes and runtime asset lookup, independent of source-file resolution. */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const packageRoot = resolve(import.meta.dirname, '..')
describe('published argument package', () => {
  it('includes every prompt and loads each one through the packed lib entry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vwa-package-'))
    try {
      const result = JSON.parse(
        execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', dir], {
          cwd: packageRoot,
          encoding: 'utf8',
        }),
      )[0]
      for (const name of ['sources', 'support', 'claims', 'arguments', 'extract', 'align']) {
        expect(result.files.map((file: { path: string }) => file.path)).toContain(`prompts/${name}.md`)
      }
      execFileSync('tar', ['-xzf', join(dir, result.filename), '-C', dir])
      symlinkSync(join(packageRoot, 'node_modules'), join(dir, 'package', 'node_modules'), 'dir')
      const entry = join(dir, 'package/lib/review-contract.js')
      const script = `const m=await import(${JSON.stringify(entry)});for(const s of ['sources','support','claims','arguments','extract','align']){if(!m.loadPrompt(s).includes('independent'))throw Error(s)};console.log('packed prompts OK')`
      const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
      expect(output.trim()).toBe('packed prompts OK')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)
})
