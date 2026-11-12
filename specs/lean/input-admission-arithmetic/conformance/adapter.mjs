// Conformance adapter for input-admission-arithmetic. Binds the model-local
// fixture (NOT production code) through Node ESM resolution relative to this
// module, never the process working directory. Stdout is protocol-only;
// diagnostics go to stderr.
import { charged, fits, oversize, withinWindow } from '../../../../packages/plugin/dsh-cc-agents/tests/fixtures/formal-design-lean/input-governance/admission-arithmetic.ts'

const CLASSES = new Set(['governance', 'task', 'memory', 'advisory', 'passthrough'])

const fail = message => { throw new Error(message) }

const nat = (value, label) => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) fail(`${label} must be a canonical decimal string`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) fail(`${label} is outside the safe-integer range`)
  return parsed
}

let text = ''
for await (const chunk of process.stdin) text += chunk
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
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail(`line ${index + 1} input must be an object`)
  if (typeof input.class !== 'string' || !CLASSES.has(input.class)) fail(`line ${index + 1} input.class is not a message class`)
  const budget = nat(input.budget, `line ${index + 1} input.budget`)
  const used = nat(input.used, `line ${index + 1} input.used`)
  const bytes = nat(input.bytes, `line ${index + 1} input.bytes`)
  const now = nat(input.now, `line ${index + 1} input.now`)
  const lastAdmitted = nat(input.lastAdmitted, `line ${index + 1} input.lastAdmitted`)
  const window = nat(input.window, `line ${index + 1} input.window`)
  answers.push(JSON.stringify({
    id: parsed.id,
    result: {
      ok: {
        charged: String(charged(input.class, bytes)),
        fits: fits(budget, used, bytes),
        oversize: oversize(budget, bytes),
        suppressed: withinWindow(now, lastAdmitted, window),
      },
    },
  }))
})

process.stdout.write(answers.map(answer => answer + '\n').join(''))
