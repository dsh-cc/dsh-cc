// Conformance adapter for decision-quota-accounting. It binds the model-local
// fixture implementation through Node ESM resolution relative to this module
// (never the process working directory) and keeps no second copy of the
// algorithm. Stdout is protocol-only; diagnostics go to stderr.
import { retainedTotal, reservedTotal } from '../../../../packages/plugin/dsh-cc-agents/tests/fixtures/formal-design-lean/systemone/quota-accounting.ts'

async function readStdin() {
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  return text
}

const fail = message => { throw new Error(message) }

const parseNat = (value, label) => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) fail(`${label} must be a canonical decimal string`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) fail(`${label} is outside the safe-integer range`)
  return parsed
}

const parseTerm = (value, label) => {
  if (value === 'unsettled') return { kind: 'unsettled' }
  if (value === 'unknown') return { kind: 'unknown' }
  if (value === 'not-dispatched') return { kind: 'not-dispatched' }
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && typeof value.actual === 'string') {
    return { kind: 'actual', usage: parseNat(value.actual, `${label}.actual`) }
  }
  fail(`${label} is not a terminal settlement`)
}

const text = await readStdin()
const lines = text.split('\n')
if (lines.at(-1) === '') lines.pop()
const answers = []
lines.forEach((line, index) => {
  if (line.length === 0) fail(`blank line at position ${index + 1}`)
  let parsed
  try { parsed = JSON.parse(line) } catch (error) { fail(`line ${index + 1} is not JSON: ${error.message}`) }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) fail(`line ${index + 1} must be an object`)
  if (Object.keys(parsed).length !== 2 || !('id' in parsed) || !('input' in parsed)) fail(`line ${index + 1} must contain exactly id and input`)
  const input = parsed.input
  if (input === null || typeof input !== 'object' || Array.isArray(input) || !Array.isArray(input.ledger)) {
    fail(`line ${index + 1} input must be an object with a ledger array`)
  }
  const ledger = input.ledger.map((row, rowIndex) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) fail(`line ${index + 1} ledger[${rowIndex}] must be an object`)
    return {
      reserved: parseNat(row.reserved, `line ${index + 1} ledger[${rowIndex}].reserved`),
      term: parseTerm(row.term, `line ${index + 1} ledger[${rowIndex}].term`),
    }
  })
  answers.push(JSON.stringify({
    id: parsed.id,
    result: {
      ok: {
        retainedTotal: String(retainedTotal(ledger)),
        reservedTotal: String(reservedTotal(ledger)),
      },
    },
  }))
})

try {
  process.stdout.write(answers.map(answer => answer + '\n').join(''))
} catch (error) {
  console.error(`adapter: ${error.message}`)
  process.exitCode = 1
}
