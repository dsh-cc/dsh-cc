/**
 * Measured per-model System One decision-window registry, shared by every
 * consumer that sizes a System One call (the gauge permission lane and the
 * decision lane's route defaults). Pure constants and one pure helper — no
 * I/O, no settings reader.
 *
 * @module @dsh-cc/systemone/model-windows
 */

/** Checkpoint window of the probe-validated deployment (design doc §6.2). */
export const DEFAULT_GAUGE_CONTEXT_WINDOW = 1024

/**
 * Measured System One model context windows (2026-10-07 live probe, local
 * orchestrix gateway; design doc `docs/plans/2026-10-07-gauge-context-window-per-model.md`
 * §2): laya silently truncates at exactly 1024 tokens (HTTP 200,
 * `input_tokens` pinned — the sentinel's target hazard), while bjev shows no
 * pin up to 20,051 observed input tokens, fails loudly with HTTP 422 above
 * 65,536 tokens, and throws intermittent HTTP 500s from ~17.5k tokens — so
 * 16384 bounds flake exposure without risking silent truncation.
 */
export const GAUGE_MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  laya: 1024, // silent-truncation pin, replicated 2026-10-07
  bjev: 16384, // no pin ≤ 20,051 tok; 422 hard limit 65,536; 500-flakes ≳ 17.5k tok
}

/** Registry keys are bare ids: `llmbox_systemone/bjev` → `bjev`. */
export function normalizeGaugeModelId(model: string): string {
  const slash = model.lastIndexOf('/')
  return slash === -1 ? model : model.slice(slash + 1)
}
