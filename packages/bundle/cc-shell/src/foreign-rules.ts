/**
 * Foreign rules/context import beyond the Cursor dialect (plan
 * docs/plans/2026-09-23-small-picks-batch.md §C7): harvest other agents' rule
 * files from the session cwd — cline `.clinerules`, windsurf
 * `.windsurfrules` / `.windsurf/rules/*.md`, copilot
 * `.github/copilot-instructions.md` / `.github/instructions/*.instructions.md`
 * — and render them into a `cc:foreign-rules` system-prompt section
 * (order 107, immediately after `cc:plugin-rules`).
 *
 * Discovery roots: the session cwd only (`process.cwd()`, the same source
 * `CcPluginsService` uses) — no parent walk, no symlink traversal
 * (`lstat`-filtered), vendored directories never matched. Caps mirror the
 * rulesSeam §7 budget idiom: 4000 chars per file (truncate + explicit tail +
 * one-time warn), 8 files per provider, 12000 chars for the whole section.
 * Opt-out via the `cc-foreign-rules` settings namespace (`disabled` provider
 * list), read live at discovery time. Discovery is lazy-once per spawn:
 * computed inside the section's `text()` callback on its first call and
 * memoized for that closure; no file watcher.
 *
 * @module
 */

import { globSync, lstatSync, readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { registerNamespaceSafe } from '@dsh-cc/settings-ns'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'

/** Name of the system-prompt section this module owns. */
export const FOREIGN_RULES_SECTION_NAME = 'cc:foreign-rules'

/** Prompt order of the foreign-rules section (after cc:plugin-rules, 106). */
export const FOREIGN_RULES_SECTION_ORDER = 107

/** Settings namespace carrying the provider opt-out (branded idiom). */
export const FOREIGN_RULES_SETTINGS_NAMESPACE = 'cc-foreign-rules' as SettingsNamespace

/** The live opt-out shape (read at discovery time, never cached). */
export interface ForeignRulesSettings {
  disabled: readonly ('cline' | 'windsurf' | 'copilot')[]
}

/** Namespace schema: `{ disabled: [...] }`, empty by default. The vendored
 * schemastery has no `z.enum`, so the three providers are spelled as a union
 * of `z.const` members (same acceptance, same /config shape). */
export const ForeignRulesSettingsSchema: z<ForeignRulesSettings> = z.object({
  disabled: z.array(z.union([z.const('cline'), z.const('windsurf'), z.const('copilot')])).default([]),
}) as unknown as z<ForeignRulesSettings>

/** Prompt cap per harvested file (the RULES_BUDGET_CAP_CHARS idiom). */
export const FOREIGN_FILE_CAP_CHARS = 4000

/** Maximum files harvested per provider. */
export const FOREIGN_FILES_PER_PROVIDER = 8

/** Prompt cap for the whole section. */
export const FOREIGN_SECTION_CAP_CHARS = 12_000

/** Explicit tail appended to truncated text (rulesSeam idiom). */
const TRUNCATION_TAIL = '\n... (truncated)'

/** Directories that are never matched during discovery. */
const IGNORED_DIRS = ['node_modules', '.git', 'vendor', 'dist', 'build', 'coverage']

/** One provider: its id and the cwd-relative globs that carry its rules. */
interface ProviderSpec {
  id: 'cline' | 'windsurf' | 'copilot'
  globs: readonly string[]
}

/** The exactly-3-providers / 5-globs discovery table. */
const PROVIDERS: readonly ProviderSpec[] = [
  { id: 'cline', globs: ['.clinerules'] },
  { id: 'windsurf', globs: ['.windsurfrules', '.windsurf/rules/*.md'] },
  { id: 'copilot', globs: ['.github/copilot-instructions.md', '.github/instructions/*.instructions.md'] },
]

/** One harvested rule file. */
export interface ForeignRuleFile {
  /** Provider the file belongs to. */
  provider: ProviderSpec['id']
  /** Path relative to the discovery root (the cwd). */
  relPath: string
  /** File body, already truncated to {@link FOREIGN_FILE_CAP_CHARS}. */
  body: string
}

/**
 * Whether a cwd-relative path avoids every ignored directory segment.
 * Vendored directories are never matched, wherever they appear in the path.
 */
function isAllowed(relPath: string): boolean {
  return !relPath.split('/').some(seg => IGNORED_DIRS.includes(seg))
}

/**
 * Discover foreign rule files under `root` (the session cwd in production).
 * Returns at most {@link FOREIGN_FILES_PER_PROVIDER} files per provider,
 * each body truncated to {@link FOREIGN_FILE_CAP_CHARS} with an explicit
 * tail plus a one-time warn. Deterministic order (globs → sorted paths).
 */
export function discoverForeignRules(root: string, ctx: Context): ForeignRuleFile[] {
  const warned = new Set<string>()
  const files: ForeignRuleFile[] = []
  for (const { id, globs } of PROVIDERS) {
    let taken = 0
    for (const glob of globs) {
      if (taken >= FOREIGN_FILES_PER_PROVIDER) break
      let matches: string[]
      try {
        matches = (globSync(glob, { cwd: root }) as string[]).filter(isAllowed).sort()
      } catch {
        continue // A malformed root or unreadable directory is inert.
      }
      for (const relPath of matches) {
        if (taken >= FOREIGN_FILES_PER_PROVIDER) break
        // lstat: symlinks (and anything that is not a plain file) never match.
        let stat
        try {
          stat = lstatSync(`${root}/${relPath}`)
        } catch {
          continue
        }
        if (!stat.isFile()) continue
        let body: string
        try {
          body = readFileSync(`${root}/${relPath}`, 'utf8')
        } catch {
          continue // Unreadable file is inert.
        }
        if (body.length > FOREIGN_FILE_CAP_CHARS) {
          body = body.slice(0, Math.max(0, FOREIGN_FILE_CAP_CHARS - TRUNCATION_TAIL.length)) + TRUNCATION_TAIL
          if (!warned.has(relPath)) {
            warned.add(relPath)
            ctx.logger.warn(`cc-foreign-rules: ${relPath} exceeds the ${FOREIGN_FILE_CAP_CHARS}-character per-file budget; truncated`)
          }
        }
        files.push({ provider: id, relPath, body })
        taken += 1
      }
    }
  }
  return files
}

/**
 * Render the discovered files into section text: one block per file — header
 * `## <provider> rules (<path relative to cwd>)` followed by the verbatim
 * body — capped at {@link FOREIGN_SECTION_CAP_CHARS} chars for the whole
 * section. Returns '' when nothing was discovered (no stray headers).
 */
export function renderForeignRules(files: readonly ForeignRuleFile[]): string {
  let text = ''
  for (const f of files) {
    const block = `## ${f.provider} rules (${f.relPath})\n${f.body}`
    if (text === '') text = block
    else if (text.length + 2 + block.length <= FOREIGN_SECTION_CAP_CHARS) text += `\n\n${block}`
    else {
      const room = FOREIGN_SECTION_CAP_CHARS - text.length - 2 - TRUNCATION_TAIL.length
      if (room > 0) text += `\n\n${block.slice(0, room)}${TRUNCATION_TAIL}`
      break
    }
  }
  return text
}

/**
 * Register the settings namespace (idempotent) and return the live reader.
 * Without a settings provider the reader serves ship-on defaults (every
 * provider enabled) — graceful degradation, never throws.
 */
export function registerForeignRulesSettings(ctx: Context): () => ForeignRulesSettings {
  const read = registerNamespaceSafe<ForeignRulesSettings>(
    ctx,
    FOREIGN_RULES_SETTINGS_NAMESPACE,
    ForeignRulesSettingsSchema,
  )
  return () => read() ?? { disabled: [] }
}

/**
 * Mount the `cc:foreign-rules` section on the host `systemPrompt` service.
 * The text callback discovers lazily on its first call and memoizes for this
 * spawn; no file watcher. Nothing is logged unless content was found — one
 * consolidated debug line lists the per-provider counts.
 */
export function mountForeignRulesSection(ctx: Context): void {
  const systemPrompt = ctx.get('systemPrompt') as
    | { section(s: { name: string; order: number; text: () => string }): void }
    | undefined
  if (systemPrompt === undefined) return
  let memoized: string | undefined
  systemPrompt.section({
    name: FOREIGN_RULES_SECTION_NAME,
    order: FOREIGN_RULES_SECTION_ORDER,
    text: () => {
      if (memoized !== undefined) return memoized
      const settings = registerForeignRulesSettings(ctx)
      const disabled = new Set(settings?.().disabled ?? [])
      const root = process.cwd()
      const picked = discoverForeignRules(root, ctx).filter(f => !disabled.has(f.provider))
      const counts = new Map<string, number>()
      for (const f of picked) counts.set(f.provider, (counts.get(f.provider) ?? 0) + 1)
      if (picked.length > 0) {
        ctx.logger.debug(`cc-foreign-rules: picked up ${[...counts].map(([p, n]) => `${p}=${n}`).join(', ')}`)
      }
      memoized = renderForeignRules(picked)
      return memoized
    },
  })
}
