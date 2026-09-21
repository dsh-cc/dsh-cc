/**
 * Present-tense verb for a running tool row. Lowercase match on the tool name;
 * unknown names fall back to "Calling". Completed rows drop the verb and show
 * only a glyph, so this map only drives the in-progress label.
 * @module @dsh-cc/tui/tool-verbs
 */

const VERBS: Readonly<Record<string, string>> = {
  bash: 'Running',
  shell: 'Running',
  read: 'Reading',
  write: 'Writing',
  edit: 'Editing',
  glob: 'Searching',
  grep: 'Searching',
  search: 'Searching',
  fetch: 'Fetching',
  web: 'Fetching',
  task: 'Delegating',
  agent: 'Delegating',
  todo: 'Tracking',
}

/**
 * True when the title already opens with the tool's own display name as a
 * word (`Read <path>`) so the running verb (`Reading`) would only duplicate
 * it. Bare-name titles (the delta/no-presenter state, title === name) keep
 * the verb — there it is the only running cue. Empty names never suppress.
 */
export function verbIsRedundant(title: string, name: string): boolean {
  if (name.length === 0) return false
  if (title.length <= name.length) return false
  if (!title.toLowerCase().startsWith(name.toLowerCase())) return false
  // Word boundary required: "Readme notes" must not suppress for "read".
  return !/[A-Za-z0-9_]/.test(title[name.length] ?? '')
  // Accepted false positive: title "bash build.sh" with name "bash" returns
  // true — the title is self-describing, so skipping a special case is fine.
}

/**
 * Map a tool name to a present-tense verb for its running label. The match is
 * case-insensitive on the exact name; unknown names return "Calling".
 */
export function toolVerb(name: string): string {
  return VERBS[name.toLowerCase()] ?? 'Calling'
}
