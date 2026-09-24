/**
 * Diagnostics pull + render (design doc §4.2/§4.5): one uncached
 * `get_diagnostics_for_file` call through the mcpConnections registry (never
 * the tools waterfall — recursion banned by construction), then parse the
 * grouped map and render the compact `[lsp]` block.
 *
 * @module
 */

import { isAbsolute, join, relative } from 'node:path'
import type { McpConnectionsService } from '@dsh-cc/mcp-client'
import type { LspOnWriteSettings } from './settings.ts'

/** Serena's `get_diagnostics_for_file` raw tool name. */
export const DIAGNOSTICS_TOOL = 'get_diagnostics_for_file'

/** Total byte cap of the rendered `[lsp]` block (doc §4.5). */
export const BLOCK_CAP_BYTES = 4096

/** One serena diagnostic (0-based range, runtime-verified shape, doc §4.2). */
export interface LspDiagnostic {
  message: string
  range: { start: { line: number; character: number } }
  code?: string | number
  source?: string
  /** The severity group the diagnostic was nested under ("Error"|"Warning"|…). */
  severity: string
}

/** Serena's grouped map: relative_path → severity → name_path → diagnostics. */
export type DiagnosticsMap = Record<string, Record<string, Record<string, LspDiagnostic[]>>>

/** A successfully pulled-and-parsed diagnostics payload for one file. */
export interface PulledDiagnostics {
  /** The relative path serena keyed the map by. */
  relativePath: string
  diagnostics: LspDiagnostic[]
}

/**
 * Pull diagnostics for one file from `serverName` through the registry.
 * Throws on absent server, disconnected connection, MCP error, timeout, or
 * schema drift — the caller (wiring) treats every throw as a drop.
 */
export async function pullDiagnostics(
  registry: McpConnectionsService,
  serverName: string,
  filePath: string,
  sessionCwd: string,
  settings: LspOnWriteSettings,
  signal: AbortSignal,
): Promise<PulledDiagnostics> {
  const absolute = isAbsolute(filePath) ? filePath : join(sessionCwd, filePath)
  const relativePath = relative(sessionCwd, absolute)
  // min_severity: LSP 1=error, 2=error+warning (doc §4.2).
  const minSeverity = settings.minSeverity === 'error' ? 1 : 2
  const result = await registry.callTool(
    serverName,
    DIAGNOSTICS_TOOL,
    { relative_path: relativePath, start_line: 0, end_line: -1, min_severity: minSeverity },
    { timeoutMs: settings.timeoutMs, signal },
  )
  return { relativePath, diagnostics: parseDiagnostics(result) }
}

/**
 * Parse the callTool result: concatenate text blocks and `JSON.parse`.
 * Envelope-level schema drift THROWS (absent content blocks, absent text,
 * invalid JSON, non-object payload) — the caller (wiring) counts it as a
 * drop (doc §4.2/§5). A legitimately empty diagnostics map (`{}`) is NOT
 * drift and parses to an empty list. Inner groups are skipped tolerantly.
 */
export function parseDiagnostics(result: Record<string, unknown>): LspDiagnostic[] {
  const content = (result as { content?: unknown }).content
  if (!Array.isArray(content)) throw new Error('schema drift: tools/call result has no content blocks')
  const text = content
    .map((block) => (typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text'
      ? (block as { text?: unknown }).text
      : undefined))
    .filter((t): t is string => typeof t === 'string')
    .join('')
  if (text.length === 0) throw new Error('schema drift: tools/call result has no text blocks')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('schema drift: diagnostics payload is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('schema drift: diagnostics payload is not the serena grouped map')
  }
  const diagnostics: LspDiagnostic[] = []
  for (const severityGroups of Object.values(parsed as DiagnosticsMap)) {
    if (typeof severityGroups !== 'object' || severityGroups === null) continue
    for (const [severity, namePaths] of Object.entries(severityGroups)) {
      if (typeof namePaths !== 'object' || namePaths === null) continue
      for (const group of Object.values(namePaths)) {
        if (!Array.isArray(group)) continue
        for (const diag of group) {
          if (isDiagnostic(diag)) diagnostics.push({ ...diag, severity })
        }
      }
    }
  }
  return diagnostics
}


function isDiagnostic(value: unknown): value is LspDiagnostic {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<LspDiagnostic>
  return typeof candidate.message === 'string'
    && typeof candidate.range === 'object' && candidate.range !== null
    && typeof candidate.range.start === 'object' && candidate.range.start !== null
    && typeof candidate.range.start.line === 'number'
}

/**
 * Render the compact `[lsp]` block (doc §4.5): errors before warnings,
 * 1-based line:col, E/W prefix + code, `maxDiagnostics` entries, 4 KB cap
 * with a reconciled `… (N more)` suffix. Empty diagnostics → no block.
 */
export function renderDiagnosticsBlock(pulled: PulledDiagnostics, settings: LspOnWriteSettings): string | undefined {
  // Severity filter (doc §4.5): errors always; warnings only at the default
  // 'warning' floor. Information/Hint never render.
  const all = pulled.diagnostics.filter((diag) => {
    const severity = diag.severity.toLowerCase()
    return severity === 'error' || (severity === 'warning' && settings.minSeverity === 'warning')
  })
  if (all.length === 0) return undefined
  const lines = [...all]
    .sort((a, b) => severityRank(a) - severityRank(b) || a.range.start.line - b.range.start.line)
    .slice(0, Math.max(0, settings.maxDiagnostics))
    .map((diag) => {
      const letter = severityRank(diag) === 0 ? 'E' : 'W'
      const code = diag.code === undefined ? '' : String(diag.code)
      const prefix = `${letter}${code}`
      const line = diag.range.start.line + 1
      const col = diag.range.start.character + 1
      return `  ${prefix} ${line}:${col} ${diag.message}`.replace(/\s+$/, '')
    })
  const header = `[lsp] ${pulled.relativePath}: ${all.length} problems`
  // Counts always reconcile (doc §4.5): whenever entries are hidden — by
  // maxDiagnostics or by the byte cap — a `… (N more)` suffix says so.
  const suffix = (shown: number): string => (shown < all.length ? `\n… (${all.length - shown} more)` : '')
  const assemble = (kept: string[]): string => [header, ...kept].join('\n') + suffix(kept.length)
  const body = assemble(lines)
  if (Buffer.byteLength(body, 'utf8') <= BLOCK_CAP_BYTES) return body
  // Over the byte cap: drop rendered lines until the block fits.
  let kept = lines
  while (kept.length > 0) {
    const candidate = assemble(kept)
    if (Buffer.byteLength(candidate, 'utf8') <= BLOCK_CAP_BYTES) return candidate
    kept = kept.slice(0, -1)
  }
  return header + suffix(0)
}

/** Errors (rank 0) sort before warnings (rank 1); other severities follow warnings. */
function severityRank(diag: LspDiagnostic): number {
  return diag.severity.toLowerCase() === 'error' ? 0 : 1
}
