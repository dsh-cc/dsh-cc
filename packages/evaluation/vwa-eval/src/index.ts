export { BUDGET, DOGFOOD_MIN, DOGFOOD_RATE, K_ATOMIC_FACTS, POST_RATE, SAMPLING_LABELS, f1AtK, pickRows, sampleCount } from './sampling.js'
export type { SamplingLabel, SamplingPhase } from './sampling.js'
export {
  detectorRecall,
  exportGoldSentences,
  loadGoldSet,
  mergeAnnotations,
  splitSentences,
} from './annotation.js'
export type { AnnotationEntry, ExportedSentence, GoldAnnotations } from './annotation.js'
export {
  BOOTSTRAP_RESAMPLES,
  BOOTSTRAP_SEED,
  LANE1_SUPPORT_MAP,
  SCORER_VERSION,
  SUPPORT_CLASSES,
  bootstrapCi,
  claimMetrics,
  cleanFpRate,
  coreRecall,
  editDistance,
  editSimilarity,
  majorFaultRecall,
  matchAtomicClaim,
  mulberry32,
  normalizeText,
  spanIoU,
  supportMacroF1,
} from './scorer.js'
export type { AtomicClaim, CaseIo, ScoredFinding, SupportClass } from './scorer.js'
