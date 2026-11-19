/**
 * Plugin bands: a small, read-only extension point that lets other cordis
 * plugins show one or two lines of live status above the composer (an inbox
 * count, a background job, a connection state) without owning any part of the
 * render tree. The TUI provides one {@link TuiBands} registry as the
 * `tuiBands` service; a plugin registers a band, calls `refresh()` when its
 * text changes, and disposes the registration when it unloads.
 *
 * Bands are display-only by design: they take no keys and cannot steal focus,
 * so a plugin can never interfere with the editor or overlays. Interaction stays
 * with slash commands, which plugins already register through the command
 * registry (a band can point at one, e.g. `2 waiting · /inbox`).
 *
 * Contract:
 * - `render({ width, sessionId })` runs on every frame, so it must be cheap and
 *   synchronous; compute the text elsewhere and keep the latest value.
 *   `sessionId` is the session the TUI currently shows, so a band can be
 *   per-session (it changes on `/resume` and session switches).
 * - Return `undefined`, an empty string or an empty array to hide the band.
 * - At most {@link MAX_BAND_LINES} lines per band are shown; each line is cut to
 *   the terminal width. Newlines inside a line are flattened to spaces.
 * - Bands are drawn in ascending `order` (default 0), ties in registration order.
 * - A band whose `render` throws is skipped for that frame; the error is
 *   reported once per band through the registry's `onError` hook.
 * @module @dsh-cc/tui/bands
 */

import { truncateToWidth } from '@dsh-cc/pi-tui'

/** The palette role a band's lines are drawn in; omitted = the default text color. */
export type BandTone = 'muted' | 'accent' | 'success' | 'warning' | 'error'

/** What a band is rendered for. */
export interface BandRenderContext {
  /** Terminal width in columns. */
  readonly width: number
  /** The session the TUI currently shows; undefined before one is attached. */
  readonly sessionId: string | undefined
}

export interface BandDefinition {
  /** Stable id, unique among live bands (e.g. `my-plugin/status`). */
  readonly id: string
  /** Sort key; lower first. Default 0. */
  readonly order?: number
  /** Palette role for every line of this band. */
  readonly tone?: BandTone
  /** Current text for this frame. Called on every frame. */
  render(context: BandRenderContext): string | readonly string[] | undefined
}

/** One visible line, already cut to width, with the tone to draw it in. */
export interface BandLine {
  readonly id: string
  readonly tone: BandTone | undefined
  readonly text: string
}

/** Lines shown per band at most. */
export const MAX_BAND_LINES = 2

interface Entry {
  readonly band: BandDefinition
  readonly seq: number
  reportedError: boolean
}

/**
 * Registry behind the `tuiBands` service. Framework-free so it can be tested
 * and reused without a terminal.
 */
export class TuiBands {
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Set<() => void>()
  private seq = 0

  /**
   * @param onError - receives a band's first render failure (later failures of
   *   the same band are silent until it renders successfully again).
   */
  constructor(private readonly onError: (id: string, error: unknown) => void = () => {}) {}

  /**
   * Add a band. Throws if a live band already uses the id.
   * @returns a disposer that removes the band (idempotent).
   */
  register(band: BandDefinition): () => void {
    if (typeof band.id !== 'string' || band.id.length === 0) throw new TypeError('tuiBands: a band needs a non-empty id')
    if (typeof band.render !== 'function') throw new TypeError(`tuiBands: band ${band.id} needs a render function`)
    if (this.entries.has(band.id)) throw new Error(`tuiBands: a band with id ${band.id} is already registered`)
    const entry: Entry = { band, seq: this.seq++, reportedError: false }
    this.entries.set(band.id, entry)
    this.refresh()
    return () => {
      if (this.entries.get(band.id) !== entry) return
      this.entries.delete(band.id)
      this.refresh()
    }
  }

  /** Ask the TUI to redraw; call after a band's text changed. */
  refresh(): void {
    for (const listener of [...this.listeners]) listener()
  }

  /** Subscribe to refreshes (the TUI uses this to schedule a render). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Number of live bands. */
  get size(): number {
    return this.entries.size
  }

  /** Visible lines for this frame, in band order, each cut to `width`. */
  lines(width: number, sessionId?: string): BandLine[] {
    const context: BandRenderContext = { width, sessionId }
    const out: BandLine[] = []
    const ordered = [...this.entries.values()].sort(
      (a, b) => (a.band.order ?? 0) - (b.band.order ?? 0) || a.seq - b.seq,
    )
    for (const entry of ordered) {
      let raw: string | readonly string[] | undefined
      try {
        raw = entry.band.render(context)
        entry.reportedError = false
      } catch (error) {
        if (!entry.reportedError) {
          entry.reportedError = true
          this.onError(entry.band.id, error)
        }
        continue
      }
      const list = raw === undefined ? [] : typeof raw === 'string' ? [raw] : raw
      let shown = 0
      for (const line of list) {
        if (shown >= MAX_BAND_LINES) break
        if (typeof line !== 'string' || line.length === 0) continue
        const flat = line.replace(/[\r\n]+/g, ' ')
        out.push({ id: entry.band.id, tone: entry.band.tone, text: width > 0 ? truncateToWidth(flat, width) : '' })
        shown++
      }
    }
    return out
  }
}
