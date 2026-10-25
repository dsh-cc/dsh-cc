import { mkdtemp, mkdir, cp, rm, readFile, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { describe, it, expect } from 'vitest'
const bundledJar = resolve(import.meta.dirname, '../skills/formal-design/toolchain/tla2tools.jar')
const jar = process.env.TLA2TOOLS_JAR || (process.env.FORMAL_DESIGN_CI === '1' ? bundledJar : undefined)
const fixtureDir = join(import.meta.dirname, 'fixtures/formal-design')
const scripts = join(import.meta.dirname, '../skills/formal-design/scripts')
// The runner realpath-normalizes resolved paths; use a canonical temp base so
// expected values compare equal behind symlinked tmpdirs (macOS /var/folders).
let canonicalTmp: string | null = null
async function tmpBase(): Promise<string> { return canonicalTmp ??= await realpath(tmpdir()) }

const command = (file: string, args: string[], options: { base?: string; env?: NodeJS.ProcessEnv } = {}) => new Promise<any>((res, rej) => {
  const child = spawn(process.execPath, [join(options.base ?? scripts, file), ...args], { shell: false, env: options.env ?? process.env }); let stdout = ''; let stderr = ''
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
    const root = await mkdtemp(join(await tmpBase(), 'formal TLC ')); const model = `specs/tla/${name}`
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
    const root = await mkdtemp(join(await tmpBase(), 'formal cfg '))
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


describe.skipIf(!jar)('formal-design default bundled distribution', () => {
  it('runs the packed skill end to end with no JAR flag or environment configuration', async () => {
    const root = await mkdtemp(join(await tmpBase(), 'formal packed '))
    try {
      const pkg = resolve(import.meta.dirname, '..')
      const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', root], { cwd: pkg, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))[0]
      execFileSync('tar', ['-xzf', join(root, packed.filename), '-C', root])
      const packedSkill = join(root, 'package/skills/formal-design')
      const project = join(root, 'project'); const model = 'specs/tla/task-lifecycle'
      await mkdir(join(project, 'specs/tla'), { recursive: true })
      await cp(join(packedSkill, 'examples/task-lifecycle'), join(project, model), { recursive: true })
      const env = { ...process.env }; delete env.TLA2TOOLS_JAR
      const options = { base: join(packedSkill, 'scripts'), env }
      const args = ['--project', project, '--model', model]
      expect((await command('preflight.mjs', args, options)).output).toMatchObject({ status: 'ready-for-check', willGenerate: [] })
      const checked = await command('check.mjs', args, options)
      expect(checked.output).toMatchObject({ status: 'verified', summary: { jarPath: join(packedSkill, 'toolchain/tla2tools.jar'), jarSha256: '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88' } })
      expect(checked.code).toBe(0)
      expect((await command('check-evidence.mjs', args, options)).output).toMatchObject({ status: 'valid', fresh: true, verification: 'verified' })
    } finally {
      if (process.env.FORMAL_DESIGN_ARTIFACTS) { await mkdir(process.env.FORMAL_DESIGN_ARTIFACTS, { recursive: true }); await cp(root, join(process.env.FORMAL_DESIGN_ARTIFACTS, 'packed-bundle'), { recursive: true }) }
      await rm(root, { recursive: true, force: true })
    }
  }, 30000)
})
