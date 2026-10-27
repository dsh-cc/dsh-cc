import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parseSyntax, normalizeArguments } from './preflight.lib.mjs'
import { executeCheck } from './check.lib.mjs'
export async function main(argv = process.argv.slice(2)) {
  let options
  try { options = parseSyntax(argv, 'check') }
  catch (e) { process.stdout.write(JSON.stringify({ schemaVersion: 1, command: 'check', status: 'blocked', reason: 'usage-invalid', blockers: [{ code: 'usage-invalid', detail: e.detail ?? 'invalid arguments' }], summary: null }) + '\n'); return 2 }
  if (options.help) { process.stdout.write('check --project <root> --model specs/tla/<id> [--jar <file>] [--java <file>] [--bridge specs/formal/<id>/bridge.json]\n'); return 0 }
  const controller = new AbortController()
  const cancel = () => controller.abort()
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel)
  try {
    options = await normalizeArguments(options, 'check')
    const result = await executeCheck(options, { signal: controller.signal })
    process.stdout.write(JSON.stringify(result) + '\n')
    return { verified: 0, counterexample: 1, blocked: 2, error: 2, incomplete: 3 }[result.status]
  } finally {
    // §10.1: after the finished marker is published the committed result and
    // its exit code must survive. The handlers stay installed for the
    // remaining process lifetime so a late SIGINT/SIGTERM cannot fall through
    // to the default signal exit and clobber the committed exit code.
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await main()
