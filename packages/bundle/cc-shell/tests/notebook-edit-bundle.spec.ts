import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { CallId } from '@deepseek-ai/dsh-llm'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import ToolRuntime from '@dsh-cc/tools'
import * as ToolNotebookEdit from '@dsh-cc/tool-notebook-edit'

/** Temp dirs for this bundle spec, cleaned up in afterEach. */
const dirs: string[] = []

/** A valid nbformat 4.5 notebook with one addressable code cell. */
function sampleNotebook(): string {
  return JSON.stringify({
    cells: [
      {
        cell_type: 'code',
        id: 'c1',
        execution_count: 2,
        metadata: {},
        outputs: [{ output_type: 'stream', text: '1\n' }],
        source: 'print(1)',
      },
    ],
    metadata: { language_info: { name: 'python' } },
    nbformat: 4,
    nbformat_minor: 5,
  }, null, 1)
}

/** Mount the vendored ToolRuntime swap + the notebook-edit bundle row. */
async function mountNotebookEdit(): Promise<{ ctx: Context; dir: string; dispose: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cc-nb-bundle-'))
  dirs.push(dir)
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalFileSystem, { cwd: dir })
  await ctx.plugin(ToolNotebookEdit)
  return { ctx, dir, dispose: () => ctx.fiber.dispose() }
}

/** Synthesize the model-facing Read observation for a path. */
async function observeRead(ctx: Context, path: string): Promise<void> {
  const target = await ctx.fs.resolve(path)
  const info = await ctx.fs.stat(target)
  if (info === undefined) throw new Error('stat returned undefined')
  ctx.emit('fs/observed', target, { kind: 'present', version: info.version })
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('cc-shell bundle — tool-notebook-edit row (NotebookEdit over the vendored ToolRuntime)', () => {
  it('registers the NotebookEdit tool and marks it exclusively scheduled', async () => {
    const { ctx, dispose } = await mountNotebookEdit()
    expect(ctx.tools.schemas().map(s => s.name)).toEqual(['NotebookEdit'])
    expect(ctx.tools.get('NotebookEdit')?.isConcurrencySafe?.({})).toBe(false)
    await dispose()
  })

  it('replaces a cell through the vendored ToolRuntime + ctx.fs seam', async () => {
    const { ctx, dir, dispose } = await mountNotebookEdit()
    const path = join(dir, 'book.ipynb')
    writeFileSync(path, sampleNotebook())
    await observeRead(ctx, path)

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('cc-notebook-edit'),
      name: 'NotebookEdit',
      arguments: { notebook_path: path, cell_id: 'c1', new_source: 'print(2)' },
    })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ edit_mode: 'replace', cell_id: 'c1', error: '' })

    const onDisk = JSON.parse(readFileSync(path, 'utf8'))
    expect(onDisk.cells[0].source).toBe('print(2)')
    expect(onDisk.cells[0].execution_count).toBeNull()
    expect(onDisk.cells[0].outputs).toEqual([])
    await dispose()
  })
})
