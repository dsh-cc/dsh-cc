/**
 * @dsh-cc/vwa-argument — VWA lane-2 argumentation contracts (design
 * docs/plans/2026-10-16-vwa-evidence-argument.md). Slice 1 (P0): package
 * face, JSON Schema contracts + Ajv validation entry, settings namespace.
 * The feature is INERT and DEFAULT-OFF: `apply` registers settings and
 * nothing else — no listeners, no tools, no review runs yet (§23 P0).
 *
 * Ownership boundaries (§3): `@dsh-cc/vwa-evidence` stays the sole receipt
 * writer and does NOT import this package; this package imports it one-way
 * (stableJson/sha256Hex re-exports). `ReceiptV2` as a TS type lives in
 * vwa-evidence; the validating schema lives here (§16.1).
 *
 * @module @dsh-cc/vwa-argument
 */

import type { Context } from '@deepseek-ai/cordis'
import { getSessionCwd } from '@dsh-cc/session-cwd'
import { registerArgumentTools, semanticEnabled, type ToolRegistrar } from './tools.ts'
import { CaptureRegistry } from './sources.ts'
import { readUserSettingsSync, registerSettings } from './settings.ts'
import { registerVwaArgumentService } from './report.ts'
import { registerVwaCommand } from './commands.ts'

export {
  DEFAULT_VWA_ARGUMENT_SETTINGS,
  SETTINGS_NAMESPACE,
  SettingsSchema,
  readUserSettingsSync,
  registerSettings,
  type VwaArgumentSettings,
} from './settings.ts'

export {
  codeUnitLength,
  isHash,
  isPrefixedId,
  isUuidV4,
  sha256Hex,
  spanError,
  spanInString,
  stableJson,
  validateAdjudicationRecord,
  validateAssessment,
  validateExtractionRecord,
  validateExtractedAtomicClaim,
  validateProjectSnapshot,
  validateReceiptV2,
  validateReviewRecord,
  validateReviewResponse,
} from './schema.ts'

export * from './types.ts'
export {
  executeVwa,
  parseVwaArgs,
  readPointer,
  registerVwaCommand,
  writePointer,
  type CurrentProjectPointer,
  type ParsedVwaArgs,
  type VwaCommandDeps,
  type VwaSubcommand,
  VWA_SUBCOMMANDS,
  VWA_USAGE,
} from './commands.ts'
export {
  buildReverseIndex,
  dependencyDigest,
  entityContentHash,
  findEntity,
  invalidationScope,
  type EntityKind,
  type ReverseIndex,
} from './dependencies.ts'
export {
  applyMutation,
  assertNoSupportCycle,
  findReferences,
  newEntityId,
  validateEvidenceAgainstSnapshot,
  GraphContext,
  type CreateType,
  type IdOrNew,
  type Mutation,
  type MutationOutcome,
} from './graph.ts'
export { applyBindArtifact, validateArtifactPath } from './artifact.ts'
export { acquireLock, lockHeld, releaseLock } from './lock.ts'
export {
  CAPTURE_WHITELIST,
  CaptureRegistry,
  rawSha256,
  registerSourceApply,
  verifySnapshot,
  type CaptureEvent,
  type RegisterOutcome,
  type RegisterSourceInput,
} from './sources.ts'
export {
  mountArgumentTools,
  registerArgumentTools,
  semanticEnabled,
  type ToolDefinition,
  type ToolDeps,
  type ToolRegistrar,
} from './tools.ts'
export {
  fail,
  ProjectStore,
  VwaFail,
  type DurabilityIo,
  type Fail,
  type Head,
  type Ok,
  type OperationRecord,
  type Result,
  type RevisionEnvelope,
  type StagedFile,
  type StoreOptions,
  type TransactionInput,
} from './store.ts'
export {
  computeAssessments,
  dispositionFor,
  activeMajorCount,
  gradeClaim,
  oppositionFor,
  POLICY_VERSION,
  reviewStateFor,
  supportPaths,
  strongestOpposition,
  digestRecords,
  type Grade,
  type Opposition,
  type PolicyWorld,
  type ReviewDigest,
  type SupportPath,
} from './policy.ts'
export {
  ReviewInvalidError,
  createReviewAdapter,
  forcedRespondTools,
  parseReviewResponse,
  validateTaskResponse,
  type PreparedReviewCall,
  type ReviewLlmFace,
  type ReviewMessages,
  type ReviewModelAdapter,
  type ReviewTaskContract,
  type ReviewerRoute,
} from './review-adapter.ts'
export {
  claimClosure,
  computeCoreSet,
  planStage,
  rootBlocks,
  type ReviewStage,
  type ReviewTask,
} from './review-plan.ts'
export {
  ReviewRunStore,
  cacheKey,
  detectDisagreement,
  disagreementFinding,
  recordReusable,
  type UsageRow,
} from './review-run-store.ts'
export {
  BudgetTracker,
  createHostTaskService,
  executeReviewRun,
  loadPrompt,
  policyHash,
  promptHash,
  responseSchemaFor,
  RUBRIC_VERSION,
  type ReviewBudget,
  type ReviewRunnerDeps,
  type ReviewRunOutcome,
  type ReviewTaskService,
} from './review-runner.ts'
export {
  AuditInvalidError,
  executeAudit,
  EXTRACT_RESPONSE_SCHEMA,
  extractionUnits,
  stripClaimMarkers,
  type AlignEnvelope,
  type AuditOutcome,
  type ExtractEnvelope,
  type ExtractionUnit,
} from './audit.ts'
export {
  computeBindingDigest,
  InputChangedError,
  registerVwaArgumentService,
  validateAdjudicationSource,
  VwaArgumentService,
  type DeliveryCheck,
  type FrozenEvaluation,
  type VwaArgumentServiceDeps,
} from './report.ts'
export {
  HONESTY,
  mapMechanical,
  REPORT_TEMPLATE,
  renderReportJson,
  renderReportMarkdown,
  type GateEntry,
  type ReportInput,
} from './report-render.ts'

