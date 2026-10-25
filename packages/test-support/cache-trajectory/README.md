# @dsh-cc/cache-trajectory

English | [中文](README.zh.md)

Internal test infrastructure, not published. A cache-hit-rate benchmark: standard trajectory schema (zod-validated), deterministic runner, report fold, and regression thresholds — plus offline forensics over recorded session logs. Calibration tool, not a gate: the bin always exits 0; the verdict lives in the report (`verdict`/`failures`).

## Usage

Run the benchmark against the DeepSeek API (or a mock server):

```sh
pnpm exec tsx packages/test-support/cache-trajectory/src/bin.ts \
  --out report.json            # write the report JSON
  --trajectory path.json       # default: built-in trajectories/standard.json
  --base-url http://localhost:PORT   # OpenAI-compatible mock server (keyless)
  --provider deepseek --model deepseek-chat   # route overrides
  --api-key <key>              # seed DEEPSEEK_API_KEY (mock runs); env/.env also work
  --no-cc-plugins              # skip the dsh-cc agent-plane plugins
  --no-cache-expected          # shape-only verdict (mock usage has no cache buckets)
  --report-only report.json    # validate + render an existing report, no run
```

Offline forensics over session logs (plain JSONL, `-` for stdin, `.zstd` via the zstd CLI) — no composition boot:

```sh
pnpm exec tsx packages/test-support/cache-trajectory/src/bin.ts analyze-log session.jsonl
pnpm exec tsx packages/test-support/cache-trajectory/src/bin.ts compare-fork parent.jsonl child.jsonl
```

- `analyze-log` — per-request cache pattern, per-route token breakdown, gap buckets, and findings.
- `compare-fork` — fork parent/child head byte-identity: route match, system-prompt byte-identity, first divergence byte.

The library surface (`./index.ts`) exports the trajectory schema and loader (`parseTrajectory`, `loadStandardTrajectory`), the runner (`runCacheTrajectory`), report folding and thresholds (`foldReport`, `hitRate`, `thresholdsFromEnv`, including the `CACHE_E2E_MIN_HIT_RATE_ENV` override), and the log-analysis helpers (`analyzeSessionCache`, `compareForkPrefix`). A second entry (`./testing`) exposes the composition stack used by the bin and tests.
