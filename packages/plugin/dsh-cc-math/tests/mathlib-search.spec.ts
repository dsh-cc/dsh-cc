/**
 * Mathlib index + retrieval behavioral tests (design §4.2): the index builder
 * consumes Dumper JSONL (declarations AND per-module import edges), is
 * idempotent per env receipt digest, and the search CLI implements the
 * CORRECTED reachability direction — with --imports F the reachable set is
 * { decl ∈ M | M ∈ imports*(imports(F)) }, i.e. declarations in modules F's
 * own import set transitively imports; a module higher in the graph that
 * imports F's modules is NOT reachable. FTS5 syntax errors exit 2 with the
 * raw error; empty results exit 0 with an empty array. Real node:sqlite FTS5,
 * no network.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { indexEnv, parseDump } from '../skills/math-research/scripts/mathlib-index.mjs'
import { main, parseImports, search } from '../skills/math-research/scripts/mathlib-search.mjs'
import { openSearchDb } from '../skills/math-research/scripts/sqlite.lib.mjs'
import { HEX, cli, isoNow, workspaces } from './helpers.ts'

const roots = workspaces()
afterEach(() => roots.cleanup())
const FIXTURES = join(import.meta.dirname, 'fixtures')
const DUMP = join(FIXTURES, 'mathlib-index', 'dump.fixture.jsonl')
const IMPORTS_FILE = join(FIXTURES, 'mathlib-search', 'proof-imports.lean') // `import Mathlib.Core`

async function makeFixtureIndex() {
  const root = await roots.make('mrh-search-')
  const envDir = join(root, 'env')
  await mkdir(envDir, { recursive: true })
  await writeFile(join(envDir, 'env.receipt.json'), JSON.stringify({
    schemaVersion: 1, envId: 'v4.35.0-test', pin: { mathlib: { repo: 'leanprover-community/mathlib4', rev: 'v4.35.0', sha256: HEX('a') } },
    leanDigest: HEX('b'), mathlibSha256: HEX('a'), cacheArtifactSha256: null, platform: 'linux-x64', provisionedAt: isoNow(),
  }))
  const indexPath = join(root, 'index.sqlite')
  const built = await indexEnv({ envDir, indexPath, jsonlPath: DUMP })
  expect(built.status).toBe('fresh')
  return { root, envDir, indexPath }
}

const queryNames = async (indexPath: string, args: string[]) => {
  const { exitCode, output } = await cli(main, ['--query', ...(args as string[]), '--index', indexPath])
  return { exitCode, output }
}

describe('mathlib-index build (§4.2)', () => {
  it('parses declaration lines and edge lines, rejecting anything else', () => {
    const parsed = parseDump('{"name":"A.b","kind":"theorem","module":"M","typeText":"T"}\n{"module":"M","imports":["N"]}\n')
    expect(parsed.decls).toHaveLength(1)
    expect(parsed.edges).toEqual([{ module: 'M', imports: ['N'] }])
    expect(() => parseDump('{"oops":true}\n')).toThrowError(expect.objectContaining({ code: 'output-invalid' }) as never)
    expect(() => parseDump('not json\n')).toThrowError(expect.objectContaining({ code: 'output-invalid' }) as never)
  })

  it('builds decls/modules/moduleEdges and is idempotent per receipt digest', async () => {
    const { indexPath } = await makeFixtureIndex()
    const db = openSearchDb(indexPath)
    expect(db.prepare('SELECT count(*) AS n FROM decls').get()).toMatchObject({ n: 5 })
    expect(db.prepare('SELECT count(*) AS n FROM moduleEdges').get()).toMatchObject({ n: 2 })
    // Direction pinned in the stored data: importer is the module whose source contains the import.
    expect(db.prepare("SELECT imported FROM moduleEdges WHERE importer = 'Mathlib.Alg'").all()).toEqual([{ imported: 'Mathlib.Core' }])
    db.close()
  })

  it('a second build with the same receipt is reused; a receipt change rebuilds', async () => {
    const { envDir, indexPath } = await makeFixtureIndex()
    const reused = await indexEnv({ envDir, indexPath, jsonlPath: DUMP })
    expect(reused.status).toBe('reused')
    expect(reused).toMatchObject({ envId: 'v4.35.0-test' })
    // Touch the receipt (new digest) with the same envId → full rebuild.
    const receiptPath = join(envDir, 'env.receipt.json')
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
    receipt.provisionedAt = isoNow()
    await writeFile(receiptPath, JSON.stringify(receipt))
    const rebuilt = await indexEnv({ envDir, indexPath, jsonlPath: DUMP })
    expect(rebuilt.status).toBe('fresh')
  })
})

describe('mathlib-search retrieval (§4.2)', () => {
  it('FTS5 MATCH + BM25 over the fixture index; empty results exit 0 with an empty array', async () => {
    const { indexPath } = await makeFixtureIndex()
    const none = await queryNames(indexPath, ['zzz_no_match_at_all'])
    expect(none.exitCode).toBe(0)
    expect(none.output).toMatchObject({ status: 'ok', results: [] })
  })

  it('--kind filters to the requested declaration kinds', async () => {
    const { indexPath } = await makeFixtureIndex()
    const db = openSearchDb(indexPath)
    const all = search(db, { query: 'add*' }).map(row => row.name)
    expect(all).toContain('Nat.add') // def
    expect(all).toContain('add_comm_left')
    const onlyTheorems = search(db, { query: 'add*', kinds: ['theorem'] }).map(row => row.name)
    expect(onlyTheorems).toContain('Nat.add_comm')
    expect(onlyTheorems).not.toContain('Nat.add')
    db.close()
  })

  it('--imports restricts to the transitive import closure of the FILE\'s own imports (corrected direction)', async () => {
    const { indexPath } = await makeFixtureIndex()
    // 'nat' (typeText) hits declarations in Alg, Core and Base. The file
    // imports Mathlib.Core; closure is {Core, Base} — never Alg (Alg imports
    // Core: the WRONG direction would include it) and never Other.
    const { exitCode, output } = await cli(main, ['--query', 'nat', '--imports', IMPORTS_FILE, '--index', indexPath])
    expect(exitCode).toBe(0)
    const names = (output.results as Array<{ name: string }>).map(row => row.name)
    expect(names).toContain('Nat.add_comm')  // Mathlib.Core: directly imported
    expect(names).toContain('Nat.add')       // Mathlib.Core
    expect(names).toContain('Nat.mul_comm')  // Mathlib.Base: imported by Core
    expect(names).not.toContain('add_comm_left') // Mathlib.Alg: imports Core — reverse direction!
    expect(names).not.toContain('unrelated_thing')
    expect(output.importsFilter).toMatchObject({ applied: true, imports: ['Mathlib.Core'] })
    // Without --imports there is no filter, and that is flagged in the output.
    const unfiltered = await queryNames(indexPath, ['nat'])
    const all = (unfiltered.output.results as Array<{ name: string }>).map(row => row.name)
    expect(all).toContain('add_comm_left')
    expect(unfiltered.output.importsFilter).toMatchObject({ applied: false })
    expect(String((unfiltered.output.importsFilter as { note?: string }).note)).toContain('no --imports filter')
  })

  it('FTS5 syntax errors exit 2 with the raw sqlite error', async () => {
    const { indexPath } = await makeFixtureIndex()
    const { exitCode, output } = await cli(main, ['--query', 'comm AND (', '--index', indexPath])
    expect(exitCode).toBe(2)
    expect(output).toMatchObject({ status: 'blocked', reason: { code: 'query-invalid' }, results: [] })
    const detail = String((output.reason as { detail?: string }).detail)
    expect(detail.length).toBeGreaterThan(0)
    expect(detail).toMatch(/fts5|syntax/i)
  })

  it('a missing --imports file and a missing index are config-invalid (exit 2)', async () => {
    const { indexPath } = await makeFixtureIndex()
    const missing = await cli(main, ['--query', 'comm', '--imports', '/no/such/file.lean', '--index', indexPath])
    expect(missing.exitCode).toBe(2)
    const noIndex = await cli(main, ['--query', 'comm', '--index', join(import.meta.dirname, 'no-such-index.sqlite')])
    expect(noIndex.exitCode).toBe(2)
  })

  it('parseImports extracts a Lean file\'s own import set, in order, de-duplicated', async () => {
    const seeded = await roots.make('mrh-imports-')
    const file = join(seeded, 'x.lean')
    await writeFile(file, 'import Mathlib.Core\nimport Mathlib.Base\nimport Mathlib.Core\n\n-- a comment mentioning import X is at line start? no indentation: yes\nimport Mathlib.Core.Sub\n')
    expect(await parseImports(file)).toEqual(['Mathlib.Core', 'Mathlib.Base', 'Mathlib.Core.Sub'])
  })
})
