# Lane-2 acceptance and remaining semantic calibration

Design: `docs/plans/2026-10-16-vwa-evidence-argument.md`. Lane 2 remains default-off. A deterministic reviewed result applies only to the current registered material, extractor output and review rules; it is not a guarantee that no factual or interpretive error exists.

## Automated acceptance

| Requirement | Executed regression coverage |
| --- | --- |
| Full review can produce a bound report and a read-back v2 reviewed receipt | `delivery-invariants.spec.ts`; preset `vwa-lane2.real-boot.spec.ts` runs `all` through real Cordis, tools, LLM runtime and local jobs; only provider output is faked |
| Extract records cannot crash delivery; extraction uses strict JSON and safe UTF-16 spans | `review-regressions.spec.ts`, `extraction-contract.spec.ts`, `audit.spec.ts` |
| Missing stages and needs-review checks cannot become passed layers | `delivery-invariants.spec.ts`, `review-regressions.spec.ts` |
| Unreviewed paths are not current; related input changes stale previous judgments | `review-regressions.spec.ts`, graph/dependency fixtures, real workspace mounts |
| Unsupported premises cannot raise conclusion strength; alternatives are independent | `policy-invariants.spec.ts`, `policy.spec.ts` |
| Same-input disagreements preserve the negative check and block automatic promotion | `review-disagreement.spec.ts`, `review-runner.spec.ts` |
| Support receives the actual claim, scope, sources, quotes and upstream reviews | `review-regressions.spec.ts`, `mount.real-boot.spec.ts` |
| Provider tool schemas contain no unresolved local or external references | `review-regressions.spec.ts`, `review-adapter.spec.ts` |
| Audit findings survive persistence and contain every required audit rule | `review-regressions.spec.ts`, `delivery-invariants.spec.ts` |
| Every audit/repair attempt obeys shared limits; interrupted reservations remain charged | `review-regressions.spec.ts`, `delivery-invariants.spec.ts`, `budget-recovery.spec.ts` |
| Immediate request replay cannot schedule duplicate work; different payloads conflict | `tool-idempotency.spec.ts` |
| Workspace gates inspect actual bytes; snapshot tampering blocks dispatch and delivery | `delivery-invariants.spec.ts` |
| Presentation needs both exact current body/report paths; pending reviews abstain | vwa-evidence `delivery-hardening.spec.ts`, `delivery.spec.ts` |
| Report failure cannot produce a success receipt | vwa-evidence `delivery.spec.ts` |
| Human overrides affect the named finding, preserve history and expire on edits | `delivery-invariants.spec.ts`, `commands.spec.ts` |
| Project budgets are frozen at initialization; signatures require an existing receipt | `project-policy.spec.ts` |
| Reports and snapshots cannot be re-ingested as source evidence | `review-regressions.spec.ts`, `sources-dcases.spec.ts` |
| Published bytes include prompt assets and execute under plain Node ESM | `package.spec.ts` packs, unpacks and imports the built package |

Run after the sibling harness pinned by CI has been built:

```sh
pnpm install --frozen-lockfile
pnpm exec tsc -b tsconfig.packages.json
pnpm vitest run packages/interaction/vwa-argument packages/interaction/vwa-evidence packages/preset/cc packages/evaluation/vwa-eval
pnpm smoke:profile-boot
```

The package smoke test deliberately imports the unpacked `lib` code with plain Node, rather than a source alias or TypeScript loader. Build before running it.

## Semantic acceptance

The three committed humanities cases are explicitly synthetic development fixtures. They do not replace the design's 60-case corpus, independent human annotations, adjudication, frozen held-out split or the required recall/F1/false-positive thresholds. No human annotation or live-model score is fabricated by the implementation. Reports state that human-calibrated extraction recall is unavailable and semantic review is experimental until this work is completed.

The remaining acceptance work is to supply legally usable cases and source snapshots, obtain independent human annotations and adjudication, freeze policy/prompt/model configuration before held-out evaluation, and run the historical and literary workflows with the intended live reviewer model. Preserve failures, costs, source versions and qualifications in those results. Passing provider-boundary fakes establishes integration and deterministic invariants only.

## Runtime decisions

Project initialization stores a runtime-owned `reviewSettings` extension in the project contract. Research-contract edits preserve it. Enablement and model route selection remain host settings; actual prepared model options, schema and prompt versions enter review identity. Unavailable optional style rules remain disclosed, while required link and used executable-code gates block eligibility when unrun.

`argument.report` writes derived output to `docs/vwa-reports/<projectId>/<artifactId>.review.md` or `.json`. The turn-end writer uses the same Markdown path, then appends and reads back the receipt. Delivery requires the host's real `deliverables/presented` event for both exact paths; the implementation never fabricates that event.
