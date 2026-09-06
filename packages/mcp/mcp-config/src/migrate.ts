/**
 * The package's ONLY file-WRITING surface: `/mcp migrate` importing Claude
 * Code MCP servers into `$DSH_HOME/.mcp.json`.
 *
 * `migrateMcpServers` copies raw `mcpServers` entries verbatim — no env
 * expansion, no name normalization, no transport reshaping (those belong to
 * load time; round-tripping them here would corrupt the config). The Claude
 * Code source files are never modified. Existing target names always win, the
 * write is atomic (temp file + same-dir rename), and a `.bak` backup is made
 * only when an existing target is overwritten. Note the backup duplicates any
 * secrets inside `env` / `headers` entries.
 *
 * @module @dsh-cc/mcp-config/migrate
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseMcpServers, type McpServerEntry } from './index.ts'

/** Per-source migration outcome, in argument order. */
export interface McpMigrationSourceReport {
  /** The source file path. */
  path: string
  /** Server names this source contributed (empty when it failed). */
  servers: string[]
  /** Present when the source was unreadable/unparseable; its error message. */
  error?: string
}

/** Full result of one `migrateMcpServers` run. */
export interface McpMigrationResult {
  /** The migration target file. */
  target: string
  /** Server names written by this run. */
  added: string[]
  /** Names already present in the target (never overwritten). */
  kept: string[]
  /** Cross-source collisions: which source kept vs. skipped each name. */
  sourceConflicts: { name: string; kept: string; skipped: string }[]
  /** Per-source reports, in argument order. */
  sources: McpMigrationSourceReport[]
  /** `false` when nothing needed adding: no write, no backup (idempotent). */
  wrote: boolean
  /** Backup path, set only when an existing target was overwritten. */
  backup?: string
}

/**
 * Import servers from source config files into a target `.mcp.json`.
 *
 * @param options - `sources` (Claude Code config files, read independently)
 * and `target` (typically `$DSH_HOME/.mcp.json`).
 * @returns the full migration report. When nothing needs adding the target is
 * untouched and `wrote` is `false`.
 * @throws when the existing target is unparseable or its `mcpServers` fails
 * validation, or when the atomic write itself fails (the temp file is removed
 * and the error names the target path).
 */
export function migrateMcpServers(options: { sources: string[]; target: string }): McpMigrationResult {
  const { sources, target } = options

  // Target first: its existing names always win, and a broken target aborts
  // with nothing written.
  const targetExisted = existsSync(target)
  const targetRoot = readTargetRoot(target)
  const isMap = !Array.isArray(targetRoot.mcpServers)
  const existing = targetRoot.mcpServers === undefined ? {} : parseMcpServers(targetRoot)
  const written = new Map<string, McpServerEntry>(Object.entries(existing))

  const result: McpMigrationResult = {
    target,
    added: [],
    kept: [],
    sourceConflicts: [],
    sources: [],
    wrote: false,
  }

  const addedEntries: [string, McpServerEntry][] = []
  for (const path of sources) {
    let entries: Record<string, McpServerEntry>
    try {
      entries = parseMcpServers(JSON.parse(readFileSync(path, 'utf8')))
    } catch (error) {
      result.sources.push({ path, servers: [], error: (error as Error).message })
      continue
    }
    const names: string[] = []
    for (const [name, entry] of Object.entries(entries)) {
      if (targetExisted && existing[name] !== undefined) {
        if (!result.kept.includes(name)) result.kept.push(name)
        continue
      }
      if (written.has(name)) {
        // First source wins across sources; later declarations are skipped.
        const keptBy = result.sources.find(report => report.servers.includes(name))!.path
        result.sourceConflicts.push({ name, kept: keptBy, skipped: path })
        continue
      }
      written.set(name, entry)
      names.push(name)
      addedEntries.push([name, entry])
    }
    result.sources.push({ path, servers: names })
  }
  result.added = addedEntries.map(([name]) => name)

  if (addedEntries.length === 0) return result

  // Preserve the target's other top-level keys and its map-vs-array shape.
  const output: Record<string, unknown> = { ...targetRoot }
  if (isMap) {
    output.mcpServers = { ...existing, ...Object.fromEntries(addedEntries) }
  } else {
    // Array form gets exactly ONE appended group object.
    output.mcpServers = [...(targetRoot.mcpServers as Record<string, McpServerEntry>[]), Object.fromEntries(addedEntries)]
  }

  mkdirSync(dirname(target), { recursive: true })
  let backup: string | undefined
  if (targetExisted) {
    // The backup duplicates any secrets inside env/headers entries.
    backup = `${target}.bak`
    copyFileSync(target, backup)
  }
  const temp = `${target}.tmp-${process.pid}`
  try {
    writeFileSync(temp, JSON.stringify(output, null, 2) + '\n')
    renameSync(temp, target)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      // The temp file may never have been created; nothing to clean up.
    }
    throw new Error(`dsh-mcp-config: failed to write migrated config to "${target}": ${(error as Error).message}`)
  }
  result.wrote = true
  if (backup !== undefined) result.backup = backup
  return result
}

/**
 * Read and parse the target document, defaulting to `{ mcpServers: {} }` when
 * absent. A present-but-unparseable target, or one whose `mcpServers` fails
 * validation, throws with an actionable message before anything is written.
 */
function readTargetRoot(target: string): { mcpServers?: unknown } {
  if (!existsSync(target)) return { mcpServers: {} }
  let root: unknown
  try {
    root = JSON.parse(readFileSync(target, 'utf8'))
  } catch (error) {
    throw new Error(`dsh-mcp-config: migration target "${target}" is not valid JSON: ${(error as Error).message}`)
  }
  if (root === null || typeof root !== 'object' || Array.isArray(root)) {
    throw new Error(`dsh-mcp-config: migration target "${target}" must be a JSON object`)
  }
  const doc = root as { mcpServers?: unknown }
  if (doc.mcpServers !== undefined) {
    // Validate an existing mcpServers key (map or array form) before touching anything.
    parseMcpServers(doc)
  }
  return root as { mcpServers?: unknown }
}
