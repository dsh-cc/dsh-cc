#!/usr/bin/env node
/**
 * check-file-size.mjs — shunt PreToolUse gate for the Read tool.
 *
 * Blocks whole-file reads of large files and redirects to the bulk-reader
 * skill (cheap-lane subagent delegation), keeping bulk file content out of
 * the main context. Port of the upstream shunt bash+jq hook as a
 * dependency-free Node script.
 *
 * Allow contract: {"decision": "allow"} on stdout, exit 0.
 * Block contract: one-line {"decision": "block", "reason": "..."} on stdout, exit 0.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs'

const DEFAULT_MIN_LINES = 350
const DEFAULT_MAX_BYTES = 100000

function truthy(v) {
  return ['1', 'true', 'yes'].includes(String(v ?? '').trim().toLowerCase())
}

function intEnv(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

function countLines(text) {
  // Count like `wc -l`: number of '\n' bytes.
  let n = 0
  for (const ch of text) if (ch === '\n') n++
  return n
}

function allow() {
  process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n')
  process.exit(0)
}

function block(reason) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n')
  process.exit(0)
}

let input = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) input += chunk

let payload = {}
try {
  payload = JSON.parse(input)
} catch {
  allow()
}
const toolInput = payload.tool_input ?? {}
const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : ''
const offset = toolInput.offset
const limit = toolInput.limit

// Kill switch.
if (truthy(process.env.SHUNT_DISABLED)) allow()

// Subagent exemption: invocations carrying CC-parity caller identity
// (agent_id, bridge-injected for live subagents) bypass the gate.
if (typeof payload.agent_id === 'string' && payload.agent_id !== '') allow()

// Targeted reads always pass — the caller already knows what it needs.
if (offset !== undefined || limit !== undefined) allow()

// No path / nonexistent file: let Read handle it.
if (!filePath || !existsSync(filePath)) allow()

let stat
try {
  stat = statSync(filePath)
} catch {
  allow()
}
if (!stat.isFile()) allow()

// Magic-byte image sniff: read_image has no offset/limit and accepts
// extensionless paths by content sniffing, so large images can never be
// paginated — allow real image content. No extension shortcut: a text file
// named *.png stays gated. Any read error falls through to the thresholds.
try {
  const fd = openSync(filePath, 'r')
  try {
    const head = Buffer.alloc(12)
    const n = readSync(fd, head, 0, 12, 0)
    const b = head.subarray(0, n)
    const isPng = n >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    const isJpeg = n >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
    const isGif = n >= 4 && b.subarray(0, 4).equals(Buffer.from('GIF8', 'ascii'))
    const isWebp =
      n >= 12 &&
      b.subarray(0, 4).equals(Buffer.from('RIFF', 'ascii')) &&
      b.subarray(8, 12).equals(Buffer.from('WEBP', 'ascii'))
    if (isPng || isJpeg || isGif || isWebp) allow()
  } finally {
    closeSync(fd)
  }
} catch {
  // fall through
}

const minLines = intEnv('SHUNT_MIN_LINES', DEFAULT_MIN_LINES)
const maxBytes = intEnv('SHUNT_MAX_BYTES', DEFAULT_MAX_BYTES)

// Byte fallback: catch minified / one-line files whose line count is tiny.
if (stat.size > maxBytes) {
  block(
    `File is ~${Math.round(stat.size / 1024)} KB, over the shunt byte threshold (${maxBytes} bytes). ` +
      `To understand it, delegate via the "bulk-reader" skill instead of reading it into your context. ` +
      `For exact content to edit a specific section, re-read just that range with offset/limit — targeted reads always pass.`,
  )
}

let text = ''
try {
  text = readFileSync(filePath, 'utf8')
} catch {
  allow()
}
const lines = countLines(text)

if (lines <= minLines) allow()

block(
  `File is ${lines} lines (~${Math.max(1, Math.round(stat.size / 1024))} KB), over the shunt threshold (${minLines} lines / ${maxBytes} bytes). ` +
    `To understand it, delegate via the "bulk-reader" skill instead of reading it into your context. ` +
    `For exact content to edit a specific section, re-read just that range with offset/limit — targeted reads always pass.`,
)
