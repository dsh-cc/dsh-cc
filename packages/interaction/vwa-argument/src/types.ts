/**
 * TS types mirroring `src/contracts/author.schema.json` and
 * `src/contracts/review.schema.json` (design
 * docs/plans/2026-10-16-vwa-evidence-argument.md §5/§6 normative blocks).
 *
 * The JSON Schemas are the validation source of truth; these types must be
 * kept structurally identical (§5: maintaining two drifting rule sets is not
 * allowed — the schema-vs-type fixtures in tests/ pin the pair).
 *
 * Naming note (§6/§11.4): `ExtractedAtomicClaim` is ONE extracted atomic
 * claim record; the extract-stage response wrapper is `ExtractionRecord`.
 * The two names must not be conflated. `ReceiptV2` is NOT defined here —
 * it is owned by the receipt writer `@dsh-cc/vwa-evidence` (§3/§16.1);
 * this package only ships the validating schema.
 *
 * @module @dsh-cc/vwa-argument/types
 */

export type Hash = string
export type Id = string
export type Span = { start: number; end: number }

export interface Ref {
  id: Id
  entityVersion: number
}

export interface Entity {
  id: Id
  entityVersion: number
  createdAt: string
  updatedAt: string
}

export type ClaimKind = 'fact' | 'source-report' | 'interpretation' | 'causal' | 'intent' | 'evaluation'

export interface Scope {
  subject: string
  corpus: Id[]
  time: string
  geography: string
  exclusions: string[]
}

export interface Source extends Entity {
  snapshotPath: string
  snapshotHash: Hash
  acquisition: { kind: 'tool-event' | 'user-file' | 'unverified'; capturedAt: string; eventRef?: string }
  title: string
  creators: string[]
  publication: string
  originalLocator: string
  edition: string
  language: string
  origin: 'external' | 'user-provided' | 'agent-generated'
  material: 'primary' | 'secondary' | 'literary-text' | 'other'
  lineage: { relation: 'independent' | 'derived' | 'unknown'; parentSourceIds: Id[]; note: string }
  authenticity: 'unverified' | 'documented' | 'questioned'
  authenticityBasisEvidenceIds: Id[]
}

export interface Evidence extends Entity {
  sourceId: Id
  sourceSnapshotHash: Hash
  span: Span
  quote: string
  contextSpan: Span
  originalLocation: string
  transformation: 'none' | 'translation' | 'transcription' | 'extraction'
  transformationNote: string
}

export interface Claim extends Entity {
  text: string
  kind: ClaimKind
  scope: Scope
  importance: 'core' | 'supporting'
  stance: 'asserted' | 'qualified' | 'hypothesis' | 'attributed'
  evaluationCriteria: string[]
}

export interface EvidenceGroup extends Entity {
  targetClaimId: Id
  evidenceIds: Id[]
  mode: 'all' | 'any'
  rationale: string
}

export interface Argument extends Entity {
  premiseClaimIds: Id[]
  evidenceGroupIds: Id[]
  conclusionClaimId: Id
  scheme: 'deductive' | 'causal' | 'abductive' | 'interpretive' | 'generalization' | 'evaluative'
  warrant: string
  assumptions: string[]
  limitations: string[]
}

export interface Issue extends Entity {
  targetId: Id
  kind: 'source-reliability' | 'counterevidence' | 'alternative-explanation' | 'missing-evidence' | 'inference-gap'
  description: string
  evidenceIds: Id[]
  relatedClaimIds: Id[]
  proposedImpact: 'qualify' | 'downgrade' | 'invalidate'
  response: string
  resolution: 'open' | 'addressed' | 'unresolved'
  gap?: { needed: string; distinguishes: string[]; nextAction: string; ifUnresolved: string }
}

export interface SearchLog extends Entity {
  purpose: string
  targetIds: Id[]
  corpus: Id[]
  query: string
  tool: string
  performedAt: string
  state: 'executed' | 'failed' | 'planned'
  resultSourceIds: Id[]
  inaccessible: string[]
  finding: 'relevant-found' | 'none-found' | 'inconclusive'
  executionEventRef?: string
  externalAttestation?: string
}

export interface Occurrence {
  claimId: Id
  span: Span
  exactText: string
}

export interface Artifact extends Entity {
  path: string
  contentHash: Hash
  occurrences: Occurrence[]
  outline: { section: string; goal: string; claimIds: Id[]; argumentIds: Id[]; qualifications: string[] }[]
}

export interface ProjectContract {
  /** Runtime-owned limits, frozen at initialization. */
  reviewSettings?: import('./review-config.ts').FrozenReviewSettings
  question: string
  language: string
  domain: 'history' | 'literature' | 'research'
  requiredQuestions: { id: string; text: string }[]
  plannedCorpus: string[]
  expectedCoreTopics: string[]
  mode: 'draft' | 'reviewed'
}

export interface ProjectSnapshot {
  schemaVersion: 1
  projectId: Id
  revision: number
  workspaceIdentity: Hash
  contract: ProjectContract
  sources: Source[]
  evidence: Evidence[]
  claims: Claim[]
  groups: EvidenceGroup[]
  arguments: Argument[]
  issues: Issue[]
  searches: SearchLog[]
  artifacts: Artifact[]
}

// ---- §6 review types ----

