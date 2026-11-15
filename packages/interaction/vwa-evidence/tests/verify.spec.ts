/**
 * Read-back verification pins (§4.2): the four statuses and the whitelist
 * bounds checks, against a real temp workspace and an injected fs surface.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isWhitelistedRel, verifyClaim, verifySpec, type GrProjectSources } from '../src/verify.ts'
import type { SourceSpec } from '../src/marker.ts'

function spec(sourceId: string, a = 1, b = 2): SourceSpec {
  return { sourceId, lineStart: a, lineEnd: b }
}

describe('whitelist (frozen §4.2)', () => {
  it('accepts docs/** and *.md/*.mdx', () => {
    expect(isWhitelistedRel('docs/guide.md')).toBe(true)
    expect(isWhitelistedRel('README.md')).toBe(true)
    expect(isWhitelistedRel('notes.mdx')).toBe(true)
  })
  it('rejects everything else', () => {
    expect(isWhitelistedRel('src/index.ts')).toBe(false)
    expect(isWhitelistedRel('docs.txt')).toBe(false)
  })
})

describe('verifySpec', () => {
  it('marked-ok for an existing whitelisted in-bounds file and line range', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vwa-verify-'))
    await mkdir(join(root, 'docs'), { recursive: true })
    await writeFile(join(root, 'docs', 'a.md'), 'one\ntwo\nthree\n')
    const outcome = await verifySpec(spec('ws:docs/a.md', 2, 3), root)
    expect(outcome.status).toBe('marked-ok')
    await rm(root, { recursive: true, force: true })
  })

  it('out-of-bounds when the realpath escapes the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vwa-verify-'))
    const outcome = await verifySpec(spec('ws:../x.md'), root)
    expect(outcome.status).toBe('out-of-bounds')
    expect(outcome.detail).toContain('not a relative in-workspace path')
    await rm(root, { recursive: true, force: true })
  })

  it('out-of-bounds for non-whitelisted in-workspace targets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vwa-verify-'))
    const outcome = await verifySpec(spec('ws:src/index.ts'), root)
    expect(outcome.status).toBe('out-of-bounds')
    expect(outcome.detail).toContain('whitelist')
    await rm(root, { recursive: true, force: true })
  })

  it('invalid-marker (source does not verify) when the file is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vwa-verify-'))
    const outcome = await verifySpec(spec('ws:docs/ghost.md'), root)
    expect(outcome.status).toBe('invalid-marker')
    expect(outcome.detail).toContain('does not exist')
    await rm(root, { recursive: true, force: true })
  })

  it('invalid-marker with detail when the line range does not exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vwa-verify-'))
    await mkdir(join(root, 'docs'), { recursive: true })
    await writeFile(join(root, 'docs', 'a.md'), 'one\ntwo\n')
    const outcome = await verifySpec(spec('ws:docs/a.md', 2, 9), root)
    expect(outcome.status).toBe('invalid-marker')
    expect(outcome.detail).toContain('L2-L9')
    await rm(root, { recursive: true, force: true })
  })
})

describe('verifyClaim', () => {
  it('unmarked when there are no markers', async () => {
    const outcome = await verifyClaim([], [], '/tmp')
    expect(outcome).toEqual({ status: 'unmarked' })
  })
  it('invalid-marker for any malformed marker', async () => {
    const outcome = await verifyClaim([[spec('ws:docs/a.md')]], [false], '/tmp')
    expect(outcome.status).toBe('invalid-marker')
    expect(outcome.detail).toBeDefined()
  })
  it('marked-ok requires EVERY spec of EVERY marker to pass', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vwa-verify-'))
    await mkdir(join(root, 'docs'), { recursive: true })
    await writeFile(join(root, 'docs', 'a.md'), 'one\ntwo\n')
    const ok = await verifyClaim([[spec('ws:docs/a.md', 1, 2)]], [true], root)
    expect(ok.status).toBe('marked-ok')
    const bad = await verifyClaim([[spec('ws:docs/a.md', 1, 2)], [spec('ws:docs/b.md')]], [true, true], root)
    expect(bad.status).toBe('invalid-marker')
    await rm(root, { recursive: true, force: true })
  })
})

/**
 * `gr:` registered-source citations (design §5.2/§5.3): the marker resolves
 * against the ACTIVE project's source registry and verifies the FROZEN
 * snapshot bytes — never the live file, never model-supplied text.
 */
