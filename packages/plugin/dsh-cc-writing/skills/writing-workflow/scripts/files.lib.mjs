/**
 * Workspace paths, content-addressed snapshots, JSON conventions, atomic
 * writes, and the per-run lock (plan §5, §6).
 *
 * The CLI maps error codes to exit codes. Every failure is a CliError; read
 * failures are IO_ERROR and path/schema problems are INVALID_INPUT or
 * PATH_OUTSIDE_WORKSPACE.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { basename, dirname, isAbsolute, join, sep } from 'node:path'

export class CliError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.code = code
    this.details = details
  }
}

export function fail(code, message, details = {}) {
  throw new CliError(code, message, details)
}

// ------------------------------------------------------------------ hashing

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export const EMPTY_HASH = sha256(Buffer.alloc(0))

export function decodeUtf8(bytes, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    fail('INVALID_INPUT', `${label}: not valid UTF-8`)
  }
}

// -------------------------------------------------------------- workspaces

/** Canonical workspace root; the caller's realpath (plan §5.1). */
export function workspaceRoot(path) {
  if (typeof path !== 'string' || path.length === 0) fail('INVALID_INPUT', 'workspace: expected a directory path')
  let real
  try {
    real = realpathSync(path)
  } catch {
    fail('INVALID_INPUT', 'workspace: directory does not exist')
  }
  let stat
  try {
    stat = statSync(real)
  } catch {
    fail('IO_ERROR', 'workspace: cannot stat directory')
  }
  if (!stat.isDirectory()) fail('INVALID_INPUT', 'workspace: expected a directory')
  return real
}

function realpathOfExistingPrefix(abs) {
  let current = abs
  const tail = []
  for (;;) {
    try {
      const real = realpathSync(current)
      return tail.length === 0 ? real : join(real, ...tail)
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
      const parent = dirname(current)
      if (parent === current) return abs
      tail.unshift(basename(current))
      current = parent
    }
  }
}

