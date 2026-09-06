import { describe, expect, it } from 'vitest'
import { renderRowText, rowSourceLines } from '@dsh-cc/tui/components/transcript.ts'
import type { TranscriptRow } from '@dsh-cc/tui/store.ts'
import { defaultTheme } from '@dsh-cc/tui/components/theme.ts'

const manual: TranscriptRow = {
  kind: 'compact',
  trigger: 'manual',
  items: 328,
  tokens: 119542,
  summary: '## Primary Request and Intent\n- compact the transcript',
}
const auto: TranscriptRow = { ...manual, trigger: 'auto' }

describe('compact row rendering', () => {
  it('collapsed shows the accounting line and the toggle hint', () => {
    const text = renderRowText(manual, { compactExpanded: false })
    expect(text).toContain('Compacted 328 messages (~119542 tokens) — Ctrl+O to show summary')
    expect(text).not.toContain('## Primary Request')
  })

  it('auto trigger prefixes Auto-compacted', () => {
    const text = renderRowText(auto, { compactExpanded: false })
    expect(text).toContain('Auto-compacted 328 messages')
  })

  it('expanded includes the summary body', () => {
    const text = renderRowText(manual, { compactExpanded: true })
    expect(text).toContain('Compacted 328 messages')
    expect(text).toContain('## Primary Request and Intent')
    expect(text).toContain('- compact the transcript')
  })

  it('rowSourceLines counts 1 collapsed and 1 + summary lines expanded', () => {
    expect(rowSourceLines(manual, defaultTheme, { compactExpanded: false })).toBe(1)
    expect(rowSourceLines(manual, defaultTheme, { compactExpanded: true })).toBe(3)
    expect(rowSourceLines(auto, defaultTheme, { compactExpanded: false })).toBe(1)
  })
})
