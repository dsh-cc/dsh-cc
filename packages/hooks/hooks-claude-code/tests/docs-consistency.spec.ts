import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SUPPORTED_CLAUDE_EVENTS } from '@dsh-cc/hooks-claude-code/src/config.ts'

/**
 * Docs-consistency gate (F7): each README's supported enumeration must match
 * `SUPPORTED_CLAUDE_EVENTS` exactly, and the stated unsupported count must
 * equal the number of event names the unsupported enumeration actually lists.
 * The regexes tolerate the surrounding prose (locale-specific) but anchor on
 * markers present in BOTH files and extract only PascalCase backticked
 * identifiers, so subtype/source prose (`idle`, `auth_success`, `clear`, …)
 * can never pollute the sets.
 */

const README_DIR = join(import.meta.dirname, '..')

const MARKERS = {
  'README.md': {
    supported: '**Supported hook events',
    unsupported: '**Unsupported',
    unsupportedCount: /\*\*Unsupported \((\d+)\):\*\*/,
    unsupportedEnd: ' — plus',
  },
  'README.zh.md': {
    supported: '**已支持的 hook 事件',
    unsupported: '**不支持',
    unsupportedCount: /\*\*不支持（(\d+) 项）：\*\*/,
    unsupportedEnd: '；另有',
  },
} as const

/** Backticked PascalCase identifiers — event names in both locales. */
function eventNames(text: string): string[] {
  return [...text.matchAll(/`([A-Z][A-Za-z]+)`/g)].map(match => match[1]!)
}

describe('hooks-claude-code README event enumerations', () => {
  for (const [file, markers] of Object.entries(MARKERS)) {
    describe(file, () => {
      const readme = readFileSync(join(README_DIR, file), 'utf8')

      const supportedStart = readme.indexOf(markers.supported)
      const unsupportedStart = readme.indexOf(markers.unsupported)

      it('contains both enumeration markers', () => {
        expect(supportedStart).toBeGreaterThan(-1)
        expect(unsupportedStart).toBeGreaterThan(-1)
        expect(unsupportedStart).toBeGreaterThan(supportedStart)
      })

      it('supported enumeration === SUPPORTED_CLAUDE_EVENTS (18)', () => {
        const section = readme.slice(supportedStart, unsupportedStart)
        const names = eventNames(section)
        expect(new Set(names)).toEqual(new Set(SUPPORTED_CLAUDE_EVENTS))
        expect(SUPPORTED_CLAUDE_EVENTS).toHaveLength(18)
      })

      it('stated unsupported count equals the enumerated unsupported names', () => {
        const section = readme.slice(unsupportedStart)
        const count = markers.unsupportedCount.exec(section)?.[1]
        expect(count).toBeDefined()
        const rest = section.slice(section.indexOf(')**') + 1)
        const end = rest.indexOf(markers.unsupportedEnd)
        const names = eventNames(end === -1 ? rest : rest.slice(0, end))
        expect(Number(count)).toBe(names.length)
        expect(names).toContain('UserPromptCancel')
        expect(Number(count)).toBe(14)
      })
    })
  }
})
