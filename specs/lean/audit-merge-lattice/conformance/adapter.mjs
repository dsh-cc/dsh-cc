// Conformance adapter for audit-merge-lattice. It binds the model-local
// fixture implementation through Node ESM resolution relative to this module
// (never the process working directory) and keeps no second copy of the
// algorithm. Stdout is protocol-only; diagnostics go to stderr.
import { mergeWorst } from '../../../../packages/plugin/dsh-cc-agents/tests/fixtures/formal-design-lean/systemone/audit-merge.ts'

async function readStdin() {
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  return text
}

const fail = message => { throw new Error(message) }

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
  if (input === null || typeof input !== 'object' || Array.isArray(input) || !Array.isArray(input.verdicts)) {
    fail(`line ${index + 1} input must be an object with a verdicts array`)
  }
  answers.push(JSON.stringify({ id: parsed.id, result: { ok: { worst: mergeWorst(input.verdicts) } } }))
})

try {
  process.stdout.write(answers.map(answer => answer + '\n').join(''))
} catch (error) {
  console.error(`adapter: ${error.message}`)
  process.exitCode = 1
}