/** Cordis plugin id (mount-row name `@dsh-cc/vwa-argument`). */
export const name = 'vwa-argument'

/**
 * No services injected at load: the tool mount is conditional on the
 * semantic-enabled feature gate (§13) and happens inside apply.
 */
export const inject: string[] = []

/**
 * Mount the plugin: the settings namespace (§23 P0) plus, only when
 * `vwa-argument.semantic-enabled` is true in the raw settings file, the
 * three author tools (§10.3/§10.4/§10.5) through the `tools` service.
 * Workspace-root and capture-event wiring stays at the turn seam (a later
 * slice mirrors vwa-evidence's wiring.ts); cc/lane-1 is unchanged.
 * @param ctx - the plug context.
 */
export function apply(ctx: Context): void {
  registerSettings(ctx)
  // The /vwa command is USER-SURFACE (§10.2): it is registered regardless of
  // the semantic-enabled tool gate — /vwa init is how a user starts lane 2.
  // Tools stay gated below.
  try {
    const workspaceRootOf = (agent: unknown): string | undefined => {
      try {
        return getSessionCwd(agent as never) ?? undefined
      } catch {
        return undefined
      }
    }
    ctx.inject(['commands'], (commands: unknown) => {
      registerVwaCommand(
        { commands: commands as { register(definition: unknown): unknown } },
        { workspaceRoot: workspaceRootOf },
      )
    })
  } catch {
    // Fail-soft: the command must never break mounting.
  }
  try {
    const dshHome = (ctx as unknown as { dshHomePath?: () => string | undefined }).dshHomePath?.()
    if (dshHome === undefined || !semanticEnabled(dshHome)) return
    const captures = new CaptureRegistry()
    // Appendix A: the frozen-handle service, registered structurally
    // (vwa-evidence consumes it via cordis `ctx.get` in slice 5).
    registerVwaArgumentService(
      ctx as unknown as { service(name: string, value: unknown): unknown },
      { root: process.cwd() },
    )
    ctx.inject(['tools'], (tools: unknown) => {
      registerArgumentTools(
        { tools: tools as unknown as { register: ToolRegistrar['register'] } },
        {
          workspaceRoot: (agent: unknown) => {
            try {
              return getSessionCwd(agent as never) ?? undefined
            } catch {
              return undefined
            }
          },
          captures,
          artifactTexts: new Map(),
          snapshotTexts: new Map(),
          maxEntities: readUserSettingsSync(dshHome)['project-max-entities'],
        },
      )
    })
  } catch {
    // Fail-soft: the gate must never break mounting.
  }
}
