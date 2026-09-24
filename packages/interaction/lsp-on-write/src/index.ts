/**
 * LSP diagnostics-on-write (design doc docs/plans/2026-09-23-lsp-diagnostics-on-write.md):
 * after a successful edit/write/NotebookEdit, pull the touched file's current
 * diagnostics from the running serena language servers through the
 * `mcpConnections` registry (one uncached `tools/call`, never the tools
 * waterfall) and append them into the SAME tool result — errors surface in
 * the model's next step instead of at test time.
 *
 * Plain plugin (not a Service): `apply(ctx)`, no isolate key (twelve-key
 * isolate map untouched). Settings are registered for /config UX only;
 * trigger logic reads the raw user file per event (§4.6). Ships dark:
 * `cc-lsp-on-write.enabled` defaults to false.
 *
 * @module @dsh-cc/lsp-on-write
 */

import type { Context } from '@deepseek-ai/cordis'
import { registerSettings } from './settings.ts'
import { registerListener } from './wiring.ts'

export {
  SETTINGS_NAMESPACE,
  SettingsSchema,
  DEFAULT_LSP_SETTINGS,
  registerSettings,
  readUserSettings,
  type LspOnWriteSettings,
  type MinSeverity,
} from './settings.ts'
export { DEFAULT_TOOL_NAMES, matchTool } from './match.ts'
export {
  DIAGNOSTICS_TOOL,
  BLOCK_CAP_BYTES,
  parseDiagnostics,
  pullDiagnostics,
  renderDiagnosticsBlock,
  type LspDiagnostic,
  type DiagnosticsMap,
  type PulledDiagnostics,
} from './diagnostics.ts'
export { composeLspBlock } from './compose.ts'
export { registerListener, BREAKER_THRESHOLD } from './wiring.ts'

/**
 * Mount the plugin: register the settings namespace and the post-execute
 * listener. Inert when disabled (default) or when no dshHome is available.
 * @param ctx - the plug context.
 */
export function apply(ctx: Context): void {
  registerSettings(ctx)
  registerListener(ctx)
}
