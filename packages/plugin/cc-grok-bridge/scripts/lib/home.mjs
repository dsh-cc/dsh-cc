/**
 * Shadow-state primitives for the cc-grok-bridge launcher (§3.1 steps 5–6):
 * canonical per-cwd state home under a uid-suffixed canonical-tmpdir
 * subroot, fail-loud ownership/mode validation, a single-flight lock with
 * heartbeat (NO signal/exit handlers inside this module — the launcher owns
 * the lifecycle and receives a sync `release()`), the D14 allowlist sweep
 * (runs BEFORE the credential sync), the D19 nofollow atomic credential
 * sync of `auth.json` only, and the D10 child-env builder.
 */
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  realpathSync,
  utimesSync,
  writeFileSync,
  writeSync,
  fsyncSync,
} from 'node:fs'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

const LOCK_STALE_MS = 6 * 60 * 60 * 1000

/**
 * R = <canonical tmpdir>/grok-review-home-<uid>, H = R/sha256(realpath(cwd))
 * (canonicalize FIRST — macOS /var and /tmp are symlinks and every
 * path-boundary comparison is against canonical realpaths).
 */
export function homePaths({ cwd = process.cwd(), tmpdir = os.tmpdir() } = {}) {
  const tmp = realpathSync(tmpdir)
  const R = path.join(tmp, `grok-review-home-${process.getuid()}`)
  const H = path.join(
    R,
    createHash('sha256').update(realpathSync(cwd)).digest('hex').slice(0, 16),
  )
  return { tmp, R, H }
}

function assertOwnPrivateDir(dir, label) {
  const st = lstatSync(dir) // throws if missing → fail loud
  if (st.isSymbolicLink()) throw new Error(`${label} ${dir} is a symlink`)
  if (!st.isDirectory()) throw new Error(`${label} ${dir} is not a directory`)
  if (st.uid !== process.getuid()) throw new Error(`${label} ${dir} is not owned by the current uid`)
  if ((st.mode & 0o777) !== 0o700) throw new Error(`${label} ${dir} mode is not 0700`)
}

/**
 * Parent chain: only directories-that-are-not-symlinks are checked — a
 * root-owned /tmp is normal and must not fail.
 */
function assertPlainAncestor(dir) {
  const st = lstatSync(dir)
  if (st.isSymbolicLink()) throw new Error(`parent ${dir} is a symlink`)
  if (!st.isDirectory()) throw new Error(`parent ${dir} is not a directory`)
}

/** mkdir -m 0700 R and H, then lstat-validate both. */
export function prepareHome(opts = {}) {
  const { tmp, R, H } = homePaths(opts)
  let parent = path.dirname(R)
  while (parent !== path.dirname(parent)) {
    assertPlainAncestor(parent)
    parent = path.dirname(parent)
  }
  mkdirSync(R, { mode: 0o700, recursive: true })
  assertOwnPrivateDir(R, 'state subroot')
  mkdirSync(H, { mode: 0o700, recursive: true })
  assertOwnPrivateDir(H, 'workspace home')
  return { tmp, R, H }
}

/**
 * Acquire the single-flight lock `mkdir H/.lock`. Carries an owner nonce,
 * is heartbeat-touched while held, stale (>6h mtime) is reclaimed. This is
 * an accidental-concurrency guard for cooperative callers, NOT an
 * adversarial cost cap — a same-UID process can always delete it or run
 * grok directly. NO signal/exit handlers are wired here (D18): the
 * launcher registers its own lifecycle and calls the returned sync
 * `release()` in its finalize path.
 */
