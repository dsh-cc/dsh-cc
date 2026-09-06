import { describe, expect, it } from 'vitest'
import { TranscriptView } from '@dsh-cc/tui/components/transcript.ts'
import { bootBannerRows, bootBannerText, whaleBannerArt } from '@dsh-cc/tui/harness/boot-banner.ts'

describe('whaleBannerArt', () => {
  it('is exactly 6 lines, each closed with a reset SGR', () => {
    const art = whaleBannerArt()
    const lines = art.split('\n')
    expect(lines).toHaveLength(6)
    for (const line of lines) {
      expect(line.endsWith('\x1b[0m')).toBe(true)
    }
  })

  it('keeps every visible line within 44 columns', () => {
    for (const line of whaleBannerArt().split('\n')) {
      const visible = line.replace(/\x1b\[[0-9;]*m/g, '')
      expect(visible.length).toBeLessThanOrEqual(44)
    }
  })

  it('uses half-block glyphs (upper and lower) from the compression', () => {
    const art = whaleBannerArt()
    expect(art).toContain('▀')
    expect(art).toContain('▄')
    expect(art).toContain('█')
  })

  it('pins the exact art (eye hole + blue ramp) as an inline snapshot', () => {
    expect(whaleBannerArt()).toMatchInlineSnapshot(
      `
      "[38;5;25m                    ███▄▄  ▄▄█▄▄[0m
      [38;5;26m  ▄▄█████████▄▄▄▄   ▀▀█████████▀[0m
      [38;5;27m███████████████████▄▄ ██▀██[0m
      [38;5;63m█████▀▀▀▀▀▀▀██████████████▀[0m
      [38;5;69m ▀▀▄▄▄          ▀████████▄[0m
      [38;5;75m      ▀▀▀▀▀▀▀▀▀▀▀  ▀▀▀▀▀▀▀[0m"
    `,
    )
  })

  it('punches the eye as a gap in the head region of line 2 (bitmap rows 4+5)', () => {
    const line = whaleBannerArt().split('\n')[2]!.replace(/\x1b\[[0-9;]*m/g, '')
    expect(line).toContain('█')
    // Bitmap row 4 col 27 lands inside this line's head run — the eye.
    expect(line.includes(' ▀') || line.includes('▀ ') || line.includes(' ▄') || line.includes('▄ ')).toBe(true)
  })
})

describe('bootBannerText', () => {
  it('matches the exact historical format', () => {
    expect(bootBannerText('e2e-1', '/fake/path')).toBe('dsh cc-mode — e2e-1 · /fake/path · /tui-help for keys')
  })
})

describe('bootBannerRows', () => {
  it('emits banner first, then status', () => {
    const rows = bootBannerRows('m', '/cwd')
    expect(rows.map(r => r.kind)).toEqual(['banner', 'status'])
    expect(rows[1]).toMatchObject({ kind: 'status', text: bootBannerText('m', '/cwd') })
  })
})

describe('banner rendering (buildChild path via TranscriptView)', () => {
  const art = whaleBannerArt()
  const view = new TranscriptView()

  it('suppresses the art to one blank line below 44 columns without throwing', () => {
    view.setRows([{ kind: 'banner', text: art }])
    expect(() => view.render(30)).not.toThrow()
    const lines = view.render(30)
    expect(lines).toEqual([''])
  })

  it('renders 6 lines at width 80, byte-identical to the art (no rewrap)', () => {
    const lines = view.render(80)
    expect(lines).toHaveLength(6)
    const artLines = art.split('\n')
    // pi-tui pads each line to the full width; modulo that trailing pad the
    // bytes must be identical to the source art (no wrap-shred).
    lines.forEach((line, i) => {
      expect(line.trimEnd()).toBe(artLines[i])
      expect(line.startsWith(artLines[i]!.replace(/\x1b\[0m$/, ''))).toBe(true)
    })
  })
})
