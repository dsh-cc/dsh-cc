/**
 * Pinned resume descriptors for continuable background subagents.
 *
 * This unit ships the pin schema + tolerant reader/writer, the per-child
 * {@link PinStore}, the definition fingerprint utilities, the pure gate and
 * overlay layers, the `subagents-resume` policy namespace, and the cordis
 * plugin (gate + overlay + notices + settings). The spawn capture lives in
 * `@dsh-cc/subagent-task` (it is cordis-facing on the Task tool side).
 *
 * @module @dsh-cc/subagent-resume-pins
 */

export { PinParseError, parsePin, writePin, canonicalJson, PIN_VERSION } from './pin.ts'
export type {
  ResumePin,
  ResumePinDraft,
  PinDefinition,
  PinDefinitionSource,
  PinEffective,
  PinModelSelector,
  PinMode,
  PinResume,
  PinToolFilter,
  PinWorkspace,
  ModelSelectorVia,
} from './pin.ts'
export { PinStore, type CorruptPin } from './store.ts'
export { definitionFingerprint, personaHash, sha256Prefixed } from './fingerprint.ts'
export {
  RESUME_POLICY_DEFAULTS,
  RESUME_POLICY_NAMESPACE,
  readResumePolicy,
  type OnDefinitionChanged,
  type OnUnavailableModel,
  type OnWorkspaceChanged,
  type ResumePolicy,
} from './policy.ts'
export {
  evaluateGate,
  type DenyCode,
  type GateDecision,
  type GateDetailedRoute,
  type GateEnv,
  type GateResolvedConfig,
} from './gate.ts'
export { PinBlockedError, applyPinOverlay } from './overlay.ts'
export {
  RESUME_PIN_STORE,
  ResumePolicySchema,
  apply as applyResumePinsPlugin,
  name as resumePinsPluginName,
  type ResumePinsPluginConfig,
} from './plugin.ts'
// cordis-plugin-loader unwrapExports mounts the package root: it needs the
// canonical `apply`/`name`, not just the aliases above.
export { apply, name } from './plugin.ts'
export type { OverlayTuple } from './pin.ts'