export function acquireLock(H) {
  const lockDir = path.join(H, '.lock')
  try {
    mkdirSync(lockDir, { mode: 0o700 })
  } catch {
    const st = lstatSync(lockDir)
    if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
      rmSync(lockDir, { recursive: true, force: true })
      mkdirSync(lockDir, { mode: 0o700 })
    } else {
      throw new Error(`another launch holds ${lockDir} (not stale)`)
    }
  }
  writeFileSync(path.join(lockDir, 'owner'), `${randomUUID()}\n`, { mode: 0o600 })
  const heartbeat = setInterval(() => {
    try {
      utimesSync(lockDir, new Date(), new Date())
    } catch {
      /* lock vanished underneath us — release will notice too */
    }
  }, 60_000)
  let released = false
  return () => {
    if (released) return
    released = true
    clearInterval(heartbeat)
    try {
      rmSync(lockDir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
}

/**
 * D14 allowlist sweep (probe P13): enumerate H's children; keep EXACTLY
 * `auth.json`, `sessions`, `.lock`; remove (recursive force) everything
 * else. Kept names are lstat-type-validated: `sessions` absent-or-real-dir,
 * `auth.json` absent-or-regular-file — symlink/foreign types are removed.
 * Any sweep failure is fail-closed (throws — the sweep is a security
 * control, not hygiene).
 */
export function sweepHome(H) {
  for (const name of readdirSync(H)) {
    if (name === '.lock') continue
    const p = path.join(H, name)
    if (name === 'auth.json' || name === 'sessions') {
      let st
      try {
        st = lstatSync(p)
      } catch {
        continue // vanished between readdir and lstat — nothing to sweep
      }
      const valid = name === 'sessions' ? st.isDirectory() : st.isFile()
      if (valid && !st.isSymbolicLink()) continue
    }
    rmSync(p, { recursive: true, force: true })
  }
}

/**
 * D19 credential sync inside the lock: ONLY `auth.json`, source
 * `os.homedir()/.grok/auth.json`. Source lstat regular-file → O_NOFOLLOW
 * open → fstat THAT fd for regular-file again → write H/.tmp-<random> 0600
 * → fsync → atomic rename (overwrite). Source errors in
 * {ENOENT, ENOTDIR, EACCES, EPERM} ⇒ missing/unreadable class: DELETE the
 * shadow copy and warn on stderr ONLY when ambient XAI_API_KEY is unset;
 * any other error aborts (throws).
 *
 * Source home is os.homedir() — POSIX honors $HOME, which is the test seam.
 */
const MISSING_CLASS = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'])

const fsIo = {
  lstatSync,
  openSync,
  fstatSync,
  readFileSync,
  writeSync,
  closeSync,
  fsyncSync,
  renameSync,
  rmSync,
}

/**
 * `io` injects the fs-level ops (unit-test seam: post-open fstat swap,
 * .tmp residue on rename failure); production default is the real fs.
 */
export function syncCredentials(H, { home = os.homedir(), env = process.env, warn = (m) => console.error(m), io = fsIo } = {}) {
  const src = path.join(home, '.grok', 'auth.json')
  const dst = path.join(H, 'auth.json')
  let st
  try {
    st = io.lstatSync(src)
  } catch (e) {
    if (MISSING_CLASS.has(e?.code)) {
      io.rmSync(dst, { force: true })
      if (!env.XAI_API_KEY) {
        warn(`grok-review: source ${src} missing/unreadable — removed shadow copy`)
      }
      return
    }
    throw e
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error(`source ${src} is not a regular file`)
  }
  // O_NOFOLLOW at open: even if src were swapped to a symlink between the
  // lstat above and here, the open itself refuses to follow it.
  const rfd = io.openSync(src, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    // Post-open fstat recheck on the SAME fd.
    if (!io.fstatSync(rfd).isFile()) throw new Error(`source ${src} is not a regular file`)
    const data = io.readFileSync(rfd)
    const tmpDst = path.join(H, `.tmp-${randomBytes(8).toString('hex')}`)
    const wfd = io.openSync(
      tmpDst,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    )
    try {
      io.writeSync(wfd, data)
      io.fsyncSync(wfd)
      io.renameSync(tmpDst, dst) // atomic, overwrite always
    } catch (e) {
      try {
        io.rmSync(tmpDst, { force: true })
      } catch {
        /* best-effort residue cleanup */
      }
      throw e
    } finally {
      io.closeSync(wfd)
    }
  } finally {
    io.closeSync(rfd)
  }
}

/**
 * D10 child env: pass the ambient env through with GROK_HOME pointed at the
 * shadow home, minus GROK_SESSION_ID / GROK_AGENT (session claims) and
 * GROK_SANDBOX (undefined profiles fail closed, probe P10). Pure helper —
 * never mutates the caller's env object.
 */
export function buildChildEnv(env, H) {
  const { GROK_SESSION_ID: _s, GROK_AGENT: _a, GROK_SANDBOX: _x, ...rest } = env
  return { ...rest, GROK_HOME: H }
}
