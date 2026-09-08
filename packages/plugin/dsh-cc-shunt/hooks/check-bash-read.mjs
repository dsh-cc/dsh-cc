#!/usr/bin/env node
/**
 * check-bash-read.mjs — shunt PreToolUse gate for the Bash tool.
 *
 * Blocks cat/head/tail/less/more commands that read large files into
 * context and redirects to the bulk-reader skill. Piped and redirected
 * commands are targeted operations and always pass. Port of the upstream
 * shunt bash+jq hook as a dependency-free Node script.
 *
 * Upstream-eval-pinned behavior: leading flags are stripped (cat -n,
 * head -100), so ONLY the file's own size decides — `head -100 bigfile`
 * is blocked like a plain cat.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const DEFAULT_MIN_LINES = 350
const DEFAULT_MAX_BYTES = 100000
const READ_COMMAND_RE = /^(cat|head|tail|less|more)\s+/

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
const command = typeof payload.tool_input?.command === 'string' ? payload.tool_input.command : ''

// Kill switch.
if (truthy(process.env.SHUNT_DISABLED)) allow()

// No command, or a targeted (piped / redirected) command.
if (!command || command.includes('|') || command.includes('>') || !READ_COMMAND_RE.test(command)) allow()

// Strip the command name, then strip flags and quotes; first non-flag arg is the path.
const args = command.slice(command.match(READ_COMMAND_RE)[1].length).trim().split(/\s+/)
let filePath = ''
for (const arg of args) {
  if (arg.startsWith('-')) continue
  filePath = arg.replace(/^["']|["']$/g, '')
  break
}
if (!filePath) allow()

// Hooks run in the session workspace.
const abs = resolve(process.cwd(), filePath)
if (!existsSync(abs)) allow()

let stat
try {
  stat = statSync(abs)
} catch {
  allow()
}
if (!stat.isFile()) allow()

const minLines = intEnv('SHUNT_MIN_LINES', DEFAULT_MIN_LINES)
const maxBytes = intEnv('SHUNT_MAX_BYTES', DEFAULT_MAX_BYTES)

// Byte fallback: catch minified / one-line files.
if (stat.size > maxBytes) {
  block(
    `File is ~${Math.round(stat.size / 1024)} KB, over the shunt byte threshold (${maxBytes} bytes). ` +
      `To understand it, delegate via the "bulk-reader" skill instead of reading it into your context. ` +
      `Piping to grep/head (e.g. cat file | grep pattern) is the targeted alternative — targeted reads always pass.`,
  )
}

let lines = 0
try {
  lines = countLines(readFileSync(abs, 'utf8'))
} catch {
  allow()
}

if (lines <= minLines) allow()

block(
  `File is ${lines} lines (~${Math.max(1, Math.round(stat.size / 1024))} KB), over the shunt threshold (${minLines} lines / ${maxBytes} bytes). ` +
    `To understand it, delegate via the "bulk-reader" skill instead of reading it into your context. ` +
    `Piping to grep/head (e.g. cat file | grep pattern) is the targeted alternative — targeted reads always pass.`,
)
