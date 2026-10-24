import { pathToFileURL } from 'node:url'
import { parseArguments } from './preflight.lib.mjs'
import { auditEvidence } from './evidence.lib.mjs'
export async function main(argv = process.argv.slice(2)) {
  try {
    const options = await parseArguments(argv, 'check-evidence')
    if (options.help) { process.stdout.write('check-evidence --project <root> --model specs/tla/<id>\n'); return 0 }
    const result = await auditEvidence(options)
    process.stdout.write(JSON.stringify(result) + '\n'); return result.status === 'valid' ? 0 : 2
  } catch (e) {
    process.stdout.write(JSON.stringify({ schemaVersion: 1, command: 'check-evidence', status: 'invalid', reason: e.code === 'usage-invalid' ? 'usage-invalid' : 'io', fresh: false, verification: null, runId: null, inputDigest: null }) + '\n'); return 2
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main()
