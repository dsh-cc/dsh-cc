/**
 * Pure `/init` payload: the CC-faithful CLAUDE.md initialization prompt and its
 * assembly into user-message content. No cordis imports.
 * @module @dsh-cc/command-init/init
 */

/**
 * A faithful port of Claude Code's `/init` instruction: analyze the repository
 * structure, document build/test conventions, and write (or refresh) CLAUDE.md.
 */
export const INIT_PROMPT = `Analyze the current repository and write a CLAUDE.md file at the repository root that will help future coding sessions.

Steps:
1. Explore the repository structure: top-level directories, key source files, language, and framework.
2. Identify the exact commands to build and test the project, and how to run them.
3. Note the codebase's conventions: naming, formatting, package layout, and any documented workflow.
4. Write CLAUDE.md with sections covering: project overview, common commands, code style and conventions, and how to verify changes.

If a CLAUDE.md already exists, refresh it in place, preserving what remains accurate and updating what has changed. Do not invent commands — verify them against what the repository actually defines.`

/** Return the user-message content block for `/init`. */
export function initContent(): { type: 'text'; text: string } {
  return { type: 'text', text: INIT_PROMPT }
}
