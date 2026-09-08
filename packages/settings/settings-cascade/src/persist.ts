/**
 * Surgical-delta persistence for the settings cascade. When a write reaches
 * the provider it carries the full merged section for one namespace; writing
 * that whole section into the user settings file would smear higher-layer
 * (project/local/flag/policy) contributions into the user layer. Instead the
 * section is diffed against the last-published shadow and only the leaf-level
 * change ops are applied onto the user file's own section. File writes are
 * atomic (temp + rename) so a crash never leaves a half-written document.
 * @module @dsh-cc/settings-cascade/persist
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'

/** One leaf-level change to a JSON section, mirroring the seam's path ops. */
export type JsonOp =
  | { op: 'set'; path: string[]; value: unknown }
  | { op: 'unset'; path: string[] }

/** Whether a value is a plain data object (not an array, null, or instance). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Deep value equality, stable across JSON-shaped leaves (objects recurse). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a)
    const bKeys = Object.keys(b)
    if (aKeys.length !== bKeys.length) return false
    return aKeys.every(key => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]))
  }
  return false
}

/**
 * Diff two JSON sections into leaf-level ops. Leaves equal by deep value
 * equality produce no op; changed or added leaves produce `set`; keys present
 * in `prev` but absent in `next` produce `unset`. Arrays compare as whole
 * leaves. When both sides are plain objects the diff recurses; when one side
 * is not a plain object while the other is, the node is replaced wholesale.
 * Neither input is mutated.
 * @param prev - the earlier section (the shadow of what was published before).
 * @param next - the desired section (the merged write target).
 * @param path - the JSON path accumulated so far; defaults to the root `[]`.
 * @returns the ordered ops that transform `prev` into `next`.
 */
export function diffSections(prev: unknown, next: unknown, path: string[] = []): JsonOp[] {
  if (isPlainObject(prev) && isPlainObject(next)) {
    const ops: JsonOp[] = []
    for (const [key, value] of Object.entries(next)) {
      if (Object.prototype.hasOwnProperty.call(prev, key)) {
        ops.push(...diffSections(prev[key], value, [...path, key]))
      } else {
        ops.push({ op: 'set', path: [...path, key], value })
      }
    }
    for (const key of Object.keys(prev)) {
      if (!Object.prototype.hasOwnProperty.call(next, key)) {
        ops.push({ op: 'unset', path: [...path, key] })
      }
    }
    return ops
  }
  if (deepEqual(prev, next)) return []
  return [{ op: 'set', path, value: next }]
}

/**
 * Apply a list of ops onto a detached JSON section, returning the next
 * section. Mirrors the seam's `applyPathOp`: a nested `set` that meets a
 * non-plain-object intermediate node replaces that node wholesale with an
 * object built around the remaining path; `unset` on a missing key is a
 * no-op; a `set` with an empty path requires a plain object and replaces the
 * whole section; an `unset` with an empty path yields `{}`. The input is not
 * mutated.
 * @param section - the current section (`undefined` when the namespace is absent).
 * @param ops - the ops to apply in order.
 * @returns the resulting section.
 */
export function applyOpsToSection(section: unknown, ops: JsonOp[]): unknown {
  let out: unknown = section
  for (const op of ops) {
    out = applyPathOp(out, op)
  }
  return out
}

/** Apply one path op to a detached section, returning the next section. */
function applyPathOp(section: unknown, op: JsonOp): unknown {
  const [head, ...rest] = op.path
  if (head === undefined) {
    if (op.op === 'unset') return {}
    if (!isPlainObject(op.value)) throw new TypeError('settings-cascade: setting the section root requires a plain object')
    return { ...op.value }
  }
  if (rest.length === 0) {
    const base = isPlainObject(section) ? section : {}
    if (op.op === 'set') return { ...base, [head]: op.value }
    if (!isPlainObject(section)) return section
    const { [head]: _removed, ...kept } = section
    return kept
  }
  const child = isPlainObject(section) ? section[head] : undefined
  if (!isPlainObject(child)) {
    if (op.op === 'unset') return section
    return {
      ...(isPlainObject(section) ? section : {}),
      [head]: applyPathOp({}, restOp(op, rest)),
    }
  }
  const base = isPlainObject(section) ? section : {}
  return {
    ...base,
    [head]: applyPathOp(child, restOp(op, rest)),
  }
}

/** Rebuild an op focused on the remaining path of a nested traversal. */
function restOp(op: JsonOp, path: string[]): JsonOp {
  if (op.op === 'set') return { op: 'set', path, value: op.value }
  return { op: 'unset', path }
}

/** Whether a filesystem error simply means the file is absent. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * Read one settings document into a plain object. Absence and whitespace-only
 * content read as `{}`; invalid JSON or a non-object root fail loud with the
 * path, mirroring the cascade provider's load-time parse.
 * @param path - the absolute settings file path.
 * @returns the parsed root document, or `{}` when the file is absent or blank.
 */
/** Raw user-file text, or `undefined` when the file is absent. */
export async function readUserText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (isENOENT(error)) return undefined
    throw error
  }
}

export async function readUserFile(path: string): Promise<Record<string, unknown>> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (isENOENT(error)) return {}
    throw error
  }
  if (text.trim().length === 0) return {}
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch (error) {
    throw new Error(`settings-cascade: invalid settings document at ${path}: ${(error as Error).message}`, { cause: error })
  }
  if (!isPlainObject(root)) {
    throw new TypeError(`settings-cascade: ${path} must be a JSON object of namespace sections`)
  }
  return root
}

/**
 * Write a JSON root document atomically. The parent directory is created with
 * mode `0o700`, the document is written to a random temp sibling under mode
 * `0o600`, then renamed over the target. On any failure after the temp file is
 * created it is best-effort removed before the error rethrows. The temp name
 * is random (rather than fixed) so concurrent writers never collide on it.
 * @param path - the absolute target settings file path.
 * @param root - the plain-object document to serialize.
 */
export async function writeJsonAtomic(path: string, root: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(root, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}
