/**
 * The three document gates (design
 * docs/plans/2026-10-12-verifiable-workspace-agent.md §4.3).
 *
 * Artifact-set derivation is P2b's job: these gates take an explicit file
 * list (already whitelist-filtered) plus the workspace root.
 *
 * - Gate A (links): relative markdown links, in-file anchors (heading
 *   slugs), and in-repo paths resolve. Pure in-repo checks, zero external
 *   dependencies.
 * - Gate B (style): FIXED `abstained` at P2 — no runnable ruleset exists in
 *   this repo (neither an English vale-class ruleset nor a Chinese de-AI
 *   ruleset); the interface is reserved and only enters the "three gates
 *   pass" predicate once D3's language declaration lands with in-repo
 *   rulesets (§4.3).
 * - Gate C (exec): frozen fenced-language table — bash dry-parse (`bash
 *   -n`); ts/js via a minimal `tsc --noEmit --skipLibCheck` per-snippet
 *   check on an ephemeral file; anything else abstains with detail. The
 *   execution surface is INJECTED (small executor interface); ctx.shell
 *   wiring lands in P2b.
 *
 * Aggregation (§4.3): a per-gate timeout (default 30s, configurable) makes
 * that gate `abstained` (never silent); any fail => overall fail;
 * `missing` = the gate did not run (detail required). Structured results go
 * only into the receipt's gates[] row.
 *
 * @module @dsh-cc/vwa-evidence/gates
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GateEntry, GateStatus } from './receipt.ts'

/** Injected execution surface (§4.3) — the harness ShellExecutor seam. */
export type Executor = (
  cmd: string,
  args: string[],
  cwd: string,
) => Promise<{ code: number; stdout: string; stderr: string }>

export interface GateOptions {
  timeoutMs?: number
  /** Omit a gate here to report it as `missing` (gate did not run). */
  skip?: ('link' | 'style' | 'exec')[]
}

export const DEFAULT_GATE_TIMEOUT_MS = 30_000

/** Run one gate body under the per-gate timeout; timeout/throw => abstained (never silent). */
async function withTimeout(
  gate: GateEntry['gate'],
  timeoutMs: number,
  body: () => Promise<{ status: GateStatus; detail?: string }>,
): Promise<GateEntry> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      body(),
      new Promise<{ status: GateStatus; detail: string }>(resolve => {
        timer = setTimeout(() => resolve({ status: 'abstained', detail: `gate ${gate} timed out after ${timeoutMs}ms` }), timeoutMs)
      }),
    ])
    return { gate, ...result }
  } catch (error) {
    // Design §4.3/§5 DoD case 2: a runner that cannot even spawn means the
    // gate DID NOT run — that is `missing` with detail, not the abstained
    // timeout/error family.
    if (/ENOENT|not found|command not found/i.test(String(error))) {
      return { gate, status: 'missing', detail: `gate ${gate} did not run: runner unavailable (${String(error).slice(0, 200)})` }
    }
    return { gate, status: 'abstained', detail: `gate ${gate} errored: ${String(error)}` }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Gate A: links / anchors / in-repo paths
// ---------------------------------------------------------------------------

/** Inline `[text](target)` and images `![alt](target)`; not autolinks/refs beyond definition targets. */
const LINK_RE = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
/** Reference definitions `[id]: target`. */
const REF_DEF_RE = /^\s{0,3}\[[^\]]+\]:\s*(\S+)/gm
/** ATX headings for anchor slugs. */
const HEADING_RE = /^#{1,6}\s+(.+?)\s*#*\s*$/gm

/** GitHub-style heading slug (lowercase, punctuation stripped, spaces to dashes). */
export function headingSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-')
}

/** Strip the `#fragment` from a link target; returns [pathPart, fragment]. */
function splitAnchor(target: string): [string, string] {
  const hash = target.indexOf('#')
  if (hash < 0) return [target, '']
  return [target.slice(0, hash), target.slice(hash + 1)]
}

function externalTarget(target: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)
}

function resolveTarget(workspaceRoot: string, fromFile: string, pathPart: string): string {
  const dir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : ''
  return join(workspaceRoot, ...dir.split('/').filter(Boolean), ...pathPart.split('/').filter(p => p !== '.'))
    .replace(/\/$/, '')
}

