/**
 * Public surface of @dsh-cc/token-efficiency: corpus + redactor (replay
 * fixtures), metrics (MetricVector folding), gate (frozen-acceptance
 * comparator), mock-run (mock-script tier through the real plugin stack).
 * The CLI surface lives in ./bin (tsx-run; `pnpm check:token-efficiency`).
 *
 * @module @dsh-cc/token-efficiency
 */
export { RedactorDeviationError, renderCanonicalJsonl, sanitizeSessionEvents } from './redactor'
export {
  counterExpectSchema,
  loadCorpusDir,
  oracleSchema,
  taskDescriptorSchema,
} from './corpus'
export type { TaskDescriptor } from './corpus'
export {
  adaptForFoldCost,
  foldMetricVector,
  MetricDeviationError,
  usageCoverage,
} from './metrics'
export type { MetricVector, SessionEventLike } from './metrics'
export {
  compareTask,
  compareVectors,
  gateConfigSchema,
  loadBaseline,
  loadGate,
  runChecks,
  toleranceSchema,
} from './gate'
export type { BaselineBlob, GateConfig, TaskVerdict } from './gate'
export { hasMockScenario, runMockTask } from './mock-run'
