import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ACP_APP_PIN,
  ACP_BUNDLES,
  ACP_PROFILE,
  BOOTSTRAP_STAMP,
  acpBundleSpec,
  bootstrapCommand,
  runStoreHeal,
  runStoreRestore,
} from '../bootstrap.mjs'

let root: string | null = null
afterEach(() => {
  if (root !== null) rmSync(root, { recursive: true, force: true })
  root = null
})

function tmp(): string {
  root ??= mkdtempSync(join(tmpdir(), 'dsh-cc-acp-'))
  return root
}

describe('ACP floor constants', () => {
  it('targets the cc-acp profile with the design floor list', () => {
    expect(ACP_PROFILE).toBe('cc-acp')
    expect(ACP_BUNDLES).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-acp-app',
      '@dsh-cc/bundle-permissions',
      '@dsh-cc/bundle-shell',
      '@dsh-cc/bundle-acp',
    ])
    expect(ACP_APP_PIN).toBe('0.2.0-rc.2')
  })

  it('builds install specifiers: dsh-base bare, dsh-acp-app pinned, @dsh-cc at launcher version', () => {
    expect(acpBundleSpec('@deepseek-ai/dsh-base', '9.9.9')).toBe('@deepseek-ai/dsh-base')
    expect(acpBundleSpec('@deepseek-ai/dsh-acp-app', '9.9.9')).toBe(`@deepseek-ai/dsh-acp-app@${ACP_APP_PIN}`)
    expect(acpBundleSpec('@dsh-cc/bundle-acp', '9.9.9')).toBe('@dsh-cc/bundle-acp@9.9.9')
  })

  it('builds the ACP plugin-add argv (and leaves the TUI default alone)', () => {
    const specFor = (name: string) => acpBundleSpec(name, '1.2.3')
    const add = bootstrapCommand(false, '1.2.3', { profile: ACP_PROFILE, bundles: ACP_BUNDLES, specFor })
    expect(add).toEqual([
      'plugin', '--profile', 'cc-acp', 'add',
      '@deepseek-ai/dsh-base',
      `@deepseek-ai/dsh-acp-app@${ACP_APP_PIN}`,
      '@dsh-cc/bundle-permissions@1.2.3',
      '@dsh-cc/bundle-shell@1.2.3',
      '@dsh-cc/bundle-acp@1.2.3',
    ])
    expect(bootstrapCommand(true, '1.2.3', { profile: ACP_PROFILE, bundles: ACP_BUNDLES, specFor })).toBeUndefined()
    // tui path unchanged
    expect(bootstrapCommand(false, '1.2.3')).toEqual([
      'plugin', '--profile', 'tui', 'add',
      '@dsh-cc/bundle-permissions@1.2.3', '@dsh-cc/bundle-shell@1.2.3', '@dsh-cc/bundle-tui@1.2.3',
    ])
  })

  it('heal and restore honor the ACP floor list and specifiers', () => {
    const home = tmp()
    const profileDir = join(home, 'profiles', 'cc-acp')
    mkdirSync(profileDir, { recursive: true })
    const calls: string[][] = []
    const specFor = (name: string) => acpBundleSpec(name, '2.0.0')
    const opts = { spawnSyncImpl: (_c: string, argv: string[]) => { calls.push(argv); return { status: 0 } }, bundles: ACP_BUNDLES, specFor }
    runStoreHeal(profileDir, '2.0.0', { from: '1.0.0', ...opts })
    runStoreRestore(profileDir, '2.0.0', opts)
    for (const argv of calls) {
      expect(argv).toEqual(['plugin', '--profile', 'cc-acp', 'add', ...ACP_BUNDLES.map(specFor)])
    }
  })
})

// --- subprocess tests: the real bin with a fake `dsh` on PATH ----------------

const bin = fileURLToPath(new URL('../bin/dsh-cc.js', import.meta.url))

/** Fake `dsh`: appends each invocation's argv (and the DSH_CC_* env leak set) to $ACP_FAKE_DSH_LOG. */
const FAKE_DSH = `#!/bin/sh
{
  echo "argv: $*"
  echo "env-resume: \${DSH_CC_RESUME_SESSION-unset}"
  echo "env-auto: \${DSH_CC_AUTO_RESUME-unset}"
  echo "env-continue: \${DSH_CC_CONTINUE-unset}"
} >> "$ACP_FAKE_DSH_LOG"
`

function makeFakeDshEnv(home: string): { binDir: string, logPath: string, env: NodeJS.ProcessEnv } {
  const binDir = join(home, 'bin')
  mkdirSync(binDir, { recursive: true })
  writeFileSync(join(binDir, 'dsh'), FAKE_DSH, { mode: 0o755 })
  const logPath = join(home, 'dsh-calls.log')
  writeFileSync(logPath, '')
  return { binDir, logPath, env: { ...process.env, PATH: `${binDir}:/usr/bin:/bin`, DSH_HOME: home, ACP_FAKE_DSH_LOG: logPath } }
}

function runBin(env: NodeJS.ProcessEnv, extraArgs: string[] = []) {
  return spawnSync(process.execPath, [bin, 'acp', ...extraArgs], { encoding: 'utf8', env })
}

function readCalls(logPath: string): string[] {
  return readFileSync(logPath, 'utf8').split('\n').filter(line => line.startsWith('argv: '))
}

const OWN_VERSION = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).version as string
const EXPECTED_SPECS = ACP_BUNDLES.map(name => acpBundleSpec(name, OWN_VERSION))