export type Verdict = 'pass' | 'fail' | 'needs-review' | 'not-run'
export type Support = 'direct' | 'inferential' | 'partial' | 'contradicted' | 'irrelevant' | 'unknown'
export type Adequacy = 'robust' | 'adequate' | 'weak' | 'none'
export type MechanicalStatus = 'pass' | 'fail' | 'not-run' | 'inapplicable'
export type ReviewJobStatus = 'queued' | 'running' | 'completed' | 'incomplete' | 'cancelled' | 'budget-exhausted'

export interface Finding {
  id: Id
  code: string
  targetIds: Id[]
  severity: 'blocker' | 'major' | 'minor'
  explanation: string
  evidenceIds: Id[]
  artifactSpans: Span[]
  repair: 'add-evidence' | 'narrow-claim' | 'qualify' | 'repair-argument' | 'address-issue' | 'remove' | 'manual-review'
}

export interface Check {
  ruleId: string
  result: Verdict
  rationale: string
  evidenceIds: Id[]
}

export interface ResponseBase {
  rubricVersion: string
  findings: Finding[]
}

export interface ResponseTarget {
  targetId: Id
  checks: Check[]
}

export interface SourcesResponse extends ResponseBase {
  stage: 'sources'
  targets: ResponseTarget[]
}

export interface ClaimsResponse extends ResponseBase {
  stage: 'claims'
  targets: (ResponseTarget & { searchSufficiency: 'checked' | 'not-checked' })[]
}

export interface SupportResponse extends ResponseBase {
  stage: 'support'
  targets: (ResponseTarget & {
    support: Support
    adequacy: Adequacy
    evidenceRelations: { evidenceId: Id; support: Support; rationale: string }[]
  })[]
}

export interface ArgumentsResponse extends ResponseBase {
  stage: 'arguments'
  targets: (
    | (ResponseTarget & { adequacy: Adequacy })
    | (ResponseTarget & {
        issueImpact: 'none' | 'qualify' | 'downgrade' | 'invalidate'
        issueResolution: 'accepted' | 'rejected' | 'unresolved'
      })
  )[]
}

/** One §11.4 alignment entry: relation enum with the claimIds emptiness rules. */
export interface AlignEntry {
  extractedId: Id
  claimIds: Id[]
  relation: 'exact' | 'equivalent' | 'stronger' | 'broader' | 'new'
  rationale: string
}

/** Align-stage response (§11.4): findings plus the alignment array (each extracted item exactly once). */
export interface AlignResponse extends ResponseBase {
  stage: 'align'
  targets: ResponseTarget[]
  alignment: AlignEntry[]
}

export type ReviewResponse = SourcesResponse | ClaimsResponse | SupportResponse | ArgumentsResponse | AlignResponse

export interface SemanticReviewRecord {
  runId: Id
  /** 'extract'/'align' are the §12 audit sub-stage records; 'audit' is the aggregate stage. */
  stage: 'sources' | 'claims' | 'support' | 'arguments' | 'audit' | 'align'
  targetRefs: Ref[]
  dependencyDigest: Hash
  artifactHash?: Hash
  contractHash: Hash
  policyHash: Hash
  reviewerConfigHash: Hash
  promptHash: Hash
  inputHash: Hash
  responseHash?: Hash
  kind?: 'disagreement'
  coreClaimIds?: Id[]
  response?: ReviewResponse
  status: 'completed' | 'error' | 'cancelled' | 'budget-exhausted'
  inputTokens: number
  outputTokens: number
  startedAt: string
  endedAt: string
  errorCode?: string
}

/** One extracted atomic claim (runtime-derived). See the module doc: distinct from {@link ExtractionRecord}. */
export interface ExtractedAtomicClaim {
  extractionId: Id
  claimId: Id
  span: Span
  quote: string
  kind: ClaimKind
}

export interface ExtractedItem {
  span: Span
  exactText: string
  atomicClaims: { text: string; kind: ClaimKind; scope: Scope; importance: 'core' | 'supporting' }[]
  isQuotation: boolean
}

/** Extract-stage response wrapper (§11.4): ReviewRecord system fields, stage 'extract', response `{items}`. */
export type ReviewRecord = SemanticReviewRecord | ExtractionRecord

export interface ExtractionRecord {
  runId: Id
  stage: 'extract'
  artifactHash?: Hash
  kind?: 'disagreement'
  coreClaimIds?: Id[]
  targetRefs: Ref[]
  dependencyDigest: Hash
  contractHash: Hash
  policyHash: Hash
  reviewerConfigHash: Hash
  promptHash: Hash
  inputHash: Hash
  status: 'completed' | 'error' | 'cancelled' | 'budget-exhausted'
  inputTokens: number
  outputTokens: number
  startedAt: string
  endedAt: string
  errorCode?: string
  response: { items: ExtractedItem[] }
}

export interface AdjudicationRecord {
  adjudicationId: Id
  findingId: Id
  decision: 'accept' | 'reject'
  reason: string
  signer: 'user'
  ts: string
  dependencyDigest: Hash
  overrides: { ruleId: string; targetId: Id; runId: Id }
}

export interface Assessment {
  claimId: Id
  supportGrade: 'A' | 'B' | 'C' | 'U'
  opposition: 'not-checked' | 'none-found' | 'material' | 'decisive'
  disposition: 'supported' | 'contested' | 'underdetermined' | 'refuted'
  reviewState: 'current' | 'stale' | 'not-run' | 'incomplete'
  reviewRunIds: Id[]
  rationale: string[]
}