async function gateABody(files: readonly string[], workspaceRoot: string): Promise<{ status: GateStatus; detail?: string }> {
  const fs = await import('node:fs/promises')
  const failures: string[] = []
  const slugsByFile = new Map<string, Set<string>>()
  for (const file of files) {
    const text = await fs.readFile(join(workspaceRoot, file), 'utf8').catch(() => '')
    slugsByFile.set(file, new Set([...text.matchAll(HEADING_RE)].map(m => headingSlug(m[1] ?? ''))))
  }
  const checkTarget = async (fromFile: string, target: string): Promise<void> => {
    const [pathPart, fragment] = splitAnchor(target)
    if (pathPart === '') {
      // In-file anchor.
      const slugs = slugsByFile.get(fromFile)
      if (fragment !== '' && !(slugs?.has(fragment) ?? false)) {
        failures.push(`${fromFile}: anchor #${fragment} does not resolve`)
      }
      return
    }
    const abs = resolveTarget(workspaceRoot, fromFile, pathPart)
    const rel = abs.slice(workspaceRoot.length + 1).replace(/\\/g, '/')
    let ok = false
    try {
      await fs.access(abs)
      ok = true
    } catch {
      ok = false
    }
    if (!ok) {
      failures.push(`${fromFile}: link target ${target} does not resolve in-repo`)
      return
    }
    if (fragment !== '' && /\.mdx?$/i.test(rel)) {
      const slugs = slugsByFile.get(rel) ?? new Set(
        [...(await fs.readFile(abs, 'utf8').catch(() => '')).matchAll(HEADING_RE)].map(m => headingSlug(m[1] ?? '')),
      )
      if (!slugs.has(fragment)) failures.push(`${fromFile}: anchor #${fragment} missing in ${rel}`)
    }
  }
  for (const file of files) {
    const text = await fs.readFile(join(workspaceRoot, file), 'utf8').catch(() => '')
    const targets = [...[...text.matchAll(LINK_RE)].map(m => m[1] ?? ''), ...[...text.matchAll(REF_DEF_RE)].map(m => m[1] ?? '')]
    for (const target of targets) {
      if (externalTarget(target)) continue
      await checkTarget(file, target)
    }
  }
  if (failures.length > 0) return { status: 'fail', detail: failures.slice(0, 20).join('; ') }
  return { status: 'pass' }
}

// ---------------------------------------------------------------------------
// Gate C: executability of fenced code blocks
// ---------------------------------------------------------------------------

