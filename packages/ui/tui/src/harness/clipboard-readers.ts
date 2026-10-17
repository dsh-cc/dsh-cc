/**
 * OS pasteboard readers for image paste: one command spec per platform (argv
 * plus, for macOS, a script fed on stdin), and the single place that spawns
 * anything. Keeping the readers as data means selection and failure handling
 * are testable without a real clipboard, a real helper binary, or a real
 * platform - the only untestable part left is `spawn` itself.
 *
 * Every reader is best-effort. A missing helper, a non-zero exit, a clipboard
 * that holds no image and a helper that cannot reach a display all collapse to
 * the same value (`undefined`) so the caller has exactly one failure path.
 *
 * @module @dsh-cc/tui/harness/clipboard-readers
 */

import { spawn, type ChildProcess } from 'node:child_process'

/**
 * Ceiling on a helper's stdout. A full-screen Retina screenshot PNG is a few
 * MB, so 32 MiB is headroom rather than a limit anyone should reach; it exists
 * so a helper that ignores its type filter and streams something unbounded
 * cannot grow the TUI's heap without end.
 */
export const CLIPBOARD_MAX_BYTES = 32 * 1024 * 1024

/**
 * Run a helper and return its stdout bytes, or `undefined` when it is absent,
 * exits non-zero, writes nothing, or overruns {@link CLIPBOARD_MAX_BYTES}.
 * Never throws and never writes to the caller's stderr.
 */
export type ClipboardExec = (file: string, args: readonly string[], stdin?: string) => Promise<Uint8Array | undefined>

/** One candidate pasteboard read, as data. */
export interface ClipboardReader {
  /** Stable id, for tests and diagnostics ("darwin-jxa", "linux-wl-paste", ...). */
  readonly id: string
  /** Helper executable, resolved through PATH. */
  readonly file: string
  readonly args: readonly string[]
  /** Script to feed on stdin (macOS); readers that take no stdin omit it. */
  readonly stdin?: string
}

/**
 * AppKit pasteboard read, through osascript's JavaScript bridge (JXA).
 *
 * `-` makes osascript read the script from stdin. The script is fed there
 * rather than through `-e` so its quoting never has to survive the shell's;
 * it is full of quotes.
 *
 * Two measured traps, both worth the comments:
 *
 * 1. Bytes leave through `NSFileHandle.fileHandleWithStandardOutput.writeData`.
 *    `writeToFileAtomically('/dev/stdout', true)` looks equivalent and is not:
 *    it writes a sibling temp file and renames it into place, which on a device
 *    target silently yields exactly 6 bytes (measured). Nothing errors; the
 *    paste just becomes a corrupt 6-byte PNG.
 * 2. `present()` is the nil test, and neither obvious spelling works. Measured
 *    on macOS 26.4: a nil ObjC return is a TRUTHY function-like proxy, so
 *    `if (!d)` is always false - which would make the TIFF fallback below dead
 *    code - and an uncalled `d.isNil` is a function object, also truthy, which
 *    is the classic always-NO_PNG false negative. Calling it is the one form
 *    that discriminates (no-png -> true, real NSData -> false, 84 bytes read
 *    back from an 84-byte fixture).
 */
const MACOS_PASTEBOARD_JXA = `ObjC.import('AppKit');
ObjC.import('Foundation');
const present = x => (!!x && typeof x.isNil === 'function') ? !x.isNil() : !!x;
const pb = $.NSPasteboard.generalPasteboard;
let data = pb.dataForType('public.png');
if (!present(data)) {
  const tiff = pb.dataForType('public.tiff');
  if (present(tiff)) {
    const rep = $.NSBitmapImageRep.imageRepWithData(tiff);
    if (present(rep)) {
      const png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());
      if (present(png)) { data = png; }
    }
  }
}
if (present(data)) {
  $.NSFileHandle.fileHandleWithStandardOutput.writeData(data);
}
`

/**
 * PowerShell pasteboard read, as PNG on the raw stdout stream.
 *
 * `[Console]::OpenStandardOutput()` rather than `$img.Save(<path>)` or a
 * pipeline: PowerShell's success stream is text and would re-encode (and
 * newline-mangle) binary bytes, so the bytes have to bypass it. The script
 * contains no double quote on purpose - spawn passes argv through
 * CreateProcess quoting, and PowerShell strips the outer pair, so a quote-free
 * script reaches its parser exactly as written.
 */
const WINDOWS_PASTEBOARD_PS = [
  'Add-Type -AssemblyName System.Drawing',
  '$img = Get-Clipboard -Format Image',
  'if ($null -ne $img) {',
  '  $ms = New-Object System.IO.MemoryStream',
  '  $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)',
  '  $out = [Console]::OpenStandardOutput()',
  '  $bytes = $ms.ToArray()',
  '  $out.Write($bytes, 0, $bytes.Length)',
  '  $out.Flush()',
  '}',
].join('\n')

