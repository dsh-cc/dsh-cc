/**
 * Pure presentation (presentCall / presentResult) and message rendering for
 * the git-worktree tools. All functions are pure in their arguments so the
 * registry can replay them against logged call metadata.
 * @module @dsh-cc/tool-git-worktree/render
 */

import type { GenericCallView, ToolResult, ToolResultView } from '@dsh-cc/tools'

/** Arguments accepted by the EnterWorktree tool. */
export interface EnterWorktreeArgs {
  name?: string
}

/** Arguments accepted by the ExitWorktree tool. */
export interface ExitWorktreeArgs {
  action: 'keep' | 'remove'
  discard_changes?: boolean
}

/**
 * Present an EnterWorktree pending call as a generic execute card.
 * @param args - validated tool arguments.
 * @returns a generic card view.
 */
export function presentEnterCall(args: EnterWorktreeArgs): GenericCallView {
  return {
    card: 'generic',
    title: 'Creating worktree',
    kind: 'execute',
    rawInput: args.name ?? '(generated name)',
    content: [
      {
        type: 'text',
        text: args.name === undefined
          ? 'Create a new git worktree with a generated name and switch the session into it.'
          : `Create a new git worktree "${args.name}" and switch the session into it.`,
      },
    ],
  }
}

/**
 * Present a worktree tool result as a generic card with a human-readable
 * summary. Both tools share this presenter because their result shapes are the
 * same — a plain message on success, fenced text on error so a failure is
 * visually distinct from a success summary.
 * @param _args - validated tool arguments (unused by the presenter).
 * @param result - the finalized tool result.
 * @returns a generic card view, or `undefined` for an unexpected shape.
 */
export function presentWorktreeResult(_args: unknown, result: ToolResult): ToolResultView | undefined {
  const block = result.content.length === 1 ? result.content[0] : undefined
  if (block === undefined || block.type !== 'text') return undefined
  return result.isError
    ? { card: 'generic', content: [{ type: 'text', text: `\`\`\`\n${block.text.replace(/\n+$/, '')}\n\`\`\`` }] }
    : { card: 'generic', content: [{ type: 'text', text: block.text }] }
}

/**
 * Present an ExitWorktree pending call. A `remove` is the destructive branch
 * and is surfaced with a generic execute card whose content states the deletion
 * consequence; `keep` is a generic card stating that nothing is deleted.
 * @param args - validated tool arguments.
 * @returns a generic card view.
 */
export function presentExitCall(args: ExitWorktreeArgs): GenericCallView {
  const removing = args.action === 'remove'
  return {
    card: 'generic',
    title: removing ? 'Removing worktree' : 'Keeping worktree',
    kind: 'execute',
    rawInput: removing ? 'remove' : 'keep',
    content: [
      {
        type: 'text',
        text: removing
          ? 'Remove the active worktree and its branch. This deletes the worktree directory'
            + (args.discard_changes === true ? ' and discards any uncommitted changes and commits' : '')
            + '.'
          : 'Leave the active worktree and its branch on disk and return to the original directory.',
      },
    ],
  }
}