describe('verifySpec: gr: snapshot citations', () => {
  const PROJECT = 'prj_11111111-2222-3333-4444-555555555555'
  const SOURCE = 'src_abc'
  const SNAPSHOT_REL = `.dsh/vwa/${PROJECT}/sources/${SOURCE}.md`
  const SNAPSHOT_TEXT = 'one\ntwo\nthree\n'
  const digest = (text: string): string => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')

  interface Fixture {
    root: string
    workspace: () => Promise<GrProjectSources | undefined>
    setWorkspace: (next: (() => Promise<GrProjectSources | undefined>) | undefined) => void
    writeSnapshot: (rel: string, text: string) => Promise<string>
    cleanup: () => Promise<void>
  }

  async function fixture(): Promise<Fixture> {
    const root = await mkdtemp(join(tmpdir(), 'vwa-verify-gr-'))
    const registry: GrProjectSources = {
      projectId: PROJECT,
      sources: [{ sourceId: SOURCE, corpusPath: 'docs/corpus/letters.md', snapshotPath: SNAPSHOT_REL, snapshotHash: digest(SNAPSHOT_TEXT) }],
    }
    let resolver: (() => Promise<GrProjectSources | undefined>) | undefined = async () => registry
    const writeSnapshot = async (rel: string, text: string): Promise<string> => {
      const absolute = join(root, ...rel.split('/'))
      await mkdir(join(absolute, '..'), { recursive: true })
      await writeFile(absolute, text)
      return absolute
    }
    await writeSnapshot(SNAPSHOT_REL, SNAPSHOT_TEXT)
    return {
      root,
      workspace: async () => resolver?.(),
      setWorkspace: (next) => {
        resolver = next
      },
      writeSnapshot,
      cleanup: () => rm(root, { recursive: true, force: true }),
    }
  }

  it('marked-ok for a corpus-class source whose snapshot verifies in range', async () => {
    const fx = await fixture()
    const outcome = await verifySpec(spec(`gr:${SOURCE}`, 2, 3), fx.root, { projectSources: fx.workspace })
    expect(outcome).toEqual({ status: 'marked-ok' })
    await fx.cleanup()
  })

  it('invalid-marker when there is no active project', async () => {
    const fx = await fixture()
    fx.setWorkspace(undefined)
    const outcome = await verifySpec(spec(`gr:${SOURCE}`, 1, 1), fx.root, { projectSources: fx.workspace })
    expect(outcome.status).toBe('invalid-marker')
    expect(outcome.detail).toBe('no active VWA project for gr: citation')
    await fx.cleanup()
  })

  it('invalid-marker for an unknown source id', async () => {
    const fx = await fixture()
    const outcome = await verifySpec(spec('gr:src_ghost', 1, 1), fx.root, { projectSources: fx.workspace })
    expect(outcome.status).toBe('invalid-marker')
    expect(outcome.detail).toBe('gr: source not found in the active project')
    await fx.cleanup()
  })

  it('invalid-marker when the source recorded no corpus path (legacy registration)', async () => {
    const fx = await fixture()
    fx.setWorkspace(async () => ({
      projectId: PROJECT,
      sources: [{ sourceId: SOURCE, snapshotPath: SNAPSHOT_REL, snapshotHash: digest(SNAPSHOT_TEXT) }],
    }))
    const outcome = await verifySpec(spec(`gr:${SOURCE}`, 1, 1), fx.root, { projectSources: fx.workspace })
    expect(outcome.status).toBe('invalid-marker')
    expect(outcome.detail).toBe('source has no recorded corpus path (re-register)')
    await fx.cleanup()
  })

  it('invalid-marker when the recorded corpus path is not corpus-class (a .ts file)', async () => {
    const fx = await fixture()
    fx.setWorkspace(async () => ({
      projectId: PROJECT,
      sources: [{ sourceId: SOURCE, corpusPath: 'src/index.ts', snapshotPath: SNAPSHOT_REL, snapshotHash: digest(SNAPSHOT_TEXT) }],
    }))
    const outcome = await verifySpec(spec(`gr:${SOURCE}`, 1, 1), fx.root, { projectSources: fx.workspace })
    expect(outcome.status).toBe('invalid-marker')
    expect(outcome.detail).toBe('source corpus path is outside the citable corpus')
    await fx.cleanup()
  })

  it('invalid-marker when the snapshot bytes no longer match the recorded hash', async () => {
    const fx = await fixture()
    await fx.writeSnapshot(SNAPSHOT_REL, 'one\ntwo\nTAMPERED\n')
    const outcome = await verifySpec(spec(`gr:${SOURCE}`, 1, 2), fx.root, { projectSources: fx.workspace })
    expect(outcome.status).toBe('invalid-marker')
    expect(outcome.detail).toBe('snapshot hash mismatch (tampered)')
    await fx.cleanup()
  })

  it('invalid-marker when the recorded snapshot path escapes the project state tree', async () => {
    const fx = await fixture()
    await fx.writeSnapshot('docs/corpus/letters.md', SNAPSHOT_TEXT)
    fx.setWorkspace(async () => ({
      projectId: PROJECT,
      sources: [{
        sourceId: SOURCE,
        corpusPath: 'docs/corpus/letters.md',
        snapshotPath: 'docs/corpus/letters.md',
        snapshotHash: digest(SNAPSHOT_TEXT),
      }],
    }))
    const outcome = await verifySpec(spec(`gr:${SOURCE}`, 1, 1), fx.root, { projectSources: fx.workspace })
    expect(outcome.status).toBe('invalid-marker')
    expect(outcome.detail).toBe('snapshot path escapes')
    await fx.cleanup()
  })

  it('invalid-marker when the line range is outside the snapshot', async () => {
    const fx = await fixture()
    const outcome = await verifySpec(spec(`gr:${SOURCE}`, 2, 9), fx.root, { projectSources: fx.workspace })
    expect(outcome.status).toBe('invalid-marker')
    expect(outcome.detail).toContain('L2-L9')
    await fx.cleanup()
  })

  it('invalid-marker when the snapshot file is missing', async () => {
    const fx = await fixture()
    await rm(join(fx.root, ...SNAPSHOT_REL.split('/')), { force: true })
    const outcome = await verifySpec(spec(`gr:${SOURCE}`, 1, 1), fx.root, { projectSources: fx.workspace })
    expect(outcome.status).toBe('invalid-marker')
    expect(outcome.detail).toContain('snapshot')
    await fx.cleanup()
  })

  it('without a project-source resolver a gr: spec never verifies (fail closed)', async () => {
    const fx = await fixture()
    const outcome = await verifySpec(spec(`gr:${SOURCE}`, 1, 1), fx.root)
    expect(outcome.status).toBe('invalid-marker')
    expect(outcome.detail).toBe('no active VWA project for gr: citation')
    await fx.cleanup()
  })

  it('leaves the ws: pins unchanged in a mixed claim', async () => {
    const fx = await fixture()
    await mkdir(join(fx.root, 'docs'), { recursive: true })
    await writeFile(join(fx.root, 'docs', 'a.md'), 'one\ntwo\n')
    const ok = await verifyClaim(
      [[spec('ws:docs/a.md', 1, 2), spec(`gr:${SOURCE}`, 1, 2)]],
      [true],
      fx.root,
      { projectSources: fx.workspace },
    )
    expect(ok.status).toBe('marked-ok')
    const wsOnly = await verifySpec(spec('ws:src/index.ts'), fx.root, { projectSources: fx.workspace })
    expect(wsOnly.status).toBe('out-of-bounds')
    await fx.cleanup()
  })
})

