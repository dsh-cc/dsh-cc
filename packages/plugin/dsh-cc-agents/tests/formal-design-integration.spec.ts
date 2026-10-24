import { mkdtemp, mkdir, cp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { describe, it, expect } from 'vitest'
const jar = process.env.TLA2TOOLS_JAR
if (process.env.FORMAL_DESIGN_CI === '1' && !jar) throw new Error('Dedicated formal-design CI requires TLA2TOOLS_JAR')
const fixtureDir = join(import.meta.dirname, 'fixtures/formal-design')
const scripts = join(import.meta.dirname, '../skills/formal-design/scripts')
const command = (file: string, args: string[]) => new Promise<any>((res, rej) => {
  const child = spawn(process.execPath, [join(scripts, file), ...args], { shell: false }); let stdout = ''; let stderr = ''
  child.stdout.on('data', b => { stdout += b }); child.stderr.on('data', b => { stderr += b }); child.once('error', rej)
  child.once('close', code => { try { res({ code, output: JSON.parse(stdout), stderr }) } catch { rej(new Error(`${stdout}\n${stderr}`)) } })
})
describe.skipIf(!jar)('formal-design real TLC v1.7.4', () => {
  it.each([
    ['correct', 'verified', 'verified'], ['buggy-callback', 'counterexample', 'invariant'],
    ['deadlock', 'counterexample', 'deadlock'], ['liveness-pass', 'verified', 'verified'], ['liveness-fail', 'counterexample', 'temporal'],
    ['syntax-error', 'error', 'config-invalid'], ['empty-init', 'incomplete', 'output-invalid'], ['safety-property', 'verified', 'verified'],
    ['initial-invariant', 'counterexample', 'invariant'], ['assumption-failed', 'error', 'assumption-failed'],
    ['value-assert', 'counterexample', 'value-assert'], ['invariant-evaluation', 'error', 'property-evaluation-failed'],
    ['property-evaluation', 'error', 'property-evaluation-failed'], ['next-evaluation', 'error', 'unknown-error'],
    ['config-event', 'error', 'config-invalid'], ['safety-evaluation', 'error', 'property-evaluation-failed'], ['action-evaluation', 'error', 'unknown-error'],  ['late-event-correct', 'verified', 'verified'], ['late-event-buggy', 'counterexample', 'invariant'],
  ])('%s produces %s/%s and round-trips through the auditor', async (name, status, reason) => {
    const root = await mkdtemp(join(tmpdir(), 'formal TLC ')); const model = `specs/tla/${name}`
    try {
      await mkdir(join(root, 'specs/tla'), { recursive: true }); await cp(join(fixtureDir, name), join(root, model), { recursive: true })
      const args = ['--project', root, '--model', model]
      const pre = await command('preflight.mjs', [...args, '--jar', resolve(jar!)])
      expect(pre.output, pre.stderr).toMatchObject({ status: 'ready-for-check', willGenerate: ['cases/small.cfg'] })
      const checked = await command('check.mjs', [...args, '--jar', resolve(jar!)])
      expect(checked.output, JSON.stringify(checked.output)).toMatchObject({ status, reason })
      expect(checked.code).toBe(({ verified: 0, counterexample: 1, error: 2, incomplete: 3 } as any)[status])
      const audit = await command('check-evidence.mjs', args)
      expect(audit.output).toMatchObject({ status: 'valid', fresh: true, verification: status })
      if (name === 'safety-property') expect(checked.output.summary.cases[0].eventCodes).not.toContain(2267)
      if (name === 'correct') {
        await writeFile(join(root, model, 'design.md'), 'changed semantics')
        expect((await command('check-evidence.mjs', args)).output.reason).toBe('stale/input')
        expect((await command('check.mjs', [...args, '--jar', resolve(jar!)])).output.status).toBe('verified')
        expect((await command('check-evidence.mjs', args)).output.status).toBe('valid')
      }
    } finally {
      if (process.env.FORMAL_DESIGN_ARTIFACTS) { await mkdir(process.env.FORMAL_DESIGN_ARTIFACTS, { recursive: true }); await cp(root, join(process.env.FORMAL_DESIGN_ARTIFACTS, name), { recursive: true }) }
      await rm(root, { recursive: true, force: true })
    }
  }, 30000)
})

import { runCase } from '../skills/formal-design/scripts/process.lib.mjs'
describe.skipIf(!jar)('formal-design raw pinned cfg parser protocol', () => {
  it('pins exit 255 nested cfg-parse events while the producer rejects that grammar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'formal cfg '))
    try {
      await cp(join(fixtureDir, 'cfg-parse'), root, { recursive: true })
      const cfg = join(root, 'invalid.cfg')
      await writeFile(cfg, 'SPECIFICATION Spec\nCONSTANT C = -1\nINVARIANT TypeOK\nCHECK_DEADLOCK TRUE\n')
      const c = { id: 'cfg-parse', coverage: 'core', limits: { timeoutMs: 20000, heapMiB: 256 } }
      const result = await runCase(c, ['java', '-Xmx256m', '-cp', resolve(jar!), 'tlc2.TLC', '-tool', '-workers', '1', '-seed', '1', '-fp', '0', '-metadir', join(root, 'states'), '-config', cfg, 'Model'], root, join(root, 'logs'))
      expect(result).toMatchObject({ exitCode: 255, status: 'error', reason: 'config-invalid' })
      expect(result.eventCodes).toContain(5006)
    } finally {
      if (process.env.FORMAL_DESIGN_ARTIFACTS) { await mkdir(process.env.FORMAL_DESIGN_ARTIFACTS, { recursive: true }); await cp(root, join(process.env.FORMAL_DESIGN_ARTIFACTS, 'cfg-parse-raw'), { recursive: true }) }
      await rm(root, { recursive: true, force: true })
    }
  }, 30000)
})
