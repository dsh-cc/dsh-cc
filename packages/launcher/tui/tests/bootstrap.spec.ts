import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { bootstrapCommand, dshUnavailableMessage, interceptResume, PROFILE, sanitizeInheritedEnv, spawnEnv } from '../bootstrap.mjs'

describe('dsh-cc launcher bootstrap', () => {
  it('targets the tui profile, not cc', () => {
    expect(PROFILE).toBe('tui')
    const command = bootstrapCommand(false, '0.1.0')
    expect(command).toEqual([
      'plugin',
      '--profile',
      'tui',
      'add',
      '@dsh-cc/bundle-permissions@0.1.0',
      '@dsh-cc/bundle-shell@0.1.0',
      '@dsh-cc/bundle-tui@0.1.0',
    ])
  })

  it('skips install when the profile already exists', () => {
    expect(bootstrapCommand(true, '0.1.0')).toBeUndefined()
  })
})

describe('interceptResume env contract', () => {
  it('no flags → AUTO_RESUME and no RESUME_SESSION', () => {
    const { env, args } = interceptResume(undefined, ['--verbose'], { KEEP: '1' })
    expect(env.DSH_CC_RESUME_SESSION).toBeUndefined()
    expect(env.DSH_CC_AUTO_RESUME).toBe('1')
    expect(env.DSH_CC_CONTINUE).toBeUndefined()
    expect(env.KEEP).toBe('1')
    expect(args).toEqual(['--verbose'])
  })

  it('lifts --resume into RESUME_SESSION and suppresses AUTO_RESUME', () => {
    const { env, args } = interceptResume(undefined, ['--resume', 'abc', '--verbose'], { KEEP: '1' })
    expect(env.DSH_CC_RESUME_SESSION).toBe('abc')
    expect(env.DSH_CC_AUTO_RESUME).toBeUndefined()
    expect(env.DSH_CC_CONTINUE).toBeUndefined()
    expect(env.KEEP).toBe('1')
    expect(args).toEqual(['--verbose'])
  })

  it('lifts --resume=x into RESUME_SESSION and suppresses AUTO_RESUME', () => {
    const { env, args } = interceptResume(undefined, ['--resume=x'], {})
    expect(env.DSH_CC_RESUME_SESSION).toBe('x')
    expect(env.DSH_CC_AUTO_RESUME).toBeUndefined()
    expect(args).toEqual([])
  })

  it('maps --new to the empty fresh sentinel and sets no AUTO_RESUME', () => {
    const { env, args } = interceptResume(undefined, ['--new'], { KEEP: '1' })
    expect(env.DSH_CC_RESUME_SESSION).toBe('')
    expect(env.DSH_CC_AUTO_RESUME).toBeUndefined()
    expect(args).toEqual([])
  })

  it('maps -n to the empty fresh sentinel with no AUTO_RESUME', () => {
    const { env, args } = interceptResume(undefined, ['-n'], {})
    expect(env.DSH_CC_RESUME_SESSION).toBe('')
    expect(env.DSH_CC_AUTO_RESUME).toBeUndefined()
    expect(args).toEqual([])
  })

  it('accepts the resumeFlag first-arg path (no AUTO_RESUME)', () => {
    const { env, args, continueRequested } = interceptResume('abc', ['--verbose'], {})
    expect(env.DSH_CC_RESUME_SESSION).toBe('abc')
    expect(env.DSH_CC_AUTO_RESUME).toBeUndefined()
    expect(env.DSH_CC_CONTINUE).toBeUndefined()
    expect(continueRequested).toBe(false)
    expect(args).toEqual(['--verbose'])
  })

  it('sets CONTINUE and AUTO_RESUME for -c, leaving RESUME_SESSION undefined', () => {
    const { env, args, continueRequested } = interceptResume(undefined, ['-c', '--verbose'], { KEEP: '1' })
    expect(env.DSH_CC_CONTINUE).toBe('1')
    expect(env.DSH_CC_AUTO_RESUME).toBe('1')
    expect(env.DSH_CC_RESUME_SESSION).toBeUndefined()
    expect(continueRequested).toBe(true)
    expect(env.KEEP).toBe('1')
    expect(args).toEqual(['--verbose'])
  })

  it('sets CONTINUE and AUTO_RESUME for --continue', () => {
    const { env, args, continueRequested } = interceptResume(undefined, ['--continue'], {})
    expect(env.DSH_CC_CONTINUE).toBe('1')
    expect(env.DSH_CC_AUTO_RESUME).toBe('1')
    expect(env.DSH_CC_RESUME_SESSION).toBeUndefined()
    expect(continueRequested).toBe(true)
    expect(args).toEqual([])
  })

  it('lets --resume win over --new regardless of order (no AUTO_RESUME)', () => {
    for (const rest of [['--resume', 'abc', '--new'], ['--new', '--resume', 'abc']]) {
      const { env, args } = interceptResume(undefined, rest, {})
      expect(env.DSH_CC_RESUME_SESSION).toBe('abc')
      expect(env.DSH_CC_AUTO_RESUME).toBeUndefined()
      expect(args).toEqual([])
    }
  })

  it('lets --new win over -c regardless of order (sets no AUTO_RESUME)', () => {
    for (const rest of [['-c', '--new'], ['--new', '-c']]) {
      const { env, args } = interceptResume(undefined, rest, {})
      expect(env.DSH_CC_RESUME_SESSION).toBe('')
      expect(env.DSH_CC_AUTO_RESUME).toBeUndefined()
      expect(env.DSH_CC_CONTINUE).toBe('1')
      expect(args).toEqual([])
    }
  })

  it('strips every resume-mode flag while passing the rest through', () => {
    const { env, args } = interceptResume(
      undefined,
      ['--continue', '--patch', 'demo', '-n', '-c', '--resume=x'],
      {},
    )
    expect(args).toEqual(['--patch', 'demo'])
    expect(env.DSH_CC_RESUME_SESSION).toBe('x')
    expect(env.DSH_CC_AUTO_RESUME).toBeUndefined()
    expect(env.DSH_CC_CONTINUE).toBe('1')
  })

  it('reports whether -c/--continue was requested', () => {
    expect(interceptResume(undefined, ['-c'], {}).continueRequested).toBe(true)
    expect(interceptResume(undefined, ['--continue', 'x'], {}).continueRequested).toBe(true)
    expect(interceptResume(undefined, ['--new', '-n'], {}).continueRequested).toBe(false)
  })

  it('passes unrelated incoming env through untouched', () => {
    const incoming = { KEEP: '1', OTHER: '2', DSH_CC_RESUME_SESSION: 'leaked' }
    const { env } = interceptResume(undefined, ['--verbose'], incoming)
    expect(env.KEEP).toBe('1')
    expect(env.OTHER).toBe('2')
  })
})

