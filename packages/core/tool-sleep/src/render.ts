/**
 * Pure presentation (presentCall / presentResult) for the Sleep tool: a
 * generic pending card naming the requested duration, and a generic result
 * card that fences errors so a failure reads distinct from a success summary.
 * @module @dsh-cc/tool-sleep/render
 */

import type { GenericCallView, ToolResult, ToolResultView } from '@dsh-cc/tools'

/** Arguments accepted by the Sleep tool. */
export interface SleepToolArgs {
  /** How long to wait, in seconds. */
  duration: number
}

/**
 * Present a Sleep pending call as a generic execute card naming the duration.
 * @param args - validated tool arguments.
 * @returns a generic card view.
 */
export function presentSleepCall(args: SleepToolArgs): GenericCallView {
  const seconds = args.duration
  return {
    card: 'generic',
    title: 'Sleeping',
    kind: 'execute',
    rawInput: `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`,
    content: [
      {
        type: 'text',
        text: `Wait for ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`,
      },
    ],
  }
}

/**
 * Present a Sleep result as a generic card. Success shows the plain message;
 * errors are fenced so a failure is visually distinct from a success summary.
 * @param _args - validated tool arguments (unused by the presenter).
 * @param result - the finalized tool result.
 * @returns a generic card view, or `undefined` for an unexpected shape.
 */
export function presentSleepResult(_args: unknown, result: ToolResult): ToolResultView | undefined {
  const block = result.content.length === 1 ? result.content[0] : undefined
  if (block === undefined || block.type !== 'text') return undefined
  return result.isError
    ? { card: 'generic', content: [{ type: 'text', text: `\`\`\`\n${block.text.replace(/\n+$/, '')}\n\`\`\`` }] }
    : { card: 'generic', content: [{ type: 'text', text: block.text }] }
}
