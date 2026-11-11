/**
 * Output-style model, frontmatter parsing, and file loading for
 * `@dsh-cc/output-styles`.
 *
 * A style is a named, human-selected communication contract contributed to the
 * system prompt. `default` contributes nothing; built-in styles supply prose;
 * user- and project-authored styles are loaded from `output-styles/*.md`
 * directories whose file names become the style names.
 *
 * @module @dsh-cc/output-styles/styles
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

/** Name of the no-op style: no extra section is contributed. */
export const DEFAULT_OUTPUT_STYLE = 'default'

/** One selectable output style. */
export interface OutputStyle {
  /** Style name; also the contracted cross-session key. */
  readonly name: string
  /** Human-readable summary shown in discovery and command output. */
  readonly description: string
  /** The system-prompt prose contributed while this style is active. */
  readonly prompt: string
  /** Whether this is a harness-shipped (not user- or project-authored) style. */
  readonly builtin: boolean
  /**
   * Whether the harness's default coding-instruction section is retained
   * alongside this style's prose. When false, the contributed section states
   * that it replaces the default coding instructions.
   */
  readonly keepCodingInstructions: boolean
}

/** Explanatory: narrate implementation choices and codebase patterns. */
const EXPLANATORY_STYLE: OutputStyle = {
  name: 'Explanatory',
  description: 'Explain implementation choices and codebase patterns',
  builtin: true,
  keepCodingInstructions: true,
  prompt: [
    'Explain the implementation choices and codebase patterns you rely on as you work, so the user follows your reasoning.',
    'Cover why an approach was chosen, the design decisions behind changed code, and how the change fits existing conventions. Keep explanations concise and tied to the task; do not pad them with general commentary.',
  ].join('\n'),
}

/** Learning: collaborate hands-on, requesting practice contributions. */
const LEARNING_STYLE: OutputStyle = {
  name: 'Learning',
  description: 'Collaborative teaching that learns through hands-on practice',
  builtin: true,
  keepCodingInstructions: true,
  prompt: [
    'Work as a collaborative tutor. Break the task into steps and invite the user to write small pieces of code themselves for hands-on practice, especially where the solution has multiple valid approaches or meaningful design decisions.',
    'Before requesting a contribution, place a single TODO(human) marker in the code that names the exact function or section to implement. Request only one practice contribution at a time, then stop and wait for the user\'s implementation before continuing.',
  ].join('\n'),
}

/** Built-in styles in canonical registration order. */
export const BUILTIN_STYLES: readonly OutputStyle[] = [
  { name: DEFAULT_OUTPUT_STYLE, description: 'Default output style', prompt: '', builtin: true, keepCodingInstructions: true },
  EXPLANATORY_STYLE,
  LEARNING_STYLE,
]

/**
 * The lead line contributed when an active custom style replaces the default
 * coding-instruction section (`keep-coding-instructions: false`). Kept as a
 * constant so package tests pin the model-visible contract verbatim.
 */
export const REPLACES_CODING_INSTRUCTIONS =
  'This output style defines the coding instructions for this session and replaces the default coding-instruction section.'

/** Locate the closing `---` of a markdown frontmatter block. */
function findClosingFrontmatter(raw: string, start: number): { start: number; bodyStart: number } | undefined {
  let lineStart = start
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    const line = raw.slice(lineStart, lineEnd).replace(/\r$/, '')
    if (line === '---') {
      return { start: lineStart, bodyStart: nextNewline < 0 ? raw.length : nextNewline + 1 }
    }
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
}

/**
 * Parse a custom style's frontmatter. The file name (without `.md`) is the
 * style name; frontmatter must provide a non-empty `description`; the optional
 * `keep-coding-instructions` boolean (or `'true'`/`'false'` string) defaults
 * to true. Any other shape fails loud.
 * @param fileName - the style's markdown file name (with `.md`), giving the style name.
 * @param raw - the file's full text.
 * @returns the parsed custom style.
 * @throws when the file has no frontmatter, the frontmatter is not a plain
 * object, or `description` is missing or empty.
 */
export function parseCustomStyle(fileName: string, raw: string): OutputStyle {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) throw new Error('output-style file has no YAML frontmatter')
  const firstLine = raw.slice(0, firstLineEnd).replace(/\r$/, '')
  if (firstLine !== '---') throw new Error('output-style file has no YAML frontmatter')
  const start = firstLineEnd + 1
  const closing = findClosingFrontmatter(raw, start)
  if (closing === undefined) throw new Error('output-style file has no YAML frontmatter')
  let data: unknown
  try {
    data = parseYaml(raw.slice(start, closing.start))
  } catch (error) {
    throw new Error(`output-style frontmatter is not valid YAML: ${String(error)}`, { cause: error })
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('output-style frontmatter must be a map of keys')
  }
  const fields = data as Record<string, unknown>
  const description = typeof fields['description'] === 'string' && fields['description'].trim().length > 0
    ? fields['description'].trim()
    : undefined
  if (description === undefined) {
    throw new Error('output-style frontmatter requires a non-empty description')
  }
  const rawKeep = fields['keep-coding-instructions']
  const keepCodingInstructions = rawKeep === true || rawKeep === 'true'
    ? true
    : rawKeep === false || rawKeep === 'false'
      ? false
      : true
  const name = fileName.replace(/\.md$/i, '')
  return {
    name,
    description,
    prompt: raw.slice(closing.bodyStart).trim(),
    builtin: false,
    keepCodingInstructions,
  }
}

/** Whether a directory entry is a markdown output-style file. */
function isMarkdown(entry: string): boolean {
  return entry.endsWith('.md')
}

/**
 * Read every markdown output-style file across the given directories, in
 * order, deduplicating by style name so a later directory overrides an earlier
 * same-named style. Missing directories contribute nothing.
 * @param dirs - directories to scan; later entries override earlier ones.
 * @returns the loaded custom styles in directory order.
 */
export async function loadCustomStyles(dirs: readonly string[]): Promise<OutputStyle[]> {
  const byName = new Map<string, OutputStyle>()
  for (const dir of dirs) {
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      // A missing or transiently unreadable directory is an ordinary empty
      // source, not a load failure.
      continue
    }
    for (const entry of entries.sort()) {
      if (!isMarkdown(entry)) continue
      const style = parseCustomStyle(entry, await readFile(join(dir, entry), 'utf8'))
      byName.set(style.name, style)
    }
  }
  return [...byName.values()]
}

/**
 * Assemble the selectable library: built-in styles first, then custom styles
 * overlaid by name so a project- or user-authored style shadows a built-in.
 * @param custom - the loaded custom styles.
 * @returns a name-keyed, insertion-ordered library.
 */
export function buildStyleLibrary(custom: readonly OutputStyle[]): Map<string, OutputStyle> {
  const library = new Map(BUILTIN_STYLES.map(style => [style.name, style]))
  for (const style of custom) library.set(style.name, style)
  return library
}

/**
 * Render one style's contributed system-prompt section. The default style and
 * any style with no prompt contribute nothing; a custom style that replaces
 * the default coding instructions carries an explicit lead-in.
 * @param style - the active style.
 * @returns the model-visible section text, or `''` when nothing is contributed.
 */
export function styleSectionText(style: OutputStyle): string {
  if (style.name === DEFAULT_OUTPUT_STYLE || style.prompt.length === 0) return ''
  if (style.keepCodingInstructions === false) {
    return `${REPLACES_CODING_INSTRUCTIONS}\n\n${style.prompt}`
  }
  return style.prompt
}
