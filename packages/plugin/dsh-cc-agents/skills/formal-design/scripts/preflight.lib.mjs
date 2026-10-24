import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { inspectProject, enumerate, hashFile, runnerIdentity, cfgState, SCRIPTS } from './fingerprint.lib.mjs'
import { fail, parseManifest, sortBlockers } from './manifest.lib.mjs'
import { probeJava } from './process.lib.mjs'
export function parseSyntax(argv, command) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true }
  const allowed = command === 'check-evidence' ? ['project', 'model'] : ['project', 'model', 'jar', 'java']
  const options = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].slice(2)
    if (!argv[i].startsWith('--') || !allowed.includes(key) || Object.hasOwn(options, key) || !argv[i + 1] || argv[i + 1].startsWith('--')) fail('usage-invalid', 'invalid, missing or duplicate argument')
    options[key] = argv[i + 1]
  }
  if (!options.project || !options.model) fail('usage-invalid', '--project and --model are required')
  return options
}
export async function normalizeArguments(options, command, { env = process.env, bundledJar = join(SCRIPTS, '../toolchain/tla2tools.jar') } = {}) {
  if (options.help) return options
  // Normalize once, retain independent missing-file diagnostics for preflight.
  options.argumentBlockers = []
  if (command !== 'check-evidence') {
    // A configured path is authoritative: normalization/checksum errors must
    // not silently substitute a different artifact. Only an absent selection
    // uses the immutable toolchain resource shipped with this plugin version.
    if (!Object.hasOwn(options, 'jar')) options.jar = env.TLA2TOOLS_JAR || bundledJar
    for (const key of ['java', 'jar']) if (options[key]) {
      try { const path = await fs.realpath(options[key]); if (!(await fs.stat(path)).isFile()) throw new Error('not regular'); options[key] = path }
      catch (e) { options.argumentBlockers.push({ code: e.code === 'ENOENT' || e.code === 'ENOTDIR' ? `${key}-missing` : 'io', detail: `${key} path is not an accessible regular file` }); options[key] = null }
    }
    if (!Object.hasOwn(options, 'java')) options.java = 'java'
  }
  return options
}
export async function parseArguments(argv, command) { return normalizeArguments(parseSyntax(argv, command), command) }
export async function preflight(options, { probe = probeJava, signal, platform = process.platform, identity = runnerIdentity } = {}) {
  const blockers = [...(options.argumentBlockers ?? [])]
  let paths, manifest, runner, javaVersion, jarSha256
  const add = (e, code = 'io', context = {}) => blockers.push({ code: e.code && ['model-path-unsafe', 'config-invalid', 'input-limit'].includes(e.code) ? e.code : code, detail: e.detail ?? 'filesystem operation failed', ...context })
  try { paths = await inspectProject(options.project, options.model) } catch (e) { add(e, 'io') }
  if (!['darwin', 'linux'].includes(platform)) blockers.push({ code: 'unsupported-platform', detail: 'only macOS and Linux process termination is supported' })
  try { runner = await identity() } catch (e) { add(e, 'config-invalid') }
  let missing = []
  if (paths) {
    try {
      manifest = parseManifest(await fs.readFile(join(paths.model, 'checks.json'), 'utf8'))
      if (manifest.modelId !== paths.modelId) fail('config-invalid', 'manifest modelId must equal directory name')
    } catch (e) { add(e, e.code === 'ENOENT' ? 'io' : 'config-invalid', { relativePath: `${paths.modelRelative}/checks.json`, caseId: '' }) }
    if (manifest) {
      try { await enumerate(paths.model, manifest, true) } catch (e) { add(e) }
      try { const state = await cfgState(paths, manifest); missing = state.missing; blockers.push(...state.blockers) } catch (e) { add(e) }
    }
  }
  if (options.java && paths && !signal?.aborted) {
    const result = await probe(options.java, paths.root, { signal })
    if (result.code === 'cancelled') return { cancelled: true }
    if (result.code) blockers.push({ code: result.code, detail: result.detail })
    else javaVersion = result.version
  }
  if (!options.jar) {
    if (!blockers.some(b => b.code === 'jar-missing' || (b.code === 'io' && b.detail.startsWith('jar ')))) blockers.push({ code: 'jar-missing', detail: 'TLC JAR unavailable; reinstall the plugin or provide --jar/TLA2TOOLS_JAR' })
  } else {
    try {
      const sha1 = await hashFile(options.jar, 'sha1')
      if (runner && sha1 !== runner.toolchain.sha1) blockers.push({ code: 'jar-checksum', detail: 'JAR SHA-1 does not match the pinned TLC artifact' })
      jarSha256 = await hashFile(options.jar)
    } catch (e) { add(e, e.code === 'ENOENT' ? 'jar-missing' : 'io') }
  }
  const ordered = sortBlockers(blockers)
  return { options, paths, manifest, runner, javaVersion, jarSha256, output: { schemaVersion: 1, command: 'preflight', status: ordered.length ? 'blocked' : 'ready-for-check', reason: ordered[0]?.code ?? 'ready-for-check', blockers: ordered, willGenerate: ordered.length ? [] : missing } }
}