function isAbsolutePath(value) {
  return isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

/**
 * Resolve a workspace-relative POSIX path, rejecting absolute paths, NUL,
 * `..`, and realpath escapes including ancestors of new files (plan §5.1).
 *
 * @returns {{abs:string, rel:string}} with a normalized POSIX relative path.
 */
export function resolveWorkspacePath(root, rel, label = 'path') {
  if (typeof rel !== 'string' || rel.length === 0) fail('INVALID_INPUT', `${label}: expected a nonempty string`)
  if (rel.includes('\0')) fail('INVALID_INPUT', `${label}: NUL bytes are not allowed`)
  if (isAbsolutePath(rel)) fail('PATH_OUTSIDE_WORKSPACE', `${label}: absolute paths are not allowed`, { path: rel })
  const parts = rel.split('/')
  if (parts.includes('..')) fail('PATH_OUTSIDE_WORKSPACE', `${label}: ".." segments are not allowed`, { path: rel })
  const clean = parts.filter((part) => part !== '' && part !== '.')
  if (clean.length === 0) fail('INVALID_INPUT', `${label}: expected a file or directory path`)
  const abs = join(root, ...clean)
  let real
  try {
    real = realpathOfExistingPrefix(abs)
  } catch {
    fail('IO_ERROR', `${label}: cannot resolve path`)
  }
  if (real !== root && !real.startsWith(root + sep)) {
    fail('PATH_OUTSIDE_WORKSPACE', `${label}: path escapes the workspace`, { path: rel })
  }
  return { abs, rel: clean.join('/') }
}

/** Caller-supplied input file: absolute paths must resolve inside the workspace. */
export function resolveInputFile(root, value) {
  if (typeof value !== 'string' || value.length === 0) fail('INVALID_INPUT', 'input: expected a file path')
  if (value.includes('\0')) fail('INVALID_INPUT', 'input: NUL bytes are not allowed')
  if (!isAbsolutePath(value)) return resolveWorkspacePath(root, value, 'input').abs
  let real
  try {
    real = realpathSync(value)
  } catch {
    fail('INVALID_INPUT', 'input: file does not exist')
  }
  if (real !== root && !real.startsWith(root + sep)) {
    fail('PATH_OUTSIDE_WORKSPACE', 'input: path escapes the workspace')
  }
  return real
}

// ------------------------------------------------------------- file access

export function readBytes(abs, label) {
  try {
    return readFileSync(abs)
  } catch (error) {
    if (error.code === 'ENOENT') fail('PREREQUISITE_MISSING', `${label}: file does not exist`)
    fail('IO_ERROR', `${label}: cannot read file`)
  }
}

export function readUtf8File(abs, label) {
  return decodeUtf8(readBytes(abs, label), label)
}

export function readJsonFile(abs, label) {
  const text = decodeUtf8(readBytes(abs, label), label)
  try {
    return JSON.parse(text)
  } catch {
    fail('INVALID_INPUT', `${label}: not valid JSON`)
  }
}

export function readJsonIfExists(abs, label) {
  if (!existsSync(abs)) return null
  return readJsonFile(abs, label)
}

/** JSON files use LF, two-space indentation, and a final newline (plan §5.1). */
export function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export function writeJsonAtomic(abs, value) {
  atomicWrite(abs, jsonBytes(value))
}

/** Same-directory temporary file plus rename; no partial destination file. */
export function atomicWrite(abs, bytes) {
  const dir = dirname(abs)
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    fail('IO_ERROR', 'cannot create target directory')
  }
  const tmp = join(dir, `.${basename(abs)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    writeFileSync(tmp, bytes)
    renameSync(tmp, abs)
  } catch {
    try {
      unlinkSync(tmp)
    } catch {
      /* best effort: the temporary file may not exist */
    }
    fail('IO_ERROR', 'atomic write failed')
  }
}

// -------------------------------------------------------------- snapshots

export function snapshotRel(runRel, hash) {
  return `${runRel}/snapshots/${hash}.md`
}

export function snapshotAbs(runAbs, hash) {
  return join(runAbs, 'snapshots', `${hash}.md`)
}

/** Content-addressed byte snapshot; returns {hash, path} (workspace-relative). */
export function writeSnapshot(runAbs, runRel, bytes) {
  const hash = sha256(bytes)
  const abs = snapshotAbs(runAbs, hash)
  if (existsSync(abs)) {
    if (!readFileSync(abs).equals(bytes)) fail('IO_ERROR', 'stored snapshot does not match its content hash')
  } else {
    atomicWrite(abs, bytes)
  }
  return { hash, path: snapshotRel(runRel, hash) }
}

/** Snapshot bytes for a recorded hash, or null when the snapshot is absent. */
export function readSnapshot(runAbs, hash) {
  const abs = snapshotAbs(runAbs, hash)
  if (!existsSync(abs)) return null
  return readFileSync(abs)
}

// ------------------------------------------------------------------- lock

/** Exclusive create at <run>/lock; a foreign or dead lock is never removed. */
export function acquireLock(runAbs) {
  const lockAbs = join(runAbs, 'lock')
  let fd
  try {
    fd = openSync(lockAbs, 'wx')
  } catch (error) {
    if (error.code === 'EEXIST') {
      fail('LOCKED', 'run is locked by another writer', { lockPath: lockAbs })
    }
    fail('IO_ERROR', 'cannot create run lock')
  }
  try {
    writeSync(fd, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`)
  } catch {
    try {
      closeSync(fd)
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(lockAbs)
    } catch {
      /* ignore */
    }
    fail('IO_ERROR', 'cannot write run lock')
  }
  closeSync(fd)
  return () => {
    try {
      unlinkSync(lockAbs)
    } catch {
      /* owner best effort: the lock may already be gone */
    }
  }
}

/** Run `fn` under the per-run lock; the owner unlinks on every exit (plan §6). */
export function withLock(runAbs, fn) {
  const release = acquireLock(runAbs)
  try {
    return fn()
  } finally {
    release()
  }
}
