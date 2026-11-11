/**
 * The per-lane half of the shared bridge-lane library — the Grok review lane.
 *
 * `lexer.mjs`, `argv.mjs` and `canonical.mjs` in this directory are GENERATED
 * from `scripts/lib/bridge-lane/` (byte-identical in both bridges apart from
 * the banner) and read every lane-specific value from THIS file.
 *
 * Transport fact behind the two validation flags: this lane passes the prompt
 * as the VALUE of `-p`, so the Grok CLI re-parses a leading `-` as a flag
 * (probed: clap misparse, exit 2) and a `\r` terminates the line. Both are
 * therefore rejected, and dash-leading prompts must use `--prompt-file`.
 *
 * @module @dsh-cc/plugin-cc-grok-bridge/scripts/lib/lane
 */

export const LANE = {
  name: 'cc-grok-bridge',
  launcherFile: 'grok-review-run.mjs',
  canonicalLauncher: '/opt/dsh-cc/cc-grok-bridge/scripts/grok-review-run.mjs',
  headline: 'the Grok review lane',
  invocationSubject: 'Grok review',
  promptExample: 'the review request, single line',
  multiLineNote: 'For a multi-line prompt (or any request whose first character is `-` — dash-leading inline prompts are rejected by the launcher), write the text to a file inside this workspace (or the canonical tmpdir), then run:',
  lastClause: 'the previous review (it resumes the most recent review thread for this workspace)',
  action: 'Grok review',
  rejectCarriageReturnInPrompt: true,
  rejectDashLeadingInlinePrompt: true,
  lineBreakReason: 'control-char-in-prompt',
}
