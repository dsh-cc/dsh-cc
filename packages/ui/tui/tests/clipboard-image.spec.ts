import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { imageDimensions, sniffImageMediaType } from '@dsh-cc/tui/harness/image-bytes.ts'
import {
  CLIPBOARD_MAX_BYTES,
  defaultClipboardExec,
  readClipboardBytes,
  selectClipboardReaders,
  type ClipboardExec,
} from '@dsh-cc/tui/harness/clipboard-readers.ts'
import {
  clipboardUploadDir,
  clipboardUploadPath,
  createClipboardImageProvider,
  readClipboardImage,
  spillClipboardImage,
} from '@dsh-cc/tui/harness/clipboard-image.ts'

/**
 * Nothing in this spec touches a real clipboard, a real platform pasteboard or
 * a real helper binary: the readers are data, and the one exec seam is faked.
 * The two places the real world is exercised are `defaultClipboardExec`'s
 * absent-binary and non-zero-exit handling, which need no clipboard at all.
 */

/**
 * 3x2 fixtures from real encoders, each independently confirmed as 3x2 by
 * other tooling (sips for PNG/GIF/JPEG, webpinfo for WebP). Real output on
 * purpose: the JPEG carries JFIF and Photoshop APP segments before its SOF0, so
 * the segment walk is tested against the length-skipping it actually needs.
 */
const PNG_3X2 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAG0lEQVR4nGNgYDjxPwCIFwAxA0MFkAPEC4AYAJ91DfM4bJ6DAAAAAElFTkSuQmCC',
  'base64',
)
const GIF_3X2 = Buffer.from(
  'R0lGODdhAwACALMAAAAAAAAAyFAAyKAAyAB4yFB4yKB4yP///wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACH5BAkAAAgALAAAAAADAAIAAAQFMIhBiokAOw==',
  'base64',
)
const JPEG_3X2 = Buffer.from(
  '/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAA6ADAAQAAAABAAAAAgAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAgADAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCwsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8AzPCHg/wl/wAIzp3/ABJLH/VD/l2i9T/s10n/AAh/hL/oCWP/AIDRf/E0nhD/AJFnTv8ArkP5mukr+38f/Hqer/M/fuFf+RXhf+vcP/SUf//Z',
  'base64',
)
const WEBP_3X2 = Buffer.from(
  'UklGRk4AAABXRUJQVlA4IEIAAADwAQCdASoDAAIAAgA0JagCdLoAAwkG+4AA/sKHTiYKfMv/0MU4Pn5I/t1Mx7rw+8L+X5//Jv7d35mAfP/5N+jAAAA=',
  'base64',
)

