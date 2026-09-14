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
import { bootstrapCommand, BOOTSTRAP_STAMP, devStoreRestoreDecision, dshUnavailableMessage, existingWorktreeDecision, formatVersionLabel, healDecision, interceptResume, parseLocalConfig, parseWorktreeFlag, parseWorktreeRef, planWorktree, planWorktreeRef, prFetchRefs, readBootstrapVersion, remoteHost, PROFILE, readBuildInfo, repoRootFromCommonDir, runStoreHeal, runStoreRestore, sanitizeInheritedEnv, slugRetryDecision, spawnEnv, symlinkedPath, versionGate, worktreeAddArgv, worktreeEnv, worktreeIdentityRefusal, writeBootstrapStamp } from '../bootstrap.mjs'
import { readWorktreeSettings, resolveBaseRef, sweepWorktrees, SWEEP_CAP_MS, worktreeReuseReset, worktreeSettingsPaths } from '../worktree-lifecycle.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const ownVersion = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version

const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const profileDir = join(home, 'profiles', PROFILE)
// Dev-build stamp lives with the synced profile code (see
// scripts/stamp-build-info.mjs); read once per launch, sub-millisecond, no
// subprocess (W2 law). Missing/malformed -> null, fail-open to release.
const stampPath = join(profileDir, 'node_modules', '@dsh-cc', 'dsh-cc-build.json')
const buildInfo = readBuildInfo(stampPath)

if (process.argv.includes('--version') || process.argv.includes('-V')) {
  console.log(formatVersionLabel(ownVersion, buildInfo))
  process.exit(0)
}
const profileExisted = existsSync(join(profileDir, 'package.json'))
const add = bootstrapCommand(profileExisted, ownVersion)
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
  // First install of this launcher version: record it so later launches can
  // tell "converged" from "installed before the heal mechanism existed".
  writeBootstrapStamp(join(profileDir, BOOTSTRAP_STAMP), ownVersion)
}

// A dev-synced profile paired with a DIFFERENT launcher version converges
// back to store bundles before the session starts (plan 2026-09-13 §3.4).
// A fresh profile has no stamp, so this can never fire on the bootstrap path.
// A successful restore IS this version's install: stamp afterwards.
const restorePlan = devStoreRestoreDecision(buildInfo, ownVersion)
if (restorePlan !== null) {
  const restored = runStoreRestore(profileDir, ownVersion)
  if (restored.restored) writeBootstrapStamp(join(profileDir, BOOTSTRAP_STAMP), ownVersion)
} else {
  // A pre-existing store profile converges to this launcher's version on
  // version change (or on a missing stamp — installs made before the heal
  // existed, including every 0.7.0-broken profile). Never fires on a
  // dev-synced profile (that pairing belongs to the restore path) nor on a
  // launch that just bootstrapped.
  const heal = healDecision({
    profileExists: profileExisted && add === undefined,
    stampVersion: readBootstrapVersion(join(profileDir, BOOTSTRAP_STAMP)),
    ownVersion,
    buildInfo,
  })
  if (heal !== null) runStoreHeal(profileDir, ownVersion, { from: heal.from })
}

// A parent dsh-cc TUI process leaks DSH_CC_RESUME_SESSION / DSH_CC_AUTO_RESUME
// / DSH_CC_CONTINUE into a child launcher's environment. Strip them up front —
// before any flag is parsed — so the three are re-derived only from THIS
// invocation's argv (see sanitizeInheritedEnv). In particular an inherited
// DSH_CC_AUTO_RESUME=1 would otherwise defeat an explicit --new / --worktree.
const env0 = sanitizeInheritedEnv({ ...process.env })

