import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BUILTIN_STYLES,
  DEFAULT_OUTPUT_STYLE,
  buildStyleLibrary,
  loadCustomStyles,
  parseCustomStyle,
} from '../src/styles.ts'

describe('built-in output styles', () => {
  it('provides default, Explanatory, and Learning with distinct semantics', () => {
    const names = BUILTIN_STYLES.map(style => style.name)
    expect(names).toEqual([DEFAULT_OUTPUT_STYLE, 'Explanatory', 'Learning'])

    const byName = new Map(BUILTIN_STYLES.map(style => [style.name, style]))
    const d = byName.get('default')!
    expect(d.prompt).toBe('')
    expect(d.builtin).toBe(true)
    expect(d.keepCodingInstructions).toBe(true)

    const explanatory = byName.get('Explanatory')!
    expect(explanatory.builtin).toBe(true)
    expect(explanatory.keepCodingInstructions).toBe(true)
    expect(explanatory.description.toLowerCase()).toContain('explain')
    expect(explanatory.prompt.length).toBeGreaterThan(0)
    // Explanatory explains implementation choices, without teaching-exercise markers.
    expect(explanatory.prompt.toLowerCase()).toContain('implementation')
    expect(explanatory.prompt.toLowerCase()).not.toContain('todo(human)')

    const learning = byName.get('Learning')!
    expect(learning.builtin).toBe(true)
    expect(learning.keepCodingInstructions).toBe(true)
    expect(learning.description.toLowerCase()).toContain('learn')
    // Learning is collaborative teaching that requests hands-on contribution markers.
    expect(learning.prompt.toLowerCase()).toContain('todo(human)')
    expect(learning.prompt).not.toBe(explanatory.prompt)
  })
})

describe('parseCustomStyle', () => {
  it('uses the file name as the style name and captures the body as the prompt', () => {
    const style = parseCustomStyle('concise.md', [
      '---',
      'description: Short and to the point.',
      '---',
      'Keep answers concise.',
      '',
    ].join('\n'))
    expect(style.name).toBe('concise')
    expect(style.description).toBe('Short and to the point.')
    expect(style.prompt).toBe('Keep answers concise.')
    expect(style.builtin).toBe(false)
    expect(style.keepCodingInstructions).toBe(true)
  })

  it('parses keep-coding-instructions as booleans and strings, defaulting to true', () => {
    const absent = parseCustomStyle('a.md', [
      '---',
      'description: no flag',
      '---',
      'body',
    ].join('\n'))
    expect(absent.keepCodingInstructions).toBe(true)

    const kept = parseCustomStyle('b.md', [
      '---',
      'description: keep',
      'keep-coding-instructions: true',
      '---',
      'body',
    ].join('\n'))
    expect(kept.keepCodingInstructions).toBe(true)

    const replaced = parseCustomStyle('c.md', [
      '---',
      'description: replace',
      'keep-coding-instructions: false',
      '---',
      'body',
    ].join('\n'))
    expect(replaced.keepCodingInstructions).toBe(false)
  })

  it.each([
    ['rejects a file with no frontmatter', 'just some text', 'frontmatter'],
    ['rejects malformed YAML', '---\nname: [unclosed\n---\nbody', 'frontmatter'],
    ['rejects a frontmatter array', '---\n- a\n- b\n---\nbody', 'frontmatter'],
    ['rejects empty frontmatter', '---\n---\nbody', 'frontmatter'],
  ])('%s', (_label, raw, needle) => {
    expect(() => parseCustomStyle('x.md', raw)).toThrow(needle)
  })

  it('fails loud when description is missing or empty', () => {
    expect(() => parseCustomStyle('x.md', '---\ndescription: \n---\nbody')).toThrow(/description/i)
  })
})

describe('loadCustomStyles', () => {
  async function withDirs(files: Array<{ dir: string; file: string; content: string }>): Promise<string[]> {
    const root = await mkdtemp(join(tmpdir(), 'cc-output-styles-'))
    const dirs = new Set(files.map(file => file.dir))
    for (const dir of dirs) await mkdir(join(root, dir), { recursive: true })
    for (const file of files) await writeFile(join(root, file.dir, file.file), file.content)
    return [...dirs].map(dir => join(root, dir))
  }

  it('loads every .md file in each directory with the file name as the style name', async () => {
    const dirs = await withDirs([
      { dir: 'project', file: 'concise.md', content: '---\ndescription: Short.\n---\nBe concise.' },
      { dir: 'project', file: 'verbose.md', content: '---\ndescription: Long.\n---\nBe thorough.' },
    ])
    const styles = await loadCustomStyles(dirs)
    expect(styles.map(style => style.name).sort()).toEqual(['concise', 'verbose'])
    expect(styles.find(style => style.name === 'concise')?.prompt).toBe('Be concise.')
  })

  it('lets a later directory override a same-named earlier style', async () => {
    const dirs = await withDirs([
      { dir: 'harness', file: 'concise.md', content: '---\ndescription: v1.\n---\nFirst.' },
      { dir: 'project', file: 'concise.md', content: '---\ndescription: v2.\n---\nSecond.' },
    ])
    const styles = await loadCustomStyles(dirs)
    const stylesByName = new Map(styles.map(style => [style.name, style]))
    expect(stylesByName.get('concise')?.prompt).toBe('Second.')
  })

  it('skips directories that do not exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-output-styles-'))
    const styles = await loadCustomStyles([join(root, 'missing')])
    expect(styles).toEqual([])
  })
})

describe('buildStyleLibrary', () => {
  it('seeds built-ins and overlays custom styles by name', () => {
    const library = buildStyleLibrary([
      { name: 'concise', description: 'Short.', prompt: 'Be concise.', builtin: false, keepCodingInstructions: true },
    ])
    expect(library.get('default')?.prompt).toBe('')
    expect(library.get('Explanatory')).toBeDefined()
    expect(library.get('Learning')).toBeDefined()
    expect(library.get('concise')?.name).toBe('concise')
  })

  it('lets a custom style shadow a same-named built-in', () => {
    const library = buildStyleLibrary([
      { name: 'Explanatory', description: 'Mine.', prompt: 'Custom explanatory.', builtin: false, keepCodingInstructions: false },
    ])
    const explanatory = library.get('Explanatory')!
    expect(explanatory.prompt).toBe('Custom explanatory.')
    expect(explanatory.keepCodingInstructions).toBe(false)
  })
})
