#!/usr/bin/env node
/**
 * Forensic audit of subagent child sessions (memory-recall hardening
 * follow-ups W2b, `docs/plans/2026-09-09-memory-recall-hardening-followups.md`
 * §2 W2(b)). Walks `~/.dsh/sessions/…/session.jsonl.zstd`, decompresses with
 * the `zstd` CLI, rebuilds parent→child trees from log headers
 * (`parentSession`, `origin: 'subagent'`, `seedLength`), and prints per-child
 * timelines of notable tool calls (branch/write/commit/push) with wall-clock
 * times.
 *
 * Flags:
 *   --session <id>  restrict to one session and its descendants
 *   --grep <substr> only children whose log mentions the substring
 *
 * Tolerates a live session file being appended mid-read: a trailing
 * truncated JSON line is skipped, not fatal.
 *
 * Plain node ESM, no dependencies beyond the `zstd` CLI.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Tools whose calls land on a child's timeline. */
const NOTABLE_TOOLS = new Set(['bash', 'write', 'edit', 'notebookedit', 'glob', 'grep'])

/** Extract the detail worth printing from a notable tool call's input. */
function toolDetail(name, input = {}) {
  const command = typeof input.command === 'string' ? input.command : undefined
  if (command !== undefined) return command
  const file = input.file_path ?? input.notebook_path ?? input.path
  if (typeof file === 'string') return file
  const pattern = input.pattern
  if (typeof pattern === 'string') return pattern
  return ''
}

/**
 * Parse one session log (already-decompressed JSONL text) into
 * `{ header, notable }`. The header is the first `type: 'session'` line;
 * `notable` lists `{ at, tool, detail }` for every notable tool call. A
 * trailing truncated line (a live file being appended mid-read) is skipped.
 */
export function collectSession(text) {
  const lines = text.split('\n').filter(line => line.length > 0)
  let header
  const notable = []
  const limit = lines.length
  for (let i = 0; i < limit; i++) {
    let entry
    try {
      entry = JSON.parse(lines[i])
    } catch {
      // Only the LAST line may be truncated (live append); a truncated line
      // anywhere else is corruption, but skipping keeps the audit usable.
      if (i === limit - 1) break
      continue
    }
    if (entry?.type === 'session' && header === undefined) header = entry
    if (entry?.type === 'assistant' && Array.isArray(entry.message?.content)) {
      for (const block of entry.message.content) {
        if (block?.type !== 'tool_use' || !NOTABLE_TOOLS.has(String(block.name).toLowerCase())) continue
        notable.push({
          at: entry.timestamp,
          tool: String(block.name),
          detail: toolDetail(String(block.name), block.input),
        })
      }
    }
  }
  if (header === undefined) throw new Error('no session header line found')
  return { header, notable }
}

/** Derive the per-child detail column: the subagent origin metadata. */
function childInfo(header) {
  return {
    id: String(header.id),
    parent: header.parentSession === undefined ? undefined : String(header.parentSession),
    origin: header.origin,
    seedLength: header.seedLength,
  }
}

/**
 * Rebuild the parent→child tree from session headers. Returns
 * `Map<parentSessionId, childSessionId[]>` with an entry (possibly empty)
 * for every session.
 */
export function buildTree(sessions) {
  const tree = new Map()
  for (const id of sessions.keys()) tree.set(id, [])
  for (const [id, session] of sessions) {
    const parent = childInfo(session.header).parent
    if (parent !== undefined && tree.has(parent)) tree.get(parent).push(id)
  }
  return tree
}

/** `--session`: the session and all its descendants (a BFS closure). */
export function descendantClosure(sessions, rootId) {
  const tree = buildTree(sessions)
  const kept = new Set([rootId])
  const queue = [rootId]
  while (queue.length > 0) {
    for (const child of tree.get(queue.shift()) ?? []) {
      if (!kept.has(child)) {
        kept.add(child)
        queue.push(child)
      }
    }
  }
  return [...kept].filter(id => sessions.has(id))
}

/** `--grep`: keep only sessions whose raw log text mentions the substring. */
export function filterSessions(sessions, substring) {
  return [...sessions.entries()]
    .filter(([, session]) => (session.raw ?? JSON.stringify(session)).includes(substring))
    .map(([id]) => id)
}

/** Format one child's timeline: header info + wall-clock notable calls. */
export function formatChildTimeline(id, session) {
  const info = childInfo(session.header)
  const lines = [
    `child ${id} (origin=${info.origin ?? 'unknown'} seedLength=${info.seedLength ?? '?'} parent=${info.parent ?? '-'})`,
  ]
  for (const call of session.notable) {
    lines.push(`  ${new Date(call.at).toISOString()} ${call.tool} ${call.detail}`.trimEnd())
  }
  return lines.join('\n')
}

/** Decompress one `.zstd` file via the zstd CLI. Throws a clear error if absent. */
function zstdAvailable() {
  const probe = spawnSync('zstd', ['--version'], { encoding: 'utf8' })
  if (probe.error !== undefined || probe.status !== 0) {
    throw new Error('the `zstd` CLI is required but was not found on PATH (install zstd, e.g. `brew install zstd`)')
  }
}

async function walkSessionFiles(root) {
  const found = []
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) found.push(...await walkSessionFiles(path))
    else if (entry.isFile() && entry.name === 'session.jsonl.zstd') found.push(path)
  }
  return found
}

/** Load every session log under `~/.dsh/sessions` into `Map<id, session>`. */
export async function loadSessions(home = join(homedir(), '.dsh', 'sessions'), zstdBin = 'zstd') {
  const files = await walkSessionFiles(home)
  const sessions = new Map()
  for (const file of files) {
    let text
    try {
      text = execFileSync(zstdBin, ['-d', '-c', file], { maxBuffer: 256 * 1024 * 1024 }).toString('utf8')
    } catch (error) {
      console.error(`audit: skipping unreadable log ${file}: ${error.message}`)
      continue
    }
    try {
      const session = collectSession(text)
      sessions.set(String(session.header.id), { ...session, raw: text, path: file })
    } catch (error) {
      console.error(`audit: skipping unparseable log ${file}: ${error.message}`)
    }
  }
  return sessions
}

/** CLI entry: parse flags, load, filter, print. */
export async function main(argv = process.argv.slice(2)) {
  let sessionFilter
  let grep
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--session') sessionFilter = argv[++i]
    else if (argv[i] === '--grep') grep = argv[++i]
  }
  zstdAvailable()
  const sessions = await loadSessions()
  let ids = [...sessions.keys()]
  if (sessionFilter !== undefined) ids = descendantClosure(sessions, sessionFilter)
  if (grep !== undefined) {
    const keep = new Set(filterSessions(sessions, grep))
    ids = ids.filter(id => keep.has(id))
  }
  const tree = buildTree(sessions)
  for (const id of ids) {
    const session = sessions.get(id)
    console.log(formatChildTimeline(id, session))
    const children = (tree.get(id) ?? []).filter(child => ids.includes(child))
    if (children.length > 0) console.log(`  children: ${children.join(', ')}`)
  }
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  await main()
}