// WS-4 boot-time sweep: remove long-orphaned dsh-cc worktrees and REPORT
// stale dsh-cc session locks (locks are never auto-released — no
// trustworthy cross-process liveness oracle). Runs on every launch whether
// or not this launch is a --worktree session, never does network I/O, is
// bounded by the 10s cap, and degrades to a silent no-op on any failure —
// launch must never block on the sweep.
try {
  const sweepCommon = spawnSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8', timeout: 2000 })
  const sweepRoot = sweepCommon.status === 0 ? repoRootFromCommonDir(process.cwd(), sweepCommon.stdout) : undefined
  if (sweepRoot !== undefined && existsSync(sweepRoot)) {
    const sweepSettings = readWorktreeSettings(worktreeSettingsPaths({ home, projectRoot: sweepRoot }))
    const swept = sweepWorktrees({
      repoRoot: sweepRoot,
      cleanupPeriodDays: sweepSettings.cleanupPeriodDays,
      git: (argv, opts) => spawnSync('git', argv, {
        encoding: 'utf8',
        ...(opts?.timeoutMs ? { timeout: opts.timeoutMs } : {}),
        ...(opts?.cwd ? { cwd: opts.cwd } : {}),
      }),
      onAdvisory: line => console.error(line),
      deadline: SWEEP_CAP_MS,
    })
    if (swept.removed.length > 0) {
      console.error(`dsh-cc: swept ${swept.removed.length} stale worktree(s) older than ${sweepSettings.cleanupPeriodDays} days`)
    }
  }
} catch {
  // Sweep failures never block launch.
}

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
  // WS-1 root pinning: anchor at the git common dir so a session launched
  // from inside a linked worktree still creates a SIBLING under the main
  // root's .claude/worktrees/, never a nested tree.
  const common = spawnSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' })
  if (common.error || common.status !== 0) {
    console.error('dsh-cc: --worktree requires a git repository (run from inside a git working tree).')
    process.exit(1)
  }
  const repoRoot = repoRootFromCommonDir(process.cwd(), common.stdout)
  if (repoRoot === undefined || !existsSync(repoRoot)) {
    console.error('dsh-cc: --worktree requires a git repository (could not locate the main checkout).')
    process.exit(1)
  }
  // WS-1: neutralize repository-local filter drivers — read the local config
  // up front and refuse on unreadable config or CC-parity refusal shapes.
  const localConfig = spawnSync('git', ['-C', repoRoot, 'config', '--local', '--list', '-z'], { encoding: 'utf8' })
  if (localConfig.error || localConfig.status !== 0) {
    console.error('dsh-cc: refusing to create a worktree: repository local config is unreadable.')
    process.exit(1)
  }
  const configScan = parseLocalConfig(localConfig.stdout)
  if (configScan.refusals.length > 0) {
    console.error(`dsh-cc: refusing to create a worktree: ${configScan.refusals.join('; ')}`)
    process.exit(1)
  }
  // Drop stale registrations left by crashed sessions before planning paths.
  spawnSync('git', ['-C', repoRoot, 'worktree', 'prune'], { encoding: 'utf8' })
  const head = spawnSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
  if (head.error || head.status !== 0) {
    console.error('dsh-cc: could not resolve HEAD; is this a repository without commits?')
    process.exit(1)
  }
  // WS-4: read the `worktree` settings subset (user → project → local,
  // fail-open) and resolve the creation base. The refresh fetch (when the
  // cached origin/HEAD is older than 24h) is capped at 5s and happens on
  // the creation path only.
  const wtSettings = readWorktreeSettings(worktreeSettingsPaths({ home, projectRoot: repoRoot }))
  const base = await resolveBaseRef(
    (argv, opts) => spawnSync('git', argv, {
      encoding: 'utf8',
      cwd: repoRoot,
      ...(opts?.timeoutMs ? { timeout: opts.timeoutMs } : {}),
    }),
    wtSettings.baseRef,
  )
  const baseHead = base === 'HEAD'
    ? head.stdout.trim()
    : (spawnSync('git', ['-C', repoRoot, 'rev-parse', base], { encoding: 'utf8' }).stdout.trim() || head.stdout.trim())
  // WS-6 item 3: PR references (`#<n>`, GitHub PR / GitLab MR URLs) are
  // parsed BEFORE any slug validation; the fetched head becomes the base.
  // Pre-build limitation: no hooks run on this path (documented deviation).
  const pr = parseWorktreeRef(worktree.name)
  let prBase = null
  if (pr !== undefined) {
    let host = pr.host
    if (host === undefined) {
      const url = spawnSync('git', ['-C', repoRoot, 'remote', 'get-url', 'origin'], { encoding: 'utf8' })
      host = url.status === 0 ? remoteHost(url.stdout) : undefined
    }
    const refs = prFetchRefs(host, pr.pr)
    let fetched = null
    for (const ref of refs) {
      const f = spawnSync('git', ['-C', repoRoot, 'fetch', 'origin', ref], { encoding: 'utf8', timeout: 5000 })
      if (!f.error && f.status === 0) { fetched = ref; break }
    }
    if (fetched === null) {
      console.error(`dsh-cc: could not resolve PR ${pr.pr} from origin (tried ${refs.join(', ')}). Check the reference, the remote, and your network.`)
      process.exit(1)
    }
    prBase = spawnSync('git', ['-C', repoRoot, 'rev-parse', 'FETCH_HEAD'], { encoding: 'utf8' }).stdout.trim() || null
    if (prBase === null) {
      console.error(`dsh-cc: fetched ${fetched} but could not resolve FETCH_HEAD.`)
      process.exit(1)
    }
  }
  const createBase = prBase ?? base
  // WS-4: `git worktree lock --reason="dsh-cc session <slug>"` at managed
  // session start (created OR reused). Pre-2.15 git without `worktree
  // lock` is a tolerated no-op with a one-line warn.
  const lockWorktreeSession = (slug, path) => {
    const lock = spawnSync('git', ['-C', repoRoot, 'worktree', 'lock', `--reason=dsh-cc session ${slug}`, path], { encoding: 'utf8' })
    if (lock.status !== 0) {
      if (/unknown option|unknown switch/i.test(lock.stderr ?? '')) {
        console.error(`dsh-cc: git worktree lock unsupported by this git version; ${path} left unlocked`)
      } else {
        console.error(`dsh-cc: could not lock worktree ${path}: ${(lock.stderr ?? '').trim()}`)
      }
    }
  }
  // A PR reference is user-pinned: the /quit overlay treats it as named.
  const named = worktree.name !== null || pr !== undefined
  let plan = null
  let created = false
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    let candidate
    try {
      candidate = pr !== undefined ? planWorktreeRef(repoRoot, pr.pr) : planWorktree(repoRoot, worktree.name)
    } catch (error) {
      console.error(`dsh-cc: ${error.message}`)
      process.exit(1)
    }
    // WS-1 symlink refusal on the creation route (CC v2.1.212 parity).
    const symlink = symlinkedPath([join(repoRoot, '.claude'), join(repoRoot, '.claude', 'worktrees'), candidate.worktreePath])
    if (symlink !== null) {
      console.error(`dsh-cc: refusing to create a worktree: a creation path is a symlink: ${symlink}`)
      process.exit(1)
    }
    const pathExists = existsSync(candidate.worktreePath)
    if (existingWorktreeDecision({ named, pathExists }) === 'reuse') {
      // WS-1 adoption gate: verify the existing directory's git identity
      // before handing it over (leave the directory in place on refusal).
      const refusal = worktreeIdentityRefusal(candidate.worktreePath, repoRoot)
      if (refusal !== null) {
        console.error(`dsh-cc: ${refusal}`)
        process.exit(1)
      }
      // WS-4 merged-reset rule: when the reused tree is clean, still on its
      // worktree-* branch, and its own commits are all reachable from the
      // resolved fresh base, hard-reset it to the base before handover;
      // otherwise (or when any probe is unverifiable) continue at the old
      // tip. `source: 'name'` keeps the WS-6 PR-reuse skip open.
      const reset = worktreeReuseReset({
        plan: candidate,
        repoRoot,
        freshBase: base,
        source: pr !== undefined ? 'pr' : 'name',
        git: (argv, opts) => spawnSync('git', argv, {
          encoding: 'utf8',
          ...(opts?.timeoutMs ? { timeout: opts.timeoutMs } : {}),
          ...(opts?.cwd ? { cwd: opts.cwd } : {}),
        }),
      })
      if (reset.action === 'reset') {
        console.error(`dsh-cc: reset reused worktree "${candidate.slug}" to ${base}`)
      }
      plan = candidate
      created = false
      break
    }
    let failure = pathExists
      ? `path already exists: ${candidate.worktreePath}`
      : null
    if (failure === null) {
      const add = spawnSync('git', ['-C', repoRoot, ...worktreeAddArgv(candidate, configScan.filters, createBase)], { encoding: 'utf8' })
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
  lockWorktreeSession(plan.slug, plan.worktreePath)
  Object.assign(env0, worktreeEnv(plan, repoRoot, prBase ?? baseHead, named))
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
