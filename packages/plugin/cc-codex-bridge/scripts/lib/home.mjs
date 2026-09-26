/**
 * §3.1 steps 1–4 for the codex-rescue-bridge launcher: canonical per-cwd
 * state home under a uid-suffixed canonical-tmpdir subroot, fail-loud
 * ownership/mode validation, single-flight lock with heartbeat + signal
 * release, and nofollow atomic credential sync.
 */
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
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
 * R = <canonical tmpdir>/codex-rescue-home-<uid>, H = R/sha256(realpath(cwd))
 * (§3.1 step 1: canonicalize FIRST — macOS /var and /tmp are symlinks and
 * every path-boundary comparison is against canonical realpaths).
 */
export function homePaths({ cwd = process.cwd(), tmpdir = os.tmpdir() } = {}) {
  const tmp = realpathSync(tmpdir)
  const R = path.join(tmp, `codex-rescue-home-${process.getuid()}`)
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
 * root-owned /tmp is normal and must not fail (§3.1 step 2).
 */
function assertPlainAncestor(dir) {
  const st = lstatSync(dir)
  if (st.isSymbolicLink()) throw new Error(`parent ${dir} is a symlink`)
  if (!st.isDirectory()) throw new Error(`parent ${dir} is not a directory`)
}

/** mkdir -m 0700 R and H, then lstat-validate both (§3.1 step 2). */
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
 * Acquire the single-flight lock `mkdir H/.lock` (§3.1 step 3). Carries an
 * owner nonce, is heartbeat-touched while held, stale (>6h mtime) is
 * reclaimed. ponytail/best-effort note (per §4): this is an
 * accidental-concurrency guard for cooperative callers, NOT an adversarial
 * cost cap — a same-UID process can always delete it or run codex directly.
 * Returns the release function; call it in `finally` (the launcher also
 * wires signal handlers through it).
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
  const sweep = () => {
    try {
      rmSync(lockDir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
  const onSignal = () => {
    release()
    process.exit(1)
  }
  const onExit = () => sweep()
  const release = () => {
    clearInterval(heartbeat)
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(sig, onSignal)
    process.off('exit', onExit)
    sweep()
  }
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, onSignal)
  process.on('exit', onExit)
  return release
}

/**
 * Credential sync inside the lock (§3.1 step 4): read auth.json/config.toml
 * with O_NOFOLLOW after source lstat (regular file), write to H/.tmp-<random>
 * mode 0600, fsync, atomic rename, overwrite always. A missing/unreadable
 * source DELETES the H copy and warns on stderr (a revoked token must not
 * live on in the shadow home); any other sync failure throws (abort launch).
 *
 * Source home is os.homedir() — POSIX honors $HOME, which is the test seam
 * (specs point HOME at a fake home; the real ~/.codex is never touched).
 */
export function syncCredentials(H, { home = os.homedir(), warn = (m) => console.error(m) } = {}) {
  const srcDir = path.join(home, '.codex')
  for (const name of ['auth.json', 'config.toml']) {
    const src = path.join(srcDir, name)
    const dst = path.join(H, name)
    let st
    try {
      st = lstatSync(src)
    } catch {
      rmSync(dst, { force: true })
      warn(`codex-rescue: source ${src} missing/unreadable — removed shadow copy`)
      continue
    }
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new Error(`source ${src} is not a regular file`)
    }
    // O_NOFOLLOW at open: even if src were swapped to a symlink between the
    // lstat above and here, the open itself refuses to follow it.
    const rfd = openSync(src, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    try {
      if (!fstatSync(rfd).isFile()) throw new Error(`source ${src} is not a regular file`)
      const data = readFileSync(rfd)
      const tmpDst = path.join(H, `.tmp-${randomBytes(8).toString('hex')}`)
      const wfd = openSync(
        tmpDst,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600,
      )
      try {
        writeSync(wfd, data)
        fsyncSync(wfd)
      } finally {
        closeSync(wfd)
      }
      renameSync(tmpDst, dst) // atomic, overwrite always
    } finally {
      closeSync(rfd)
    }
  }
}