describe('sanitizeInheritedEnv', () => {
  it('removes exactly the three launcher-owned DSH_CC_* vars when present', () => {
    const env = {
      DSH_CC_RESUME_SESSION: 'abc',
      DSH_CC_AUTO_RESUME: '1',
      DSH_CC_CONTINUE: '1',
      KEEP: '1',
      PATH: '/bin',
    }
    const out = sanitizeInheritedEnv(env)
    expect(out).toEqual({ KEEP: '1', PATH: '/bin' })
  })

  it('returns a new object and does not mutate the input', () => {
    const env = { DSH_CC_AUTO_RESUME: '1', KEEP: '1' }
    const out = sanitizeInheritedEnv(env)
    expect(out).not.toBe(env)
    expect(env).toEqual({ DSH_CC_AUTO_RESUME: '1', KEEP: '1' })
  })

  it('preserves unrelated variables and is a no-op when the vars are absent', () => {
    const env = { KEEP: '1', DSH_CC_WORKTREE: '{}' }
    expect(sanitizeInheritedEnv(env)).toEqual({ KEEP: '1', DSH_CC_WORKTREE: '{}' })
  })
})

describe('dshUnavailableMessage', () => {
  it('contains both guidance lines', () => {
    const message = dshUnavailableMessage()
    expect(message).toContain('dsh-cc: the `dsh` CLI is not on PATH.')
    expect(message).toContain('npm install -g @deepseek-ai/dsh')
    expect(message.split('\n').length).toBeGreaterThanOrEqual(2)
  })
})

describe('spawnEnv NODE_COMPILE_CACHE contract', () => {
  it('injects the default cache dir under dshHome when unset', () => {
    const out = spawnEnv({ PATH: '/bin' }, '/home/x/.dsh')
    expect(out.NODE_COMPILE_CACHE).toBe(join('/home/x/.dsh', '.cache', 'node-compile-cache'))
  })

  it('preserves a user-set NODE_COMPILE_CACHE verbatim', () => {
    const out = spawnEnv({ NODE_COMPILE_CACHE: '/custom/cache' }, '/home/x/.dsh')
    expect(out.NODE_COMPILE_CACHE).toBe('/custom/cache')
  })

  it('never mutates its input', () => {
    const env = { PATH: '/bin' }
    const out = spawnEnv(env, '/home/x/.dsh')
    expect(out).not.toBe(env)
    expect(env.NODE_COMPILE_CACHE).toBeUndefined()
  })
})

describe('missing-dsh integration (spawned bin, dsh-free PATH)', () => {
  const GUIDANCE_1 = 'dsh-cc: the `dsh` CLI is not on PATH.'
  const GUIDANCE_2 = 'Install deepseek-harness first, e.g.:  npm install -g @deepseek-ai/dsh'
  const binPath = join(import.meta.dirname, '..', 'bin', 'dsh-cc.js')
  let tmpDir
  let emptyBin

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dsh-cc-missing-dsh-'))
    emptyBin = join(tmpDir, 'bin')
    mkdirSync(emptyBin)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function runBin(extraEnv) {
    return spawnSync(process.execPath, [binPath], {
      encoding: 'utf8',
      env: { ...process.env, PATH: emptyBin, DSH_HOME: tmpDir, ...extraEnv },
    })
  }

  it('exits 1 with guidance on the first-run bootstrap-install path', () => {
    const result = runBin({})
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(GUIDANCE_1)
    expect(result.stderr).toContain(GUIDANCE_2)
    expect(result.stderr).not.toContain('plugin install failed')
  })

  it('exits 1 with guidance on the hand-off path when the profile already exists', () => {
    mkdirSync(join(tmpDir, 'profiles', 'tui'), { recursive: true })
    writeFileSync(join(tmpDir, 'profiles', 'tui', 'package.json'), '{"name":"tui"}')
    const result = runBin({})
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(GUIDANCE_1)
    expect(result.stderr).toContain(GUIDANCE_2)
  })
})
