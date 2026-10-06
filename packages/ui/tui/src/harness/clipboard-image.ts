/**
 * The `onPasteImage` provider the TUI host injects into the editor: read an
 * image off the OS pasteboard, spill it to a per-session cache dir, hand back a
 * handle. Platform readers live in `clipboard-readers.ts`; this module owns
 * selection, validation, the spill, and the single silent failure path.
 *
 * Why spill at paste time instead of holding bytes or reading at submit: the
 * marker has to stay honest. Paste two images, or copy something else in
 * between, and a deferred read attaches the wrong bytes to the marker. It also
 * keeps composer memory bounded.
 *
 * Failure is silent by requirement (plan §3.6). Unsupported platform, no reader
 * binary, pasteboard holding no image, a helper that failed, bytes that are not
 * an image, an unwritable cache dir: all of them return `undefined` and log
 * nothing, which is exactly what an unsupported paste did before this feature
 * existed. Nothing in this module throws to its caller.
 *
 * @module @dsh-cc/tui/harness/clipboard-image
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { imageDimensions, sniffImageMediaType, type ImageMediaType } from './image-bytes.ts'
import {
  defaultClipboardExec,
  readClipboardBytes,
  selectClipboardReaders,
  type ClipboardExec,
} from './clipboard-readers.ts'

/**
 * `PastedImage` is pi-tui's own type, imported rather than redeclared. It was
 * declared locally while the barrel re-export was still pending; now that
 * `@dsh-cc/pi-tui` exports it, a second declaration here would be a type that
 * silently drifts from the option it is assigned to. The package still must not
 * deep-import another package's `src/`, so the barrel is the only legal route.
 *
 * Import AND re-export: `export type { X } from` routes the name past this
 * module without binding it, so the local uses below would not resolve.
 */
import type { PastedImage } from '@dsh-cc/pi-tui'
export type { PastedImage }

export interface ClipboardImageOptions {
  /**
   * The `tui` data dir; defaults to `$DSH_HOME/tui` (or `~/.dsh/tui`), the
   * same resolution as the composer history and the `/export-md` dir. Spills
   * land in its `uploads/` subdir.
   */
  dir?: string
  /**
   * Session id for the upload bucket, read lazily because it changes: a
   * `/resume` rebinds the session, and a cached value would file later pastes
   * under the previous session.
   */
  getSessionId?: () => string | undefined
  /** Defaults to `process.platform`; injectable for tests. */
  platform?: NodeJS.Platform
  /** Defaults to `process.env` (the Linux Wayland/X11 choice reads it). */
  env?: NodeJS.ProcessEnv
  /** Defaults to the real spawn; injectable so no test touches a clipboard. */
  exec?: ClipboardExec
}

/** Cache-file extension per media type (`image/jpeg` -> `.jpg`, as Claude Code uses). */
const EXTENSION: Record<ImageMediaType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/**
 * The `tui` data dir: an injected `dir` wins, otherwise `$DSH_HOME/tui` or
 * `~/.dsh/tui`, mirroring the other TUI data-dir resolutions.
 */
function dataDir(dir?: string): string {
  if (dir !== undefined) return dir
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(dshHome, 'tui')
}

/**
 * Session ids arrive from the driver and are used as a path segment, so keep
 * only characters that cannot traverse: a session id is a uuid in practice, and
 * anything else that survives the filter is harmless. `..`-only input falls
 * back to a shared bucket rather than reaching the parent directory.
 */
function sessionSegment(sessionId: string | undefined): string {
  const cleaned = (sessionId ?? '').replace(/[^A-Za-z0-9._-]/g, '')
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return 'session'
  return cleaned
}

/** `<dataDir>/uploads/<sessionId>` - the per-session bucket for pasted images. */
export function clipboardUploadDir(sessionId: string | undefined, dir?: string): string {
  return join(dataDir(dir), 'uploads', sessionSegment(sessionId))
}

/**
 * Content-addressed path for `bytes`. Hashing the bytes (not the name, not the
 * paste ordinal) is what makes re-pasting the same screenshot a no-op instead
 * of a duplicate file, and what keeps two markers for one image pointing at one
 * path.
 */
export function clipboardUploadPath(
  bytes: Uint8Array,
  mediaType: ImageMediaType,
  sessionId: string | undefined,
  dir?: string,
): string {
  const digest = createHash('sha256').update(bytes).digest('hex')
  return join(clipboardUploadDir(sessionId, dir), `${digest}-image.${EXTENSION[mediaType]}`)
}

/**
 * Write `bytes` to its content-addressed path and return that path, or
 * `undefined` when it could not be written.
 *
 * Mode 0o600: a pasteboard can hold a password-manager screenshot or any other
 * private pixel, and this file outlives the session that spilled it. An
 * existing file is left untouched (same bytes by construction) so the write is
 * idempotent and a re-paste does not churn the cache.
 *
 * Written in place rather than to a temp file plus rename: the path is
 * content-addressed, so a torn write can never be mistaken for a complete image
 * under another name, and no reader can reach this path before this call
 * returns - the marker that refers to it is inserted afterwards. */
export function spillClipboardImage(
  bytes: Uint8Array,
  mediaType: ImageMediaType,
  sessionId: string | undefined,
  dir?: string,
): string | undefined {
  const path = clipboardUploadPath(bytes, mediaType, sessionId, dir)
  try {
    if (existsSync(path)) return path
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, bytes, { mode: 0o600 })
    return path
  } catch {
    return undefined
  }
}

/**
 * Build the `onPasteImage` provider. The returned function never rejects: the
 * editor treats a rejection as "no image", so a rejected promise would only
 * lose the distinction without changing the outcome.
 */
export function createClipboardImageProvider(
  opts: ClipboardImageOptions = {},
): () => Promise<PastedImage | undefined> {
  return async () => {
    try {
      const readers = selectClipboardReaders(opts.platform ?? process.platform, opts.env ?? process.env)
      const bytes = await readClipboardBytes(readers, opts.exec ?? defaultClipboardExec)
      if (bytes === undefined) return undefined
      // Sniff rather than trust the reader: a helper can exit 0 having written
      // an error message, or a text clipboard's contents.
      const mediaType = sniffImageMediaType(bytes)
      if (mediaType === undefined) return undefined
      const path = spillClipboardImage(bytes, mediaType, opts.getSessionId?.(), opts.dir)
      if (path === undefined) return undefined
      return { path, mediaType, ...imageDimensions(bytes, mediaType) }
    } catch {
      return undefined
    }
  }
}

/** One-shot form of {@link createClipboardImageProvider}, for callers that paste once. */
export function readClipboardImage(opts: ClipboardImageOptions = {}): Promise<PastedImage | undefined> {
  return createClipboardImageProvider(opts)()
}
