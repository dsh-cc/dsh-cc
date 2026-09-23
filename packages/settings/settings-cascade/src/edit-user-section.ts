/**
 * Raw user-layer edit seam for the settings cascade. Unlike `persist()`, which
 * diffs a MERGED section against the shadow, this seam edits the user settings
 * file's OWN section for a namespace — the only safe path for removals, since
 * applying a merged section would smear higher-layer (project/local/flag/
 * policy) contributions into `~/.dsh/settings.json`. Writes are atomic with
 * optimistic re-read retry, mirroring `persistSection`; the edit callback is
 * re-applied to the freshly re-read root on retry because edits may be
 * non-idempotent. The caller republishes the re-merged document afterwards.
 * @module @dsh-cc/settings-cascade/edit-user-section
 */

import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { readUserText, writeJsonAtomic } from './persist.ts'

/**
 * Replace-or-skip edit over the raw user section. Receives the user file's own
 * section for the namespace (detached clone, `{}` when absent or non-object);
 * returns the replacement section, or `undefined` to skip the write entirely.
 */
export type UserSectionEdit = (rawSection: Record<string, unknown>) => Record<string, unknown> | undefined

/** Provider-provided seams: file location, loud parse, closed guard, republish. */
export interface UserSectionEditDeps {
  /** Absolute path of the user settings file. */
  path: string
  /** Parse a settings document, throwing loud on invalid JSON or a non-object root. */
  parse: (path: string, text: string) => Record<string, unknown>
  /** Closed guard: a queued edit after dispose is a no-op. */
  isClosed: () => boolean
  /** Republish the re-merged document after a successful write. */
  reload: () => Promise<void>
}

/** Optimistic-retry bound, mirroring the persist path. */
const MAX_EDIT_ATTEMPTS = 5

/** Whether a value is a plain data object (not an array, null, or instance). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Run one raw user-section edit with optimistic concurrency: the user-file
 * bytes are re-read immediately before the atomic rename, and when an external
 * writer changed them since the round's read, the whole round restarts from a
 * fresh read — re-applying the edit callback, which may be non-idempotent.
 * Bounded, then loud. `undefined` edits are no-ops; the reload runs only after
 * the write has durably succeeded.
 */
export async function runUserSectionEdit(
  deps: UserSectionEditDeps,
  ns: SettingsNamespace,
  edit: UserSectionEdit,
): Promise<void> {
  if (deps.isClosed()) return
  let lastError: unknown
  for (let attempt = 0; attempt < MAX_EDIT_ATTEMPTS; attempt++) {
    const before = await readUserText(deps.path)
    const root = deps.parse(deps.path, before ?? '')
    const raw = isPlainObject(root[ns]) ? root[ns] : {}
    const next = edit(structuredClone(raw))
    if (next === undefined) return
    if ((await readUserText(deps.path)) !== before) {
      lastError = new Error(`settings-cascade: user settings file at ${deps.path} changed concurrently during edit`)
      continue
    }
    await writeJsonAtomic(deps.path, { ...root, [ns]: next })
    await deps.reload()
    return
  }
  throw lastError ?? new Error(`settings-cascade: user-section edit at ${deps.path} exhausted ${MAX_EDIT_ATTEMPTS} optimistic-retry attempts`)
}
