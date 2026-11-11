/**
 * The per-lane half of the shared bridge-lane library.
 *
 * `lexer.mjs`, `argv.mjs` and `canonical.mjs` are GENERATED into each bridge
 * from `scripts/lib/bridge-lane/`; they are byte-identical apart from the
 * banner and read every lane-specific value from THIS file. Each bridge ships
 * its own copy of this module — it is the only per-lane input.
 *
 * This copy is the author-side self-test lane: the authored library imports
 * `./lane.mjs` too, so the author tree is self-consistent and can be executed
 * and tested without a bridge present. It is NEVER generated and never shipped.
 *
 * @module scripts/lib/bridge-lane/lane
 */

export const LANE = {
  /** Plugin package name, as it appears in the armed/refused prompt blocks. */
  name: 'cc-bridge-lane',
  /** Launcher file resolved from each hook's own `import.meta.url`. */
  launcherFile: 'lane-selftest-run.mjs',
  /** Example canonical launcher anchor used by the shared fixture table. */
  canonicalLauncher: '/opt/dsh-cc/cc-bridge-lane/scripts/lane-selftest-run.mjs',
  /** Armed headline subject, e.g. "the Grok review lane". */
  headline: 'the bridge lane',
  /** The noun after "this canonical invocation for a …" in the armed block. */
  invocationSubject: 'bridge call',
  /** One-line example prompt in the armed invocation. */
  promptExample: 'the request, single line',
  /**
   * The multi-line guidance sentence. It mentions the dash-leading rule only
   * on a lane that rejects dash-leading prompts.
   */
  multiLineNote: 'For a multi-line prompt, write the text to a file inside this workspace (or the canonical tmpdir), then run:',
  /** `--last` clause, read as "…to continue <this>". */
  lastClause: 'the previous thread (it resumes the most recent thread for this workspace)',
  /**
   * Transport-specific prompt rejections. The Codex lane pipes the prompt
   * through the child's stdin, so a `\r` or a leading `-` is plain data; the
   * Grok lane passes it as the `-p` argv value, where a leading `-` is
   * re-parsed as a flag and `\r` breaks the line — that lane enables both.
   */
  rejectCarriageReturnInPrompt: false,
  rejectDashLeadingInlinePrompt: false,
  /** Machine reason for a break-bearing prompt; the lanes historically differ. */
  lineBreakReason: 'prompt-newline',
  /** Execution subject in the refused block, e.g. "Grok review". */
  action: 'Bridge lane execution',
}
