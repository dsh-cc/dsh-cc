/**
 * The per-lane half of the shared bridge-lane library — the Codex rescue lane.
 *
 * `lexer.mjs`, `argv.mjs` and `canonical.mjs` in this directory are GENERATED
 * from `scripts/lib/bridge-lane/` (byte-identical in both bridges apart from
 * the banner) and read every lane-specific value from THIS file.
 *
 * Transport fact behind the two validation flags: this lane hands the prompt
 * to Codex on the child's STDIN (`codex rescue` pushes `-` as the final argv
 * element), so a leading `-` or a `\r` never gets re-parsed as a flag — both
 * stay plain data and are accepted.
 *
 * @module @dsh-cc/plugin-cc-codex-bridge/scripts/lib/lane
 */

export const LANE = {
  name: 'cc-codex-bridge',
  launcherFile: 'codex-rescue-run.mjs',
  canonicalLauncher: '/opt/dsh-cc/cc-codex-bridge/scripts/codex-rescue-run.mjs',
  headline: 'the Codex rescue lane',
  invocationSubject: 'rescue',
  promptExample: 'the rescue prompt, single line',
  multiLineNote: 'For a multi-line prompt, write the text to a file inside this workspace (or the canonical tmpdir), then run:',
  lastClause: 'the previous rescue (it resumes the most recent rescue thread)',
  action: 'Codex rescue',
  rejectCarriageReturnInPrompt: false,
  rejectDashLeadingInlinePrompt: false,
  lineBreakReason: 'prompt-newline',
}
