#!/usr/bin/env node
/**
 * Optional shortcut for `dsh --profile tui`. Canonical command remains
 * `dsh --profile tui`. Do not ship a `dsh-tui` bin — that name belongs to
 * the unrelated published dsh-TUI product.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootstrapCommand, dshUnavailableMessage, existingWorktreeDecision, interceptResume, parseWorktreeFlag, planWorktree, PROFILE, sanitizeInheritedEnv, slugRetryDecision, spawnEnv, versionGate, worktreeAddArgv, worktreeEnv } from '../bootstrap.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const ownVersion = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version

if (process.argv.includes('--version') || process.argv.includes('-V')) {
  console.log(ownVersion)
  process.exit(0)
}

const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const profileDir = join(home, 'profiles', PROFILE)
const add = bootstrapCommand(existsSync(join(profileDir, 'package.json')), ownVersion)
if (add !== undefined) {
  console.error(`dsh-cc: initializing profile "${PROFILE}"…`)
  // Minimum-version gate runs ONLY here (bootstrap/install path), never on
  // every launch — docs/plans/2026-09-05-startup-boot-first-frame.md W2
  // removed the per-launch `dsh --version` probe for cold-start latency.
  // Unparseable output fails open: the check must never brick the launcher.
  const gate = versionGate(() => spawnSync('dsh', ['--version'], { encoding: 'utf8' }))
  if (gate.warning) console.error(gate.warning)
  if (!gate.ok) {
    console.error(gate.message)
    process.exit(1)
  }
  const installed = spawnSync('dsh', add, { encoding: 'utf8', stdio: 'inherit' })
  // A spawn error (e.g. dsh not on PATH) leaves status null — that is a
  // missing-CLI problem, not an install failure.
  if (installed.error) {
    console.error(dshUnavailableMessage())
    process.exit(1)
  }
  if (installed.status !== 0) {
    console.error(`dsh-cc: plugin install failed. Retry:\n  dsh ${add.join(' ')}`)
    process.exit(installed.status ?? 1)
  }
}

// A parent dsh-cc TUI process leaks DSH_CC_RESUME_SESSION / DSH_CC_AUTO_RESUME
// / DSH_CC_CONTINUE into a child launcher's environment. Strip them up front —
// before any flag is parsed — so the three are re-derived only from THIS
// invocation's argv (see sanitizeInheritedEnv). In particular an inherited
// DSH_CC_AUTO_RESUME=1 would otherwise defeat an explicit --new / --worktree.
const env0 = sanitizeInheritedEnv({ ...process.env })

// `--worktree [name]` is intercepted here (never forwarded to dsh): the
// launcher creates `<repoRoot>/.claude/worktrees/<slug>` itself and starts
// the session inside it, marking it via DSH_CC_WORKTREE so the TUI offers
// cleanup at /quit time.
const worktree = parseWorktreeFlag(process.argv.slice(2))
let spawnCwd
if (worktree.name !== undefined) {
  // A fresh worktree starts a new session (--new equivalent): set at the end
  // of this block. A REUSED worktree leaves DSH_CC_RESUME_SESSION undefined,
  // so interceptResume sets DSH_CC_AUTO_RESUME=1 and the TUI resumes the
  // project's last session.
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' })
  if (top.error || top.status !== 0) {
    console.error('dsh-cc: --worktree requires a git repository (run from inside a git working tree).')
    process.exit(1)
  }
  const repoRoot = top.stdout.trim()
  // Drop stale registrations left by crashed sessions before planning paths.
  spawnSync('git', ['-C', repoRoot, 'worktree', 'prune'], { encoding: 'utf8' })
  const head = spawnSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
  if (head.error || head.status !== 0) {
    console.error('dsh-cc: could not resolve HEAD; is this a repository without commits?')
    process.exit(1)
  }
  const named = worktree.name !== null
  let plan = null
  let created = false
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    let candidate
    try {
      candidate = planWorktree(repoRoot, worktree.name)
    } catch (error) {
      console.error(`dsh-cc: ${error.message}`)
      process.exit(1)
    }
    const pathExists = existsSync(candidate.worktreePath)
    if (existingWorktreeDecision({ named, pathExists }) === 'reuse') {
      plan = candidate
      created = false
      break
    }
    let failure = pathExists
      ? `path already exists: ${candidate.worktreePath}`
      : null
    if (failure === null) {
      const add = spawnSync('git', ['-C', repoRoot, ...worktreeAddArgv(candidate)], { encoding: 'utf8' })
      if (add.error || add.status !== 0) {
        failure = (add.stderr ?? (add.error ? String(add.error) : '')).trim() || 'git worktree add failed'
      }
    }
    if (failure === null) {
      plan = candidate
      created = true
      break
    }
    if (slugRetryDecision({ named, attempt }) === 'fail') {
      console.error(`dsh-cc: could not create worktree "${candidate.slug}": ${failure}`)
      if (named) {
        console.error('dsh-cc: pick another name, or remove the stale one: '
          + `git -C ${repoRoot} worktree remove --force ${candidate.worktreePath}`)
      }
      process.exit(1)
    }
  }
  if (plan === null) {
    console.error('dsh-cc: could not allocate a worktree name after several attempts; try --worktree <name>.')
    process.exit(1)
  }
  Object.assign(env0, worktreeEnv(plan, repoRoot, head.stdout.trim()))
  spawnCwd = plan.worktreePath
  const verb = created ? 'created' : 'reusing'
  console.error(`dsh-cc: worktree "${plan.slug}" ${verb} at ${plan.worktreePath} (branch ${plan.branch})`)
  // A freshly created isolation worktree starts a fresh session (equivalent
  // to --new): the empty sentinel suppresses auto-resume. A reused worktree
  // leaves the env undefined, so the TUI auto-resumes the project's last
  // session (per the project model, main checkout and worktree share it).
  // interceptResume still lets an explicit --resume on argv win.
  if (created) env0.DSH_CC_RESUME_SESSION = ''
}

const { env, args } = interceptResume(undefined, worktree.args, env0)
env.NODE_ENV ??= 'production'
// Stamp the profile so the TUI plugin can surface it as ctx.get('dshProfile').
env.DSH_CC_PROFILE = PROFILE
// Default NODE_COMPILE_CACHE so the child reuses compiled modules across
// boots (see spawnEnv); a user-set value always wins.
const spawnEnvironment = spawnEnv(env, home)

const child = spawn('dsh', ['--profile', PROFILE, ...args], {
  env: spawnEnvironment,
  stdio: 'inherit',
  ...(spawnCwd === undefined ? {} : { cwd: spawnCwd }),
})
// ENOENT (dsh missing from PATH) never reaches the exit handler — handle it
// here with the same guidance as the bootstrap-install path.
child.on('error', (error) => {
  if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
    console.error(dshUnavailableMessage())
    process.exit(1)
  }
  throw error
})
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 0)
})
