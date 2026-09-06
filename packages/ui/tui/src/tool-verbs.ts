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
 * Map a tool name to a present-tense verb for its running label. The match is
 * case-insensitive on the exact name; unknown names return "Calling".
 */
export function toolVerb(name: string): string {
  return VERBS[name.toLowerCase()] ?? 'Calling'
}
