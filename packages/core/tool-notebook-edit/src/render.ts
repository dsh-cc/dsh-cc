/**
 * Pure presentation (presentCall / presentResult) for the NotebookEdit tool: a
 * generic pending card naming the target notebook and the resolved edit mode,
 * and a generic result card that fences errors so a failure reads distinct
 * from a success summary.
 * @module @dsh-cc/tool-notebook-edit/render
 */

import type {
  GenericCallView,
  ToolResult,
  ToolResultView,
} from '@dsh-cc/tools'

/** Arguments accepted by the NotebookEdit tool. */
export interface NotebookEditArgs {
  /** Absolute path to the Jupyter notebook to edit. */
  notebook_path: string
  /** The cell to edit; omitted inserts at the beginning when mode is insert. */
  cell_id?: string
  /** The new source for the cell. */
  new_source: string
  /** The cell type (code/markdown); required for insert, else defaults. */
  cell_type?: 'code' | 'markdown'
  /** replace (default), insert, or delete. */
  edit_mode?: 'replace' | 'insert' | 'delete'
}

/** The canonical result of a NotebookEdit call. */
export interface NotebookEditResult {
  new_source: string
  cell_id?: string
  cell_type: 'code' | 'markdown'
  language: string
  edit_mode: string
  error: string
  notebook_path: string
  original_file: string
  updated_file: string
}

/**
 * Present a NotebookEdit pending call as a generic execute card naming the
 * target notebook and the requested edit mode.
 * @param args - validated tool arguments.
 * @returns a generic card view.
 */
export function presentNotebookEditCall(
  args: NotebookEditArgs,
): GenericCallView {
  const mode = args.edit_mode ?? 'replace'
  return {
    card: 'generic',
    title: 'Editing Notebook',
    kind: 'execute',
    rawInput: `${args.notebook_path} (${mode})`,
    content: [
      {
        type: 'text',
        text:
          args.cell_id === undefined
            ? `${mode} in ${args.notebook_path}`
            : `${mode} cell ${args.cell_id} in ${args.notebook_path}`,
      },
    ],
  }
}

/**
 * Present a NotebookEdit result as a generic card. Success shows the written
 * cell id and source; a failed value (error text present) is fenced so it reads
 * distinct from a success summary.
 * @param _args - validated tool arguments (unused by the presenter).
 * @param result - the finalized tool result.
 * @returns a generic card view, or `undefined` for an unexpected shape.
 */
export function presentNotebookEditResult(
  _args: unknown,
  result: ToolResult,
): ToolResultView | undefined {
  const block = result.content.length === 1 ? result.content[0] : undefined
  if (block === undefined || block.type !== 'text') return undefined
  return result.isError
    ? {
        card: 'generic',
        content: [
          { type: 'text', text: `\`\`\`\n${block.text.replace(/\n+$/, '')}\n\`\`\`` },
        ],
      }
    : { card: 'generic', content: [{ type: 'text', text: block.text }] }
}