const MACOS_PASTEBOARD_READER: ClipboardReader = {
  id: 'darwin-jxa',
  file: 'osascript',
  args: ['-l', 'JavaScript', '-'],
  stdin: MACOS_PASTEBOARD_JXA,
}

const WAYLAND_PASTEBOARD_READER: ClipboardReader = {
  id: 'linux-wl-paste',
  file: 'wl-paste',
  args: ['--type', 'image/png'],
}

const X11_PASTEBOARD_READER: ClipboardReader = {
  id: 'linux-xclip',
  file: 'xclip',
  args: ['-selection', 'clipboard', '-t', 'image/png', '-o'],
}

const WINDOWS_POWERSHELL_READER: ClipboardReader = {
  id: 'windows-powershell',
  file: 'powershell.exe',
  args: ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PASTEBOARD_PS],
}

/** Windows PowerShell 7 installs as `pwsh`, and 5.1 is not always present. */
const WINDOWS_PWSH_READER: ClipboardReader = {
  id: 'windows-pwsh',
  file: 'pwsh',
  args: ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PASTEBOARD_PS],
}

/**
 * Readers to try, in order, for a platform. Empty means "this platform has no
 * reader": the paste stays the silent no-op it has always been, which is the
 * required behavior for ssh, containers and bare consoles.
 *
 * On Linux the Wayland and X11 clipboards are different clipboards (an XWayland
 * app owns the X11 one), so both are listed when both sessions are present and
 * an empty read from the first is not taken as the answer for the second. The
 * env vars are also the gate: xclip cannot reach an X server without DISPLAY
 * and wl-paste cannot reach a compositor without WAYLAND_DISPLAY, so with
 * neither set there is nothing to try - skipping the spawns keeps that case
 * free instead of merely silent.
 */
export function selectClipboardReaders(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): ClipboardReader[] {
  if (platform === 'darwin') return [MACOS_PASTEBOARD_READER]
  if (platform === 'win32') return [WINDOWS_POWERSHELL_READER, WINDOWS_PWSH_READER]
  if (platform !== 'linux') return []
  const readers: ClipboardReader[] = []
  if (env['WAYLAND_DISPLAY'] !== undefined && env['WAYLAND_DISPLAY'] !== '') readers.push(WAYLAND_PASTEBOARD_READER)
  if (env['DISPLAY'] !== undefined && env['DISPLAY'] !== '') readers.push(X11_PASTEBOARD_READER)
  return readers
}

/**
 * The real {@link ClipboardExec}: spawn `file` with `args`, collect stdout as
 * raw bytes. No shell is involved at any point, so no reader argument is ever
 * re-parsed by one.
 *
 * stderr is discarded rather than inherited: a helper that fails (osascript's
 * "execution error", xclip's "Error: target image/png not available") would
 * otherwise print over the alternate screen the TUI is drawing on, and this
 * feature is required to stay invisible when it fails.
 */
export const defaultClipboardExec: ClipboardExec = (file, args, stdin) => new Promise((resolve) => {
  let child: ChildProcess
  try {
    child = spawn(file, [...args], { stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'] })
  } catch {
    resolve(undefined) // malformed argv throws synchronously; treat as unavailable
    return
  }
  const chunks: Buffer[] = []
  let total = 0
  let settled = false
  const settle = (value: Uint8Array | undefined): void => {
    if (settled) return
    settled = true
    resolve(value)
  }
  child.stdout?.on('data', (chunk: Buffer) => {
    total += chunk.length
    if (total > CLIPBOARD_MAX_BYTES) {
      child.kill()
      settle(undefined)
      return
    }
    chunks.push(chunk)
  })
  // ENOENT lands here: an absent helper is "not available", not an error.
  child.on('error', () => settle(undefined))
  child.on('close', (code) => settle(code === 0 && total > 0 ? Buffer.concat(chunks) : undefined))
  if (stdin !== undefined) {
    // A helper that exits without draining stdin (or that never started) makes
    // this write fail with EPIPE; the exit code already decides the outcome.
    child.stdin?.on('error', () => {})
    child.stdin?.end(stdin)
  }
})

/**
 * First reader that yields bytes wins; `undefined` when none does. Each reader
 * is independent: a failure, an empty read or a missing binary moves on to the
 * next rather than ending the attempt. Raw stdout is returned uninterpreted -
 * whether it is really an image is the caller's sniff, since a helper can exit
 * 0 having printed an error or a text clipboard.
 */
export async function readClipboardBytes(
  readers: readonly ClipboardReader[],
  exec: ClipboardExec = defaultClipboardExec,
): Promise<Uint8Array | undefined> {
  for (const reader of readers) {
    let bytes: Uint8Array | undefined
    try {
      bytes = await exec(reader.file, reader.args, reader.stdin)
    } catch {
      continue // an injected exec may reject; a reader never fails a paste
    }
    if (bytes !== undefined && bytes.length > 0) return bytes
  }
  return undefined
}