function tmpDir(prefix = 'dsh-cc-clip-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** Recorded call, so ordering and reader selection are assertable. */
interface FakeExec {
  exec: ClipboardExec
  calls: Array<{ file: string; args: readonly string[]; stdin: string | undefined }>
}

/** Fake exec answering per helper name; `undefined` models an ENOENT helper. */
function fakeExec(answer: (file: string) => Uint8Array | undefined): FakeExec {
  const calls: FakeExec['calls'] = []
  return {
    calls,
    exec: async (file, args, stdin) => {
      calls.push({ file, args, stdin })
      return answer(file)
    },
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('image bytes: media type from magic bytes', () => {
  it('recognises each supported encoding from real encoder output', () => {
    expect(sniffImageMediaType(PNG_3X2)).toBe('image/png')
    expect(sniffImageMediaType(JPEG_3X2)).toBe('image/jpeg')
    expect(sniffImageMediaType(GIF_3X2)).toBe('image/gif')
    expect(sniffImageMediaType(WEBP_3X2)).toBe('image/webp')
  })

  it('rejects empty, text and partial-signature payloads', () => {
    expect(sniffImageMediaType(Buffer.alloc(0))).toBeUndefined()
    expect(sniffImageMediaType(Buffer.from('NO_PNG\n'))).toBeUndefined()
    // A RIFF container of some other flavour is not a WebP.
    expect(sniffImageMediaType(Buffer.from('RIFF....WAVEfmt '))).toBeUndefined()
    // PNG signature only: enough for a naive magic check, not for an image.
    expect(sniffImageMediaType(PNG_3X2.subarray(0, 12))).toBeUndefined()
  })
})

describe('image bytes: dimensions from the header', () => {
  it('reads 3x2 from PNG, JPEG, GIF and WebP', () => {
    expect(imageDimensions(PNG_3X2, 'image/png')).toEqual({ width: 3, height: 2 })
    expect(imageDimensions(JPEG_3X2, 'image/jpeg')).toEqual({ width: 3, height: 2 })
    expect(imageDimensions(GIF_3X2, 'image/gif')).toEqual({ width: 3, height: 2 })
    expect(imageDimensions(WEBP_3X2, 'image/webp')).toEqual({ width: 3, height: 2 })
  })

  it('returns 0x0 (unknown) rather than guessing on garbage headers', () => {
    // PNG signature followed by bytes that are not an IHDR chunk.
    const fakePng = Buffer.concat([PNG_3X2.subarray(0, 8), Buffer.alloc(40, 0xab)])
    expect(imageDimensions(fakePng, 'image/png')).toEqual({ width: 0, height: 0 })
    // IHDR present but declaring a zero side.
    const zeroSide = Buffer.concat([PNG_3X2.subarray(0, 16), Buffer.from([0, 0, 0, 0, 0, 0, 0, 5])])
    expect(imageDimensions(zeroSide, 'image/png')).toEqual({ width: 0, height: 0 })
    // SOI then nothing: no frame header to read.
    expect(imageDimensions(JPEG_3X2.subarray(0, 3), 'image/jpeg')).toEqual({ width: 0, height: 0 })
    expect(imageDimensions(GIF_3X2.subarray(0, 6), 'image/gif')).toEqual({ width: 0, height: 0 })
    expect(imageDimensions(Buffer.from('RIFF'), 'image/webp')).toEqual({ width: 0, height: 0 })
  })
})

describe('reader selection', () => {
  it('macOS: osascript JXA, script on stdin, never on the command line', () => {
    const readers = selectClipboardReaders('darwin', {})
    expect(readers).toHaveLength(1)
    const [mac] = readers
    expect(mac?.id).toBe('darwin-jxa')
    expect(mac?.file).toBe('osascript')
    // `-` is what makes osascript read the program from stdin, keeping the
    // script's quoting away from the shell entirely.
    expect(mac?.args).toEqual(['-l', 'JavaScript', '-'])
    expect(mac?.stdin).toContain('NSFileHandle')
  })

  it('macOS script keeps both measured landmines fixed', () => {
    const script = selectClipboardReaders('darwin', {})[0]?.stdin ?? ''
    // writeToFileAtomically('/dev/stdout', true) renames a temp file into place
    // and silently yields exactly 6 bytes when the target is a device.
    expect(script).not.toContain('writeToFileAtomically')
    expect(script).toContain('fileHandleWithStandardOutput.writeData')
    // A nil dataForType() return is a truthy proxy here, so `if (!d)` would be
    // always-true and an uncalled `d.isNil` always-truthy; only the call is a
    // real nil test. See present() in clipboard-readers.ts.
    expect(script).toContain('present(data)')
    expect(script).toContain('public.tiff')
  })

  it('linux: Wayland first, then X11 for an XWayland clipboard', () => {
    const both = selectClipboardReaders('linux', { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' })
    expect(both.map(reader => reader.file)).toEqual(['wl-paste', 'xclip'])
    expect(both[0]?.args).toEqual(['--type', 'image/png'])
    expect(both[1]?.args).toEqual(['-selection', 'clipboard', '-t', 'image/png', '-o'])
  })

  it('linux: only the session that is actually present', () => {
    expect(selectClipboardReaders('linux', { WAYLAND_DISPLAY: 'wayland-0' }).map(r => r.file)).toEqual(['wl-paste'])
    expect(selectClipboardReaders('linux', { DISPLAY: ':0' }).map(r => r.file)).toEqual(['xclip'])
  })

  it('linux: neither session variable set means no reader at all', () => {
    // xclip cannot reach an X server without DISPLAY and wl-paste cannot reach
    // a compositor without WAYLAND_DISPLAY, so there is nothing to spawn.
    expect(selectClipboardReaders('linux', {})).toEqual([])
    expect(selectClipboardReaders('linux', { WAYLAND_DISPLAY: '', DISPLAY: '' })).toEqual([])
  })

  it('windows: powershell.exe then pwsh, same script', () => {
    const readers = selectClipboardReaders('win32', {})
    expect(readers.map(reader => reader.file)).toEqual(['powershell.exe', 'pwsh'])
    expect(readers[0]?.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command'])
    expect(readers[0]?.args[3]).toBe(readers[1]?.args[3])
    expect(readers[0]?.args[3]).toContain('Get-Clipboard -Format Image')
  })

  it('any other platform: no reader, silent no-op', () => {
    expect(selectClipboardReaders('freebsd', { DISPLAY: ':0' })).toEqual([])
    expect(selectClipboardReaders('aix', {})).toEqual([])
  })
})

describe('readClipboardBytes', () => {
  it('stops at the first reader that yields bytes', async () => {
    const fake = fakeExec(file => (file === 'wl-paste' ? PNG_3X2 : GIF_3X2))
    const readers = selectClipboardReaders('linux', { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' })
    const bytes = await readClipboardBytes(readers, fake.exec)
    expect(Buffer.from(bytes ?? [])).toEqual(PNG_3X2)
    expect(fake.calls.map(call => call.file)).toEqual(['wl-paste'])
  })

  it('an absent first helper (ENOENT -> undefined) falls through to the next reader', async () => {
    const fake = fakeExec(file => (file === 'xclip' ? PNG_3X2 : undefined))
    const readers = selectClipboardReaders('linux', { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' })
    const bytes = await readClipboardBytes(readers, fake.exec)
    expect(Buffer.from(bytes ?? [])).toEqual(PNG_3X2)
    expect(fake.calls.map(call => call.file)).toEqual(['wl-paste', 'xclip'])
  })

  it('forwards the reader argv and its stdin script to exec', async () => {
    const fake = fakeExec(() => PNG_3X2)
    await readClipboardBytes(selectClipboardReaders('darwin', {}), fake.exec)
    expect(fake.calls[0]?.file).toBe('osascript')
    expect(fake.calls[0]?.args).toEqual(['-l', 'JavaScript', '-'])
    expect(fake.calls[0]?.stdin).toContain('NSPasteboard')
  })

  it('a rejecting exec is contained, not propagated', async () => {
    const exec: ClipboardExec = async () => {
      throw new Error('spawn EACCES')
    }
    await expect(readClipboardBytes(selectClipboardReaders('linux', { DISPLAY: ':0' }), exec)).resolves.toBeUndefined()
  })

  it('empty output from every reader is undefined', async () => {
    const fake = fakeExec(() => new Uint8Array(0))
    await expect(readClipboardBytes(selectClipboardReaders('linux', { DISPLAY: ':0' }), fake.exec)).resolves.toBeUndefined()
  })

  it('no readers means no spawn at all', async () => {
    const fake = fakeExec(() => PNG_3X2)
    await expect(readClipboardBytes(selectClipboardReaders('linux', {}), fake.exec)).resolves.toBeUndefined()
    expect(fake.calls).toEqual([])
  })

  it('real exec: an absent binary is "not available", not an error', async () => {
    await expect(defaultClipboardExec('dsh-cc-no-such-helper-binary', ['--type', 'image/png'])).resolves.toBeUndefined()
  })

  it('real exec: non-zero exit yields undefined', async () => {
    await expect(defaultClipboardExec(process.execPath, ['-e', 'process.exit(3)'])).resolves.toBeUndefined()
  })

  it('real exec: a helper that overruns the byte ceiling is cut off', async () => {
    const script = `process.stdout.write('x'.repeat(${CLIPBOARD_MAX_BYTES + 1024}))`
    await expect(defaultClipboardExec(process.execPath, ['-e', script])).resolves.toBeUndefined()
  })
})

describe('cache spill', () => {
  it('content-addressed path under <tuiDir>/uploads/<sessionId>', () => {
    const dir = tmpDir()
    const digest = createHash('sha256').update(PNG_3X2).digest('hex')
    expect(clipboardUploadPath(PNG_3X2, 'image/png', 'sess-1', dir))
      .toBe(join(dir, 'uploads', 'sess-1', `${digest}-image.png`))
  })

  it('extension follows the media type', () => {
    const dir = tmpDir()
    expect(clipboardUploadPath(JPEG_3X2, 'image/jpeg', 's', dir)).toMatch(/-image\.jpg$/)
    expect(clipboardUploadPath(GIF_3X2, 'image/gif', 's', dir)).toMatch(/-image\.gif$/)
    expect(clipboardUploadPath(WEBP_3X2, 'image/webp', 's', dir)).toMatch(/-image\.webp$/)
  })

  it('writes the bytes 0600 in a 0700 bucket', () => {
    const dir = tmpDir()
    const path = spillClipboardImage(PNG_3X2, 'image/png', 'sess-1', dir)
    expect(path).toBeDefined()
    expect(readFileSync(path ?? '')).toEqual(PNG_3X2)
    // The clipboard can hold a password-manager screenshot; the spill inherits
    // that sensitivity and lives past the session.
    expect(statSync(path ?? '').mode & 0o777).toBe(0o600)
    expect(statSync(clipboardUploadDir('sess-1', dir)).mode & 0o777).toBe(0o700)
  })

  it('re-pasting the same image does not duplicate or rewrite the file', () => {
    const dir = tmpDir()
    const first = spillClipboardImage(PNG_3X2, 'image/png', 'sess-1', dir)
    const mtime = statSync(first ?? '').mtimeMs
    const second = spillClipboardImage(PNG_3X2, 'image/png', 'sess-1', dir)
    expect(second).toBe(first)
    expect(statSync(second ?? '').mtimeMs).toBe(mtime)
    expect(readdirSync(clipboardUploadDir('sess-1', dir))).toHaveLength(1)
  })

  it('different bytes land in different files', () => {
    const dir = tmpDir()
    spillClipboardImage(PNG_3X2, 'image/png', 'sess-1', dir)
    spillClipboardImage(GIF_3X2, 'image/gif', 'sess-1', dir)
    expect(readdirSync(clipboardUploadDir('sess-1', dir))).toHaveLength(2)
  })

  it('sessions are separate buckets', () => {
    const dir = tmpDir()
    spillClipboardImage(PNG_3X2, 'image/png', 'sess-a', dir)
    spillClipboardImage(PNG_3X2, 'image/png', 'sess-b', dir)
    expect(clipboardUploadDir('sess-a', dir)).not.toBe(clipboardUploadDir('sess-b', dir))
    expect(clipboardUploadDir(undefined, dir)).toBe(join(dir, 'uploads', 'session'))
  })

  it('a session id cannot escape the uploads dir', () => {
    const dir = tmpDir()
    const uploads = join(dir, 'uploads')
    for (const hostile of ['../../etc', '..', '.', 'a/b', 'a\\b', '']) {
      const segment = relative(uploads, clipboardUploadDir(hostile, dir))
      // Exactly one path segment below uploads/, never a parent reference: a
      // dotty name like "....etc" is harmless, a separator or ".." would not be.
      expect(segment).not.toBe('')
      expect(segment).not.toBe('..')
      expect(segment).not.toContain('/')
      expect(segment).not.toContain('\\')
      expect(clipboardUploadPath(PNG_3X2, 'image/png', hostile, dir).startsWith(uploads + sep)).toBe(true)
    }
  })

  it('default dir is $DSH_HOME/tui/uploads (house resolution)', () => {
    const home = tmpDir()
    vi.stubEnv('DSH_HOME', home)
    expect(clipboardUploadDir('sess-1')).toBe(join(home, 'tui', 'uploads', 'sess-1'))
  })

  it('an unwritable cache dir yields undefined, not a throw', () => {
    const dir = tmpDir()
    // A file where the uploads dir should be: mkdir fails with ENOTDIR.
    writeFileSync(join(dir, 'uploads'), 'not a directory')
    expect(spillClipboardImage(PNG_3X2, 'image/png', 'sess-1', dir)).toBeUndefined()
  })
})

describe('onPasteImage provider', () => {
  const linuxOpts = { platform: 'linux' as const, env: { DISPLAY: ':0' } }

  it('a successful read spills and reports mediaType plus dimensions', async () => {
    const dir = tmpDir()
    const fake = fakeExec(() => PNG_3X2)
    const provider = createClipboardImageProvider({ ...linuxOpts, dir, getSessionId: () => 'sess-1', exec: fake.exec })
    const image = await provider()
    expect(image).toBeDefined()
    expect(image?.mediaType).toBe('image/png')
    expect(image?.width).toBe(3)
    expect(image?.height).toBe(2)
    expect(image?.path).toBe(clipboardUploadPath(PNG_3X2, 'image/png', 'sess-1', dir))
    expect(readFileSync(image?.path ?? '')).toEqual(PNG_3X2)
  })

  it('spills and reports the media type for every supported encoding', async () => {
    const dir = tmpDir()
    for (const [bytes, mediaType] of [
      [JPEG_3X2, 'image/jpeg'],
      [GIF_3X2, 'image/gif'],
      [WEBP_3X2, 'image/webp'],
    ] as const) {
      const provider = createClipboardImageProvider({ ...linuxOpts, dir, exec: fakeExec(() => bytes).exec })
      const image = await provider()
      expect(image?.mediaType).toBe(mediaType)
      expect([image?.width, image?.height]).toEqual([3, 2])
    }
  })

  it('reads the session id per paste, so /resume rebinds the bucket', async () => {
    const dir = tmpDir()
    let session = 'sess-a'
    const provider = createClipboardImageProvider({
      ...linuxOpts,
      dir,
      getSessionId: () => session,
      exec: fakeExec(() => PNG_3X2).exec,
    })
    const first = await provider()
    session = 'sess-b'
    const second = await provider()
    expect(first?.path).toContain(join('uploads', 'sess-a'))
    expect(second?.path).toContain(join('uploads', 'sess-b'))
  })

  it('platform with no reader is a silent no-op and spawns nothing', async () => {
    const fake = fakeExec(() => PNG_3X2)
    const provider = createClipboardImageProvider({ platform: 'freebsd', dir: tmpDir(), exec: fake.exec })
    await expect(provider()).resolves.toBeUndefined()
    expect(fake.calls).toEqual([])
  })

  it('absent helper, empty output and non-image output all give undefined', async () => {
    const dir = tmpDir()
    for (const answer of [() => undefined, () => new Uint8Array(0), () => Buffer.from('no image here\n')]) {
      const provider = createClipboardImageProvider({ ...linuxOpts, dir, exec: fakeExec(answer).exec })
      await expect(provider()).resolves.toBeUndefined()
    }
    // Nothing was spilled for any of them.
    expect(readdirSync(dir)).toEqual([])
  })

  it('a rejecting exec gives undefined rather than a rejection', async () => {
    const provider = createClipboardImageProvider({
      ...linuxOpts,
      dir: tmpDir(),
      exec: async () => {
        throw new Error('boom')
      },
    })
    await expect(provider()).resolves.toBeUndefined()
  })

  it('a failing spill gives undefined rather than a rejection', async () => {
    const dir = tmpDir()
    writeFileSync(join(dir, 'uploads'), 'not a directory')
    const provider = createClipboardImageProvider({ ...linuxOpts, dir, exec: fakeExec(() => PNG_3X2).exec })
    await expect(provider()).resolves.toBeUndefined()
  })

  it('logs nothing on any failure path', async () => {
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'info').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
    ]
    const dir = tmpDir()
    writeFileSync(join(dir, 'uploads'), 'not a directory')
    const providers = [
      createClipboardImageProvider({ platform: 'freebsd', dir }),
      createClipboardImageProvider({ ...linuxOpts, dir, exec: fakeExec(() => undefined).exec }),
      createClipboardImageProvider({ ...linuxOpts, dir, exec: fakeExec(() => Buffer.from('text')).exec }),
      createClipboardImageProvider({ ...linuxOpts, dir, exec: fakeExec(() => PNG_3X2).exec }),
      createClipboardImageProvider({
        ...linuxOpts,
        dir,
        exec: async () => {
          throw new Error('boom')
        },
      }),
    ]
    for (const provider of providers) await expect(provider()).resolves.toBeUndefined()
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })

  it('readClipboardImage is the one-shot form', async () => {
    const dir = tmpDir()
    const image = await readClipboardImage({ ...linuxOpts, dir, exec: fakeExec(() => PNG_3X2).exec })
    expect(image?.mediaType).toBe('image/png')
  })
})
