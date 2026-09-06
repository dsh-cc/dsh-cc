/**
 * Format provider-neutral tool presentation views for the transcript trail.
 * Structural types only — no harness or tools-package imports, so the Ink
 * tree stays behind the adapter boundary.
 * @module @dsh-cc/tui/tool-card
 */

export interface FileDiff {
  path: string
  oldText: string | null
  newText: string
}

export type ToolCallView =
  | { card: 'generic'; title: string; rawInput?: unknown }
  | { card: 'terminal'; title: string; description?: string; cwd?: string }
  | { card: 'diff'; title: string; diffs: FileDiff[] }

export type ToolResultView =
  | { card: 'generic'; title?: string; content?: { type: string; text?: string }[] }
  | { card: 'terminal'; title?: string; output?: string; exitCode?: number; signal?: string }
  | { card: 'diff'; title?: string; diffs: FileDiff[] }
  | { card: 'search'; title?: string }
  | { card: 'read'; title?: string }
  | { card: 'web'; title?: string }

export interface FormattedCard {
  title: string
  body?: string
}

export interface FormattedResult extends FormattedCard {
  error: boolean
}

function lineCount(text: string): number {
  if (text.length === 0) return 0
  const parts = text.split('\n')
  return parts.at(-1) === '' ? parts.length - 1 : parts.length
}

function diffSummary(diffs: readonly FileDiff[]): string {
  return diffs.map(diff => {
    if (diff.oldText === null) {
      return `${diff.path} +${lineCount(diff.newText)}`
    }
    const oldLines = diff.oldText.split('\n')
    const newLines = diff.newText.split('\n')
    let added = 0
    let removed = 0
    const oldSet = new Map<string, number>()
    for (const line of oldLines) oldSet.set(line, (oldSet.get(line) ?? 0) + 1)
    for (const line of newLines) {
      const remaining = oldSet.get(line) ?? 0
      if (remaining > 0) oldSet.set(line, remaining - 1)
      else added += 1
    }
    for (const count of oldSet.values()) removed += count
    const bits = [
      added > 0 ? `+${added}` : '',
      removed > 0 ? `-${removed}` : '',
    ].filter(part => part.length > 0)
    return `${diff.path}${bits.length > 0 ? ` ${bits.join(' ')}` : ''}`
  }).join(', ')
}

function contentText(blocks: { type: string; text?: string }[] | undefined): string | undefined {
  if (blocks === undefined) return undefined
  const text = blocks
    .map(block => typeof block.text === 'string' ? block.text : '')
    .filter(part => part.length > 0)
    .join('\n')
    .trim()
  return text.length > 0 ? text : undefined
}

/**
 * Format a pending tool call. Prefer the tagged view; fall back to name + args.
 */
export function formatCallCard(
  view: ToolCallView | undefined,
  fallback: { name: string; args: string },
): FormattedCard {
  if (view === undefined) {
    return {
      title: fallback.name,
      ...fallback.args.length > 0 ? { body: fallback.args } : {},
    }
  }
  if (view.card === 'terminal') {
    return {
      title: view.title,
      ...view.cwd === undefined ? {} : { body: `cwd ${view.cwd}` },
    }
  }
  if (view.card === 'diff') {
    return { title: view.title, body: diffSummary(view.diffs) }
  }
  return { title: view.title }
}

/**
 * Format a completed tool call. Prefer the tagged view; fall back to raw text.
 */
export function formatResultCard(
  view: ToolResultView | undefined,
  fallback: { pendingTitle: string; fallback: string; error?: boolean },
): FormattedResult {
  if (view === undefined) {
    return {
      title: fallback.pendingTitle,
      ...fallback.fallback.length > 0 ? { body: fallback.fallback } : {},
      error: fallback.error === true,
    }
  }
  if (view.card === 'terminal') {
    const bits = [
      view.exitCode === undefined ? undefined : `exit ${view.exitCode}`,
      view.signal === undefined ? undefined : view.signal,
      view.output?.trim(),
    ].filter((bit): bit is string => bit !== undefined && bit.length > 0)
    return {
      title: view.title ?? fallback.pendingTitle,
      ...bits.length > 0 ? { body: bits.join('\n') } : {},
      error: (view.exitCode !== undefined && view.exitCode !== 0) || view.signal !== undefined,
    }
  }
  if (view.card === 'diff') {
    return {
      title: view.title ?? fallback.pendingTitle,
      body: diffSummary(view.diffs),
      error: false,
    }
  }
  const body = contentText('content' in view ? view.content : undefined) ?? fallback.fallback
  return {
    title: view.title ?? fallback.pendingTitle,
    ...body.length > 0 ? { body } : {},
    error: fallback.error === true,
  }
}
