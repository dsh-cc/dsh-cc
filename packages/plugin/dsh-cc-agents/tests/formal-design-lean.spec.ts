import { chmod, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it, expect, vi } from 'vitest'
import { leanPreflight, main, parseLeanSyntax, resolveLeanRoot } from '../skills/formal-design/scripts/lean-preflight.mjs'
import { contentDigest, loadToolchain, platformKey } from '../skills/formal-design/scripts/lean-fingerprint.lib.mjs'

const fixtureDir = join(import.meta.dirname, 'fixtures/formal-design-lean')
const MODEL = 'specs/lean/budget-reservation'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function project() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'formal design lean ')); roots.push(root)
  await cp(join(fixtureDir, 'project/specs'), join(root, 'specs'), { recursive: true })
  return root
}
async function installation({ version = '4.35.0' } = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'lean root ')); roots.push(root)
  const destination = join(root, 'lean-4.35.0')
  await cp(join(fixtureDir, 'fake-lean'), destination, { recursive: true })
  const binary = join(destination, 'bin/lean')
  if (version !== '4.35.0') await writeFile(binary, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`)
  await chmod(binary, 0o755)
  return destination
}
async function receipt(destination: string, overrides = {}, platform = 'linux-x64') {
  const pin = await loadToolchain()
  const value = { schemaVersion: 1, toolchain: pin.toolchain, archiveSha256: pin.platforms[platform].sha256, contentDigest: await contentDigest(destination), ...overrides }
  await writeFile(`${destination}.receipt.json`, JSON.stringify(value))
  return value
}
const modelPath = (root: string) => join(root, MODEL)
const run = (projectRoot: string, leanRoot: string | undefined, extra = {}, deps = {}) => leanPreflight({ project: projectRoot, model: MODEL, 'lean-root': leanRoot, ...extra }, { platform: 'linux', arch: 'x64', env: {}, ...deps })
const swarm = (output: any) => output.blockers.map((b: any) => b.code)

describe('lean preflight readiness and installation pin', () => {
  it('is ready with a verified installation and records planned implementation bindings', async () => {
    const root = await project(); const destination = await installation(); await receipt(destination)
    const { output } = await run(root, destination)
    expect(output.status).toBe('ready')
    expect(output.blockers).toEqual([])
    expect(output.reason).toBe('ready')
    expect(output.toolchain).toMatchObject({ toolchain: 'leanprover/lean4:v4.35.0', platform: 'linux-x64', version: '4.35.0' })
    expect(output.plannedImplementationFiles).toEqual(['packages/example/src/budget.ts'])
  })
  it('blocks a missing, mismatched or stale installation receipt', async () => {
    const root = await project(); const destination = await installation()
    expect(swarm((await run(root, destination)).output)).toEqual(['toolchain-missing'])
    await receipt(destination, { archiveSha256: 'f'.repeat(64) })
    expect((await run(root, destination)).output.reason).toBe('toolchain-mismatch')
    await receipt(destination, { contentDigest: 'e'.repeat(64) })
    expect((await run(root, destination)).output.reason).toBe('toolchain-mismatch')
    await receipt(destination)
    await writeFile(join(destination, 'lib/lean/library/Init.olean'), 'tampered\n')
    expect((await run(root, destination)).output.reason).toBe('toolchain-mismatch')
  })
  it('blocks a wrong pinned version and a missing tool root', async () => {
    const root = await project(); const destination = await installation({ version: '4.35.1' }); await receipt(destination)
    const { output } = await run(root, destination)
    expect(output.reason).toBe('toolchain-mismatch')
    expect(output.blockers[0].detail).toContain('4.35.0')
    const absent = await run(root, undefined)
    expect(absent.output.reason).toBe('toolchain-missing')
    await expect(resolveLeanRoot(undefined, {})).rejects.toMatchObject({ code: 'toolchain-missing' })
  })
  it('accepts FORMAL_DESIGN_LEAN_ROOT only when --lean-root is absent', async () => {
    const root = await project(); const destination = await installation(); await receipt(destination)
    const viaEnv = await run(root, undefined, {}, { env: { FORMAL_DESIGN_LEAN_ROOT: destination } })
    expect(viaEnv.output.status).toBe('ready')
    const ignored = await run(root, undefined, {}, { env: { FORMAL_DESIGN_LEAN_ROOT: join(root, 'nowhere') } })
    expect(ignored.output.reason).toBe('toolchain-missing')
  })
  it('blocks a tool root without an executable bin/lean and an unsupported platform', async () => {
    const root = await project(); const destination = await installation(); await receipt(destination)
    await chmod(join(destination, 'bin/lean'), 0o644)
    expect((await run(root, destination)).output.reason).toBe('toolchain-missing')
    await chmod(join(destination, 'bin/lean'), 0o755)
    const other = await run(root, destination, {}, { platform: 'win32', arch: 'x64' })
    expect(other.output.reason).toBe('toolchain-missing')
    expect(other.output.toolchain).toBe(null)
  })
})

describe('lean preflight model layout and source scan', () => {
  it('blocks symlinked model entries as unsafe paths', async () => {
    const root = await project(); const destination = await installation(); await receipt(destination)
    await symlink(join(modelPath(root), 'design.md'), join(modelPath(root), 'linked.md'))
    expect((await run(root, destination)).output.reason).toBe('unsafe-path')
  })
  it.each(['Model.olean', 'lakefile.lean', 'lake-manifest.json'])('blocks a project build artifact: %s', async name => {
    const root = await project(); const destination = await installation(); await receipt(destination)
    await writeFile(join(modelPath(root), name), 'artifact')
    expect((await run(root, destination)).output.reason).toBe('config-invalid')
  })
  it('blocks a nested project build artifact under conformance/', async () => {
    const root = await project(); const destination = await installation(); await receipt(destination)
    await writeFile(join(modelPath(root), 'conformance/stale.olean'), 'artifact')
    expect((await run(root, destination)).output.reason).toBe('config-invalid')
  })
  it.each([
    ['Properties.lean', 'set_option debug.skipKernelTC true\n'],
    ['Model.lean', 'set_option maxHeartbeats 400000\n'],
    ['Reference.lean', 'set_option maxRecDepth 9000\n'],
  ])('blocks runner-owned or kernel-bypass options in %s', async (name, line) => {
    const root = await project(); const destination = await installation(); await receipt(destination)
    await writeFile(join(modelPath(root), name), await readFile(join(modelPath(root), name), 'utf8') + line)
    expect((await run(root, destination)).output.reason).toBe('config-invalid')
  })
  it('reports missing inputs and unexpected model entries', async () => {
    const root = await project(); const destination = await installation(); await receipt(destination)
    await rm(join(modelPath(root), 'design.md'))
    expect((await run(root, destination)).output.reason).toBe('missing-input')
    await writeFile(join(modelPath(root), 'design.md'), 'design')
    await writeFile(join(modelPath(root), 'notes.md'), 'extra')
    expect((await run(root, destination)).output.reason).toBe('config-invalid')
    await rm(join(modelPath(root), 'notes.md'))
    await rm(join(modelPath(root), 'conformance/adapter.mjs'))
    expect((await run(root, destination)).output.reason).toBe('missing-input')
  })
  it('blocks invalid UTF-8 in the manifest, a Lean source or the corpus', async () => {
    const root = await project(); const destination = await installation(); await receipt(destination)
    await writeFile(join(modelPath(root), 'Model.lean'), Buffer.from([0x6e, 0x61, 0x6d, 0x65, 0xff, 0x0a]))
    expect((await run(root, destination)).output.reason).toBe('config-invalid')
    await writeFile(join(modelPath(root), 'Model.lean'), 'namespace Formal\n')
    await writeFile(join(modelPath(root), 'conformance/cases.jsonl'), Buffer.from([0x7b, 0x7d, 0xfe]))
    expect((await run(root, destination)).output.reason).toBe('config-invalid')
    await writeFile(join(modelPath(root), 'checks.json'), Buffer.from([0xc3, 0x28]))
    expect((await run(root, destination)).output.reason).toBe('config-invalid')
  })
  it('blocks a corpus larger than maxCases and an unrecognized model path', async () => {
    const root = await project(); const destination = await installation(); await receipt(destination)
    const checks = join(modelPath(root), 'checks.json')
    const manifest = JSON.parse(await readFile(checks, 'utf8'))
    manifest.limits.maxCases = 1
    await writeFile(checks, JSON.stringify(manifest))
    expect((await run(root, destination)).output.reason).toBe('config-invalid')
    await expect(leanPreflight({ project: root, model: 'specs/tla/test', 'lean-root': destination }, { platform: 'linux', arch: 'x64', env: {} })).resolves.toMatchObject({ output: { reason: 'unsafe-path' } })
  })
  it('validates an optional bridge path without requiring conformance evidence', async () => {
    const root = await project(); const destination = await installation(); await receipt(destination)
    expect((await run(root, destination, { bridge: 'specs/formal/x/bridge.yaml' })).output.reason).toBe('config-invalid')
    expect((await run(root, destination, { bridge: 'specs/formal/demo/bridge.json' })).output.reason).toBe('missing-input')
    await mkdir(join(root, 'specs/formal/demo'), { recursive: true })
    await writeFile(join(root, 'specs/formal/demo/bridge.json'), '{}')
    expect((await run(root, destination, { bridge: 'specs/formal/demo/bridge.json' })).output.status).toBe('ready')
  })
})

describe('lean preflight CLI contract', () => {
  const capture = async (argv: string[]) => {
    const writes: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any) => { writes.push(String(chunk)); return true }) as any)
    try { return { code: await main(argv), text: writes.join('') } } finally { spy.mockRestore() }
  }
  it('prints plain help text and performs no tool execution', async () => {
    const { code, text } = await capture(['--help'])
    expect(code).toBe(0)
    expect(text).toContain('lean-preflight --project <root> --model specs/lean/<id>')
    expect(text.trim().startsWith('{')).toBe(false)
  })
  it('rejects unknown, duplicated and incomplete flags with one JSON object and exit 2', async () => {
    for (const argv of [['--project'], ['--project', 'a', '--model', MODEL, '--nope', 'x'], ['--project', 'a', '--project', 'b'], ['--model', MODEL]]) {
      const { code, text } = await capture(argv)
      expect(code).toBe(2)
      expect(text.trimEnd().split('\n')).toHaveLength(1)
      expect(JSON.parse(text)).toMatchObject({ command: 'lean-preflight', status: 'blocked', reason: 'config-invalid' })
    }
    expect(() => parseLeanSyntax(['--project', 'a', '--model', MODEL, '--lean-root', 'c', '--lean-root', 'd'])).toThrow()
  })
  it('exits 0 with exactly one JSON object when ready', async () => {
    const root = await project(); const destination = await installation(); await receipt(destination, {}, platformKey())
    const { code, text } = await capture(['--project', root, '--model', MODEL, '--lean-root', destination])
    expect(code).toBe(0)
    expect(text.trimEnd().split('\n')).toHaveLength(1)
    expect(JSON.parse(text)).toMatchObject({ command: 'lean-preflight', status: 'ready', reason: 'ready' })
  })
  it('writes nothing into the project or the installation tree', async () => {
    const root = await project(); const destination = await installation(); await receipt(destination)
    const before = { project: await listing(root), installation: await listing(destination) }
    await capture(['--project', root, '--model', MODEL, '--lean-root', destination])
    expect(await listing(root)).toEqual(before.project)
    expect(await listing(destination)).toEqual(before.installation)
  })
})

async function listing(dir: string, base = dir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const found: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    found.push(full.slice(base.length))
    if (entry.isDirectory()) found.push(...await listing(full, base))
  }
  return found.sort()
}
