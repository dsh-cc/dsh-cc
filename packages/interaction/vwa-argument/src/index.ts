/**
 * @dsh-cc/vwa-argument — VWA lane-2 argumentation contracts (design
 * docs/plans/2026-10-16-vwa-evidence-argument.md). DEFAULT-OFF (§13): with
 * `semantic-enabled: false`, `apply` registers only the settings namespace
 * and the /vwa command. When enabled it adds the author tools, the
 * per-session capture wiring, per-call review collaborators (review-host.ts)
 * and the workspace-bound `vwa-argument` delivery service.
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
import { registerCaptureWiring, readWorkspaceArtifact, SessionCaptures } from './capture-wiring.ts'
import { readUserSettingsSync, registerSettings } from './settings.ts'
import { registerVwaArgumentService } from './report.ts'
import { commandDeps } from './command-host.ts'
import { registerVwaCommand } from './commands.ts'
import { hostDeliveryDeps } from './host-delivery.ts'
import { createReviewFactory } from './review-host.ts'

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
export { computeDeletionClosure, findReferencesDetailed, type ReferenceInfo } from './references.ts'
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
  type ReviewCollaborators,
  type ToolDeps,
  type ToolRegistrar,
} from './tools.ts'
export {
  captureEventOf,
  readWorkspaceArtifact,
  registerCaptureWiring,
  sessionKeyOf,
  SessionCaptures,
} from './capture-wiring.ts'
export { budgetFrom, createReviewFactory, resolveReviewerRoute } from './review-host.ts'
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
  VwaArgumentHost,
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
 * No services injected at load: the tool/command mounts use their own
 * ctx.inject sub-plugins, and llm/jobs are read per call through the guarded
 * ctx.get path so a host without them still mounts (review answers
 * REVIEW_UNAVAILABLE).
 */
export const inject: string[] = []

/**
 * Mount the plugin: the settings namespace and /vwa plus, only when
 * `vwa-argument.semantic-enabled` is true in the raw settings file, the
 * lane-2 tools, capture wiring and delivery service. cc/lane-1 is unchanged.
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
    // cordis `ctx.inject(deps, cb)` calls cb with the INJECTED CONTEXT (a
    // sub-plugin whose inject is `deps`), not with the service itself.
    ctx.inject(['commands'], (injected: Context) => {
      registerVwaCommand(
        { commands: (injected as unknown as { commands: { register(definition: unknown): unknown } }).commands },
        commandDeps(ctx, workspaceRootOf),
      )
    })
  } catch {
    // Fail-soft: the command must never break mounting.
  }
  try {
    const dshHome = (ctx as unknown as { dshHomePath?: () => string | undefined }).dshHomePath?.()
    if (dshHome === undefined || !semanticEnabled(dshHome)) return
    const workspaceRoot = (agent: unknown): string | undefined => {
      try {
        return getSessionCwd(agent as never) ?? undefined
      } catch {
        return undefined
      }
    }
    // §10.3: trusted capture events come from the host tool pipeline, per session.
    const captures = new SessionCaptures()
    registerCaptureWiring(ctx, captures, workspaceRoot)
    // Appendix A: the frozen-handle service, registered structurally
    // (vwa-evidence consumes it via cordis `ctx.get` in slice 5).
    // Bound to the caller's workspace per call (forWorkspace), never process.cwd().
    const deliveryHost = registerVwaArgumentService(
      ctx as unknown as { provide(name: string, value: unknown): unknown },
      (agent, root) => hostDeliveryDeps(ctx, dshHome, agent, root),
    )
    ctx.inject(['tools'], (injected: Context) => {
      registerArgumentTools(
        { tools: (injected as unknown as { tools: { register: ToolRegistrar['register'] } }).tools },
        {
          workspaceRoot,
          report: (root, agent) => deliveryHost.forWorkspace(root, agent),
          captures: (agent: unknown) => captures.for(agent),
          artifactTexts: new Map(),
          readArtifact: readWorkspaceArtifact,
          snapshotTexts: new Map(),
          maxEntities: readUserSettingsSync(dshHome)['project-max-entities'],
          // §13/Appendix A: llm + jobs + alias route resolved per call (review-host.ts).
          review: createReviewFactory(ctx, dshHome),
        },
      )
    })
  } catch {
    // Fail-soft: the gate must never break mounting.
  }
}