describe('dsh-cc acp subprocess (fake dsh on PATH)', () => {
  it('fresh floor: installs the ACP bundle set, logs to stderr, keeps stdout pure, forwards args', () => {
    const home = tmp()
    const { logPath, env } = makeFakeDshEnv(home)
    const r = runBin(env, ['--verbose', 'x'])
    expect(r.status).toBe(0)
    const calls = readCalls(logPath)
    expect(calls.find(c => c.includes('plugin'))).toBe(`argv: plugin --profile cc-acp add ${EXPECTED_SPECS.join(' ')}`)
    expect(calls.at(-1)).toBe('argv: --profile cc-acp --verbose x')
    // protocol stdout purity: nothing from bootstrap or the fake child
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain(`initializing profile "${ACP_PROFILE}"`)
  })

  it('warm floor: converged profile runs dsh directly, no install call', () => {
    const home = tmp()
    const profileDir = join(home, 'profiles', 'cc-acp')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), '{"name":"cc-acp"}')
    writeFileSync(join(profileDir, BOOTSTRAP_STAMP), JSON.stringify({ launcherVersion: OWN_VERSION }))
    const { logPath, env } = makeFakeDshEnv(home)
    const r = runBin(env)
    expect(r.status).toBe(0)
    expect(readCalls(logPath)).toEqual(['argv: --profile cc-acp'])
    expect(r.stdout).toBe('')
    expect(r.stderr).not.toContain('initializing')
  })

  it('upgrade: launcher version change heals (re-installs) the ACP floor', () => {
    const home = tmp()
    const profileDir = join(home, 'profiles', 'cc-acp')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), '{"name":"cc-acp"}')
    writeFileSync(join(profileDir, BOOTSTRAP_STAMP), JSON.stringify({ launcherVersion: '0.0.1' }))
    const { logPath, env } = makeFakeDshEnv(home)
    const r = runBin(env)
    expect(r.status).toBe(0)
    const calls = readCalls(logPath)
    expect(calls.find(c => c.includes('plugin'))).toBe(`argv: plugin --profile cc-acp add ${EXPECTED_SPECS.join(' ')}`)
    expect(calls.at(-1)).toBe('argv: --profile cc-acp')
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('re-installed store bundles')
  })

  it('heal: missing stamp on an existing profile re-installs store bundles', () => {
    const home = tmp()
    const profileDir = join(home, 'profiles', 'cc-acp')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), '{"name":"cc-acp"}')
    const { logPath, env } = makeFakeDshEnv(home)
    const r = runBin(env)
    expect(r.status).toBe(0)
    expect(readCalls(logPath)[0]).toBe(`argv: plugin --profile cc-acp add ${EXPECTED_SPECS.join(' ')}`)
    expect(r.stdout).toBe('')
    // the heal re-stamped the profile with this launcher's version
    expect(JSON.parse(readFileSync(join(profileDir, BOOTSTRAP_STAMP), 'utf8')).launcherVersion).toBe(OWN_VERSION)
  })

  it('restore: dev-synced profile with an old launcher stamp restores store bundles', () => {
    const home = tmp()
    const profileDir = join(home, 'profiles', 'cc-acp')
    const scope = join(profileDir, 'node_modules', '@dsh-cc')
    mkdirSync(scope, { recursive: true })
    mkdirSync(join(scope, 'bundle-acp'))
    writeFileSync(join(scope, 'bundle-acp', 'sentinel'), 'dev')
    writeFileSync(join(scope, 'dsh-cc-build.json'), JSON.stringify({ channel: 'dev', version: '0.0.1', commit: 'abc12345678', dirty: false, launcherVersion: '0.0.1' }))
    const { logPath, env } = makeFakeDshEnv(home)
    const r = runBin(env)
    expect(r.status).toBe(0)
    const calls = readCalls(logPath)
    expect(calls.find(c => c.includes('plugin'))).toBe(`argv: plugin --profile cc-acp add ${EXPECTED_SPECS.join(' ')}`)
    // restore committed: the dev scope and its build stamp are gone (the
    // fake dsh performs no real re-materialize), the profile is re-stamped
    expect(existsSync(join(scope, 'bundle-acp', 'sentinel'))).toBe(false)
    expect(existsSync(join(scope, 'dsh-cc-build.json'))).toBe(false)
    expect(JSON.parse(readFileSync(join(profileDir, BOOTSTRAP_STAMP), 'utf8')).launcherVersion).toBe(OWN_VERSION)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('restored store bundles')
  })

  it('never runs TUI arg processing: resume flags pass through and leaked DSH_CC_* env is stripped', () => {
    const home = tmp()
    const profileDir = join(home, 'profiles', 'cc-acp')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), '{"name":"cc-acp"}')
    writeFileSync(join(profileDir, BOOTSTRAP_STAMP), JSON.stringify({ launcherVersion: OWN_VERSION }))
    const { logPath, env } = makeFakeDshEnv(home)
    const r = runBin(env, ['--resume', 'abc'])
    expect(r.status).toBe(0)
    // --resume was NOT intercepted (a TUI run would strip it and set env)
    expect(readCalls(logPath).at(-1)).toBe('argv: --profile cc-acp --resume abc')
    const envDump = readFileSync(logPath, 'utf8')
    expect(envDump).toContain('env-resume: unset')
    expect(envDump).toContain('env-auto: unset')
    expect(envDump).toContain('env-continue: unset')
    expect(r.stdout).toBe('')
  })
})
