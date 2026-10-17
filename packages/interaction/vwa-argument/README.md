# @dsh-cc/vwa-argument

VWA lane-2 foundation: strict author/review/receipt schemas, project storage, source snapshots, argument graph, dependency tracking, artifact binding and frozen review settings.

This package is not yet mounted in the VWA preset. Its plugin registers settings only; it exposes no author/review tools, `/vwa` command or delivery service. Semantic review defaults to off. The delivery PR adds user entry points.

See `docs/plans/2026-10-16-vwa-evidence-argument.md`. A schema contract is not a claim of semantic correctness or completed human calibration.

## Review engine

The engine now provides staged sources/support/claims/arguments reviews, full-text extract/align audit, conservative grading, current-input identities, preserved disagreement, shared model-call budgets and crash-safe usage accounting. Prompt assets ship in the npm package. Provider-boundary tests cover the engine; human-calibrated accuracy and live-model acceptance remain pending.

The plugin still registers settings only. Tools, commands, capture listeners, reports, receipts and the preset mount arrive in the delivery PR.
