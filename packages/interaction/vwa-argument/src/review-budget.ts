/** Frozen §13 budget for one run (from settings at project time). */
export interface ReviewBudget {
  maxCallsPerRun: number
  maxInputTokensPerRun: number
  maxOutputTokensPerRun: number
  maxOutputTokensPerCall: number
  wallMs: number
  callTimeoutMs: number
  concurrency: number
}
