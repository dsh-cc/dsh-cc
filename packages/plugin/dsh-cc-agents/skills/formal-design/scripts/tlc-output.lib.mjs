import { StringDecoder } from 'node:string_decoder'
import { KNOWN_CODES } from './ec-vocabulary.lib.mjs'

// Incremental and bounded: retain only event metadata and the final statistics
// frame. The persisted raw logs preserve all bodies, including state traces.
export class FrameParser {
  decoder = new StringDecoder('utf8')
  buffer = ''
  stack = []
  events = new Map()
  invalid = false
  sequence = 0
  modeIndex = null
  successIndex = null
  finishedIndex = null
  pendingStats = null
  finalStats = null
  feed(chunk) { this.text(this.decoder.write(chunk)) }
  body(text) {
    for (const f of this.stack) if (f.code === 2199 && !f.truncated) {
      f.body += text
      if (f.body.length > 65536) { f.body = ''; f.truncated = true }
    }
  }
  text(text) {
    this.buffer += text
    const prefix = '@!@!@'
    while (this.buffer.length) {
      const index = this.buffer.indexOf(prefix)
      if (index < 0) {
        // Retain only a possible split marker prefix across chunks.
        let tail = Math.min(prefix.length - 1, this.buffer.length)
        while (tail && !prefix.startsWith(this.buffer.slice(-tail))) tail--
        this.body(this.buffer.slice(0, this.buffer.length - tail))
        this.buffer = tail ? this.buffer.slice(-tail) : ''
        break
      }
      if (index) { this.body(this.buffer.slice(0, index)); this.buffer = this.buffer.slice(index) }
      const closing = this.buffer.indexOf(' @!@!@', prefix.length)
      if (closing < 0) {
        if (this.buffer.length <= 256) break
        this.invalid = true; this.body(this.buffer.slice(0, prefix.length)); this.buffer = this.buffer.slice(prefix.length); continue
      }
      const token = this.buffer.slice(0, closing + 6)
      this.buffer = this.buffer.slice(closing + 6)
      const start = /^@!@!@STARTMSG (-?\d+):(\d+) @!@!@$/.exec(token)
      const end = /^@!@!@ENDMSG (-?\d+) @!@!@$/.exec(token)
      if (start) {
        this.body(token) // A nested token invalidates a statistics body's format.
        const code = Number(start[1]); const severity = Number(start[2]); const order = this.sequence++
        if (!Number.isSafeInteger(code) || ![0, 1, 2, 3, 4].includes(severity)) this.invalid = true
        const key = `${code}:${severity}`
        if (!this.events.has(key)) this.events.set(key, { code, severity })
        if (code === 2187 && this.modeIndex === null) this.modeIndex = order
        if (code === 2193 && this.modeIndex !== null && this.successIndex === null) this.successIndex = order
        if (code === 2186) { this.finishedIndex = order; this.finalStats = this.pendingStats }
        this.stack.push({ code, body: '', truncated: false })
      } else if (end) {
        const f = this.stack.pop()
        if (!f || f.code !== Number(end[1])) this.invalid = true
        else if (f.code === 2199) {
          const m = !f.truncated && /^(0|[1-9][0-9]*) states generated, (0|[1-9][0-9]*) distinct states found, (0|[1-9][0-9]*) states left on queue\.$/.exec(f.body.trim())
          this.pendingStats = m ? { generated: m[1], distinct: m[2], queue: m[3] } : null
        }
        this.body(token)
      } else { this.invalid = true; this.body(token) }
    }
  }
  finish() {
    this.text(this.decoder.end())
    if (this.buffer.startsWith('@!@!@')) this.invalid = true
    this.body(this.buffer); this.buffer = ''
    if (this.stack.length) this.invalid = true
    return { invalid: this.invalid, events: [...this.events.values()], statistics: this.finalStats, ordered: this.modeIndex !== null && this.successIndex !== null && this.finishedIndex > this.successIndex }
  }
}
const matches = new Map([[10, [2104, 2105]], [11, [2114]], [12, [2107, 2110]], [13, [2108, 2112, 2116, 2113]], [14, [2132]]])
const violations = new Map([[2114, 11], [2107, 12], [2110, 12], [2108, 13], [2112, 13], [2116, 13], [2132, 14]])
export function classify({ stdout, stderr, exitCode, signal, timedOut, interruption, spawnFailed }) {
  const events = [...stdout.events, ...stderr.events]
  const eventCodes = [...new Set(events.map(e => e.code))].sort((a, b) => a - b)
  const warningCodes = [...new Set(events.filter(e => e.severity === 3).map(e => e.code))].sort((a, b) => a - b)
  const base = { eventCodes, warningCodes, statistics: stdout.statistics }
  const result = (status, reason) => ({ ...base, status, reason })
  const has = code => eventCodes.includes(code)
  if (['cancelled', 'input-changed', 'artifact-changed'].includes(interruption)) return result('incomplete', interruption)
  if (timedOut) return result('incomplete', 'timeout')
  if (interruption === 'log-limit') return result('incomplete', 'log-limit')
  if (signal) return result('incomplete', 'signal-exit')
  if (spawnFailed) return result('error', 'spawn-failed')
  if (interruption === 'io') return result('error', 'io')
  if (stdout.invalid || stderr.invalid) return result('incomplete', 'output-invalid')
  if (events.some(e => e.severity === 2)) return result('error', 'tlc-bug')
  if ((has(2193) && exitCode !== 0) || [...violations].some(([code, exit]) => has(code) && exit !== exitCode) || (matches.has(exitCode) && !matches.get(exitCode).some(has)) || (exitCode === 0 && events.some(e => e.severity === 1))) return result('error', 'output-inconsistent')
  if (events.some(e => e.severity === 1 && !KNOWN_CODES.has(e.code))) return result('error', 'unknown-error')
  if (exitCode === 10) return result('error', 'assumption-failed')
  if (exitCode === 11) return result('counterexample', 'deadlock')
  if (exitCode === 12) return result('counterexample', 'invariant')
  if (exitCode === 13) return has(2113) ? result('error', 'property-evaluation-failed') : result('counterexample', 'temporal')
  if (exitCode === 14) return result('counterexample', 'value-assert')
  if ([75, 76, 77].includes(exitCode)) return result('error', 'property-evaluation-failed')
  if ((exitCode === 150 && (has(2171) || has(3002))) || (exitCode === 151 && eventCodes.some(c => (c >= 2222 && c <= 2245) || c === 2280 || c === 2281)) || (exitCode === 255 && eventCodes.some(c => c >= 5001 && c <= 5006))) return result('error', 'config-invalid')
  if (exitCode === 0) {
    const s = stdout.statistics
    return stdout.ordered && s && BigInt(s.generated) > 0n && BigInt(s.distinct) > 0n && s.queue === '0' ? result('verified', 'verified') : result('incomplete', 'output-invalid')
  }
  return result('error', 'unknown-error')
}
export function aggregate(cases, globals = []) {
  const warnings = cases.flatMap(c => [...[...new Set(c.warningCodes ?? [])].sort((a, b) => a - b).map(code => `tlc-warning:${c.id}:${code}`), ...(c.coverage === 'expansion' && c.status !== 'verified' ? [`expansion-${c.status}:${c.id}:${c.reason}`] : [])])
  for (const reason of ['cancelled', 'input-changed', 'artifact-changed']) if (globals.includes(reason)) return { status: 'incomplete', reason, warnings }
  if (globals.includes('io')) return { status: 'error', reason: 'io', warnings }
  const status = cases.every(c => c.status === 'verified') ? 'verified' : ['counterexample', 'error', 'incomplete'].find(s => cases.some(c => c.status === s)) ?? 'incomplete'
  return { status, reason: status === 'verified' ? 'verified' : cases.find(c => c.status === status)?.reason ?? 'not-run', warnings }
}