/** Frozen fenced-language table (§4.3). */
const FENCED_RE = /^([ \t]*)(`{3,}|~{3,})[ \t]*([A-Za-z0-9_+#.-]*)[^\n]*\n([\s\S]*?)^\1\2[ \t]*$/gm

interface Snippet {
  lang: string
  code: string
  file: string
  line: number
}

function extractSnippets(text: string, file: string): Snippet[] {
  const out: Snippet[] = []
  let match: RegExpExecArray | null
  while ((match = FENCED_RE.exec(text)) !== null) {
    const lang = (match[3] ?? '').toLowerCase()
    const code = match[4] ?? ''
    if (code.trim().length === 0) continue
    out.push({ lang, code, file, line: text.slice(0, match.index).split('\n').length })
  }
  return out
}

const LANG_NORM: Record<string, string> = {
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  ts: 'ts',
  typescript: 'ts',
  js: 'js',
  javascript: 'js',
  tsx: 'ts',
  jsx: 'js',
  mjs: 'js',
  cjs: 'js',
}

/** TS/Jest-free per-snippet check invocation: keep it minimal (§4.3). */
const TSC_ARGS = ['--noEmit', '--skipLibCheck', '--target', 'es2022', '--module', 'esnext', '--moduleResolution', 'bundler']

async function gateCBody(
  files: readonly string[],
  workspaceRoot: string,
  exec: Executor,
): Promise<{ status: GateStatus; detail?: string }> {
  const fs = await import('node:fs/promises')
  const runnable: Snippet[] = []
  const skippedLangs = new Set<string>()
  for (const file of files) {
    const text = await fs.readFile(join(workspaceRoot, file), 'utf8').catch(() => '')
    for (const raw of extractSnippets(text, file)) {
      const lang = LANG_NORM[raw.lang] ?? raw.lang
      if (lang === 'bash' || lang === 'ts' || lang === 'js') runnable.push({ ...raw, lang })
      else skippedLangs.add(lang === '' ? '(none)' : lang)
    }
  }
  const failures: string[] = []
  // DoD case 2 (§4.3/§5): a runner that cannot even spawn (ENOENT) means this
  // gate did not RUN at all — surface as `missing` with detail at gate level,
  // not as per-snippet failures. A real nonzero exit remains a gate verdict.
  const runnerMissing: string[] = []
  const runsig = (error: unknown): boolean => /ENOENT|not found|command not found/i.test(String(error))
  for (const snippet of runnable) {
    if (snippet.lang === 'bash') {
      const result = await exec('bash', ['-n', '-c', snippet.code], workspaceRoot).catch(error => {
        if (runsig(error)) {
          runnerMissing.push(`${snippet.file}:${snippet.line} bash spawn`)
          return null
        }
        return { code: -1, stdout: '', stderr: String(error) }
      })
      if (result === null) continue
      if (result.code !== 0) {
        failures.push(`${snippet.file}:${snippet.line} bash -n failed: ${result.stderr.trim().slice(0, 200)}`)
      }
      continue
    }
    // ts/js: ephemeral file + minimal tsc --noEmit class check.
    const dir = await mkdtemp(join(tmpdir(), 'vwa-gatec-'))
    try {
      const ext = snippet.lang === 'ts' ? 'ts' : 'mjs'
      const snippetPath = join(dir, `snippet.${ext}`)
      await writeFile(snippetPath, snippet.code, 'utf8')
      const result = await exec('npx', ['tsc', ...TSC_ARGS, snippetPath], dir).catch(error => {
        if (runsig(error)) {
          runnerMissing.push(`${snippet.file}:${snippet.line} tsc spawn`)
          return null
        }
        return { code: -1, stdout: '', stderr: String(error) }
      })
      if (result === null) continue
      if (result.code !== 0) {
        failures.push(`${snippet.file}:${snippet.line} tsc failed: ${(result.stderr || result.stdout).trim().slice(0, 200)}`)
      }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
  if (runnerMissing.length > 0) {
    return { status: 'missing', detail: `gate exec did not run: runner unavailable (${runnerMissing.slice(0, 3).join('; ')})` }
  }
  const parts: string[] = []
  if (skippedLangs.size > 0) parts.push(`abstained languages: ${[...skippedLangs].sort().join(', ')}`)
  if (failures.length > 0) return { status: 'fail', detail: [...parts, ...failures.slice(0, 10)].join('; ') }
  return parts.length > 0 ? { status: 'pass', detail: parts.join('; ') } : { status: 'pass' }
}

// ---------------------------------------------------------------------------
// Gate B + aggregation
// ---------------------------------------------------------------------------

/**
 * Gate B style: fixed `abstained` at P2 (§4.3) — reserved interface. A
 * runnable ruleset (vale-class English rules / Chinese de-AI ruleset)
 * arrives with D3's language declaration; until then this gate never
 * contributes pass or fail to the "three gates pass" predicate.
 */
export function gateBStyle(): GateEntry {
  return {
    gate: 'style',
    status: 'abstained',
    detail: 'no runnable style ruleset exists in this repo at P2 (design §4.3); interface reserved for D3',
  }
}

/** Run all three gates over the explicit file list; results go to receipt gates[]. */
export async function runGates(
  files: readonly string[],
  workspaceRoot: string,
  exec: Executor,
  opts: GateOptions = {},
): Promise<GateEntry[]> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS
  const skip = new Set(opts.skip ?? [])
  const results: GateEntry[] = []
  results.push(
    skip.has('link')
      ? { gate: 'link', status: 'missing', detail: 'gate did not run (skipped)' }
      : await withTimeout('link', timeoutMs, () => gateABody(files, workspaceRoot)),
  )
  results.push(
    skip.has('style')
      ? { gate: 'style', status: 'missing', detail: 'gate did not run (skipped)' }
      : { gate: 'style', status: 'abstained', detail: 'no runnable style ruleset exists in this repo at P2 (design §4.3); interface reserved for D3' },
  )
  results.push(
    skip.has('exec')
      ? { gate: 'exec', status: 'missing', detail: 'gate did not run (skipped)' }
      : await withTimeout('exec', timeoutMs, () => gateCBody(files, workspaceRoot, exec)),
  )
  return results
}
