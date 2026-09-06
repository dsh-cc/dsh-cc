/**
 * Boot banner art + info text for the CC transcript. Brand art is
 * theme-independent: the whale renders through a fixed deep-to-light blue
 * 256-color ramp regardless of the configured palette.
 * @module @dsh-cc/tui/harness/boot-banner
 */
import { sgr } from '../components/theme.ts'
import type { TranscriptRow } from '../store.ts'

/**
 * DeepSeek whale source art, "half-block compressed" (半块压缩版): 11 rows of
 * '█' (filled) / '.' (background), embedded verbatim — pristine. The eye is
 * punched at build time (see {@link EYE}), so the source art above stays
 * untouched and the eye intent is documented here rather than edited in.
 */
const WHALE_BITMAP = [
  '..........................███......█.......',
  '..........................█████..█████.....',
  '..........█████████.......████████████.....',
  '........███████████████.....█████████......',
  '......███████████████████..██████..........',
  '......████████████████████████.██..........',
  '......███████████████████████████..........',
  '......█████.......██████████████...........',
  '.......██.............█████████............',
  '.........███...........█████████...........',
  '............███████████..███████...........',
]

/**
 * Eye hole: bitmap rows 4 and 5, column 27 (0-based). Rows are paired
 * vertically (0,1),(2,3),(4,5),… so punching both rows keeps the eye inside
 * one half-block pair. Applied at build time over the verbatim bitmap.
 */
const EYE: ReadonlyArray<readonly [row: number, col: number]> = [
  [4, 27],
  [5, 27],
]

/**
 * Fixed deep→light 256-color SGR foreground ramp, one per output line. The
 * mid rows anchor on 63 (#5f5fff), the nearest 256-color match to the
 * DeepSeek brand blue #4D6BFE; the ramp stays on the blue axis (no cyan
 * drift) and the belly tops out at 75 (#5fafff).
 */
const BLUE_RAMP = ['38;5;25', '38;5;26', '38;5;27', '38;5;63', '38;5;69', '38;5;75']

/** Bitmap with the eye punched in (filled → background) at the EYE points. */
const PUNCHED: readonly string[] = (() => {
  const rows = WHALE_BITMAP.slice()
  for (const [r, c] of EYE) {
    rows[r] = rows[r]!.slice(0, c) + '.' + rows[r]!.slice(c + 1)
  }
  return rows
})()

/**
 * Build the 6-line half-block whale art: vertical row pairs compress to one
 * line ('█' both, '▀' upper only, '▄' lower only). Lines are right-trimmed,
 * then the common left indent is trimmed so alignment survives. Every line
 * is wrapped in its fixed blue SGR foreground and closed with `\x1b[0m`
 * (pi-tui's wrap engine carries active codes across lines).
 */
export function whaleBannerArt(): string {
  const lines: string[] = []
  for (let pair = 0; pair * 2 < PUNCHED.length; pair++) {
    const upper = PUNCHED[pair * 2]!
    const lower = PUNCHED[pair * 2 + 1] ?? ''
    let line = ''
    for (let col = 0; col < upper.length; col++) {
      const up = upper[col] === '█'
      const low = lower[col] === '█'
      line += up && low ? '█' : up ? '▀' : low ? '▄' : ' '
    }
    lines.push(line)
  }
  const trimmed = lines.map(line => line.replace(/\s+$/, ''))
  const indent = Math.min(...trimmed.map(line => line.length - line.trimStart().length))
  return trimmed
    .map(line => line.slice(indent))
    .map((line, i) => sgr(BLUE_RAMP[i % BLUE_RAMP.length]!)(line))
    .join('\n')
}

/** Boot info line under the whale art (em dash + middle dots, as historically). */
export function bootBannerText(modelLabel: string, cwd: string): string {
  return `dsh cc-mode — ${modelLabel} · ${cwd} · /tui-help for keys`
}

/** The two transcript rows emitted at boot: whale art, then the info line. */
export function bootBannerRows(modelLabel: string, cwd: string): TranscriptRow[] {
  return [
    { kind: 'banner', text: whaleBannerArt() },
    { kind: 'status', text: bootBannerText(modelLabel, cwd) },
  ]
}
