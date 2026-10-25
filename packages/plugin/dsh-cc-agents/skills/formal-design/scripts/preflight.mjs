import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parseArguments, preflight } from './preflight.lib.mjs'
export async function main(argv = process.argv.slice(2)) {
  try {
    const options = await parseArguments(argv, 'preflight')
    if (options.help) { process.stdout.write('preflight --project <root> --model specs/tla/<id> [--jar <file>] [--java <file>]\n'); return 0 }
    const { output } = await preflight(options)
    process.stdout.write(JSON.stringify(output) + '\n'); return output.status === 'ready-for-check' ? 0 : 2
  } catch (e) {
    const reason = e.code === 'usage-invalid' ? e.code : 'io'
    process.stdout.write(JSON.stringify({ schemaVersion: 1, command: 'preflight', status: 'blocked', reason, blockers: [{ code: reason, detail: e.detail ?? 'preflight failed' }], willGenerate: [] }) + '\n'); return 2
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await main()
