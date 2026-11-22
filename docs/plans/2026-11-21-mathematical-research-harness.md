# Mathematical Research Harness: System Design

- Date: 2026-11-21
- Status: Reviewed — three-seat blind review (critic + codex-bridge + grok-bridge) converged to all-GO at v6 after six rounds; no open P0/P1
- Target: new optional marketplace plugin `packages/plugin/dsh-cc-math`; new evaluation package `packages/evaluation/math-eval`
- Baseline: worktree `mathematical-research-harness`, based on origin/main @ 8e99adba
- Scope: without modifying base-model weights, add a mathematics reasoning layer to dsh-cc: formalization with independent verification (M1), proof-state-guided budget-aware proof search (M2), mathematical discovery workflows (M3), and a reproducible evaluation system (RQ6)

## 1. Problem and goals

The six limitation classes of LLMs on university and research mathematics (semantic understanding, long-horizon reasoning, result verification, exploration and discovery, experience reuse, cost control) are given by the problem statement (RQ1–RQ6). This design turns them into a harness layer delivered as **stacked increments over an explicit shared foundation**:

1. **RQ1 → M1**: natural-language propositions → faithful Lean 4 formalizations with Mathlib premise retrieval; formalization fidelity is graded, never assumed, and the grade determines what the claim machinery may assert.
2. **RQ2 → M2**: structured proof search driven exclusively by Lean compiler feedback, budget-aware.
3. **RQ3 → M1**: three verification layers (computation / formal proof / semantic fidelity) separated, each with an independent verdict and evidence artifacts.
4. **RQ4 → M3**: experiment–conjecture–counterexample–revision discovery loops with a claim-status taxonomy.
5. **RQ5**: verified theorems, proof strategies, and failure experience in a retrievable research memory.
6. **RQ6**: `math-eval` package with benchmarks, compute-matched baselines, and an ablation matrix.

**Milestone honesty note:** M1/M2/M3 are stacked increments, not independently usable stages. M0 (shared foundation) is a prerequisite of all three; M2 consumes M1's artifact formats; M3 reuses M1's claim machinery. Each milestone ships and evaluates on its own, but later milestones cannot run without earlier ones (§10).

### 1.1 Constraint compliance

| Constraint | Mechanism |
|---|---|
| No fine-tuning | only inference-time mechanisms from the six papers; training-side mechanisms are non-goals (§12) |
| Trusted proof checker only | Lean kernel checks are the sole source of proof correctness; LLM self-judgment never certifies a proof (§4.4) |
| Three correctness kinds separated | claim records carry `computation_verified` (tri-state: pass/fail/not-applicable), `formal_proof_valid`, `statement_faithful` (graded), produced by different mechanisms |
| Traceability and reproducibility | evidence artifacts with hash receipts (§9.4) |
| Baseline discipline | fixed per-config budget caps with uniform external scoring (§8.3) |
| Model independence | no model ids; v1 "tiers" are delegation choices among existing pinned lanes (§7.2), not new aliases |

## 2. Literature findings and design mapping

All six papers were fetched and verified this session:

| # | Paper | Identity | Adopted mechanism | Rejected part |
|---|---|---|---|---|
| P1 | LeanDojo | NeurIPS 2023 D&B | premise retrieval as a first-class step; accessible-premises restriction (corrected direction in §4.2) | training ReProver |
| P2 | ProofNet | arXiv:2302.12433 | three-artifact separation; benchmark reference formalizations double as trusted fidelity anchors (§4.3) | — |
| P3 | Goedel-Prover | arXiv:2502.07640 | verifier-gated harvest; Pass@k sampling evaluation | SFT/RL pipeline |
| P4 | Goedel-Prover-V2 | ICLR 2026 | verifier-guided self-correction (2 rounds; miniF2F 88.1%→90.4% on a 40K-token budget — our per-attempt envelope is deliberately smaller, 25K vs their 40K, while our per-problem total, 200K, is deliberately larger to admit up to 8 attempts; not a conversion) | checkpoint averaging, training-side synthesis |
| P5 | AlphaEvolve | arXiv:2506.13131 | code as action space; continuous evaluator feedback | parallel evolution infrastructure |
| P6 | FunSearch | Nature 2023 | LLM-proposed programs scored by an independent evaluator; constructive discoveries | — |

Mechanism → landing point: P1 → `mathlib-search.mjs` (§4.2); P2 → problem-dir contract + reference anchors (§4.1, §4.3); P3 → experience store gating (§7.2); P4 → repair loop (§5.2) and scaffolding (§5.4); P3/P4 → budgeted sampling (§5.3); P5/P6 → discovery loop with evaluator gate (§6).

## 3. Overall architecture

### 3.1 Component layout

```
packages/plugin/dsh-cc-math/              # optional marketplace plugin (dsh-cc-writing pattern)
  .claude-plugin/plugin.json              # plugin manifest; version lockstep with root release version
                                           # (scripts/check-release-version.mjs enforces equality)
  package.json                            # files whitelist: .claude-plugin/plugin.json, skills/, READMEs
                                           # (tests/ and README.i18n.yaml are NOT published — dsh-cc-writing
                                           #  whitelist precedent, proven by its package-shape.spec.ts)
  skills/math-research/                   # ALL runtime resources live under this dir so installed
                                           # CLAUDE_SKILL_DIR paths work (formal-design invokes
                                           # "${CLAUDE_SKILL_DIR}/scripts/..." after /plugin install)
    SKILL.md                              # staged per milestone: M0 core; M1/M2/M3 sections activate
                                           # when their scripts exist (feature gate = file presence check
                                           # documented in SKILL.md, not a settings flag)
    references/{formalize,prove,discover,evidence,budget}.md
    scripts/                              # .mjs, node-run, zero new npm runtime deps
      mathlib-env.mjs                     # provision Lean+Lake wrapper project+Mathlib+oleans (§4.2)
      mathlib-index.mjs                   # build decl+import-edge index via Dumper.lean (§4.2)
      mathlib-search.mjs                  # FTS5 retrieval CLI
      lean-run.mjs                        # single-file Lean check with proof binding (§4.4)
      math-verify.mjs                     # three-layer verification orchestration
      claim-ledger.mjs                    # claim records, transitions, chain hash
      budget-ledger.mjs                   # reservation/settlement bookkeeping
      experience.mjs                      # experience store
      sympy-run.mjs                      # subprocess sandbox for generated Python checks
      Dumper.lean + Inspector.lean       # metaprograms (compiled inside the env's wrapper project)
  tests/                                  # packages/plugin/dsh-cc-math/tests/*.spec.ts — matches the
                                          # root vitest include `packages/*/*/tests/**/*.spec.ts`
  README.md / README.zh.md / README.i18n.yaml
packages/evaluation/math-eval/            # evaluation package (vwa-eval structural pattern)
```

Storage layout (sandbox-corrected, r2 finding 8): **everything lives under the workspace** by default — `.math/` in the session/project cwd (git-ignored via a committed `.gitignore` entry, formal-design precedent). The Mathlib env and index live under `.math/env/` inside the workspace, not the home directory (workspace-write bash cannot write to `~`; a home-dir location would require sandbox escalation that delegated children cannot approve). A `MATH_HOME` env var may relocate `.math/` to another user-approved path; scripts feature-detect writability at start and fail closed.

### 3.2 Reuse vs build decisions (evidence-anchored)

| Capability | Decision | Grounding |
|---|---|---|
| Lean toolchain provisioning | **independent, receipt discipline copied; pin coupling corrected** | formal-design's `lean-provision.mjs:57-61` accepts only absent-or-empty destinations. Local-first reuse is NOT new (r2 correction): `.github/workflows/formal-design.yml` already skips provisioning when a valid receipt exists, and `lean-preflight.mjs` re-checks it. Our `mathlib-env.mjs` reuses that pattern. The fork is the *Mathlib layer* (source + lake wrapper + oleans), which formal-design does not have. Cross-plugin import would couple the plugins; v1 stays independent, shared `lean-runtime` library is a follow-up (§11.4) |
| Lean/Mathlib pin coupling | **Mathlib is the authority** | the pinned Mathlib revision's own `lean-toolchain` file selects the Lean version; `mathlib-pin.json` records `{ mathlib: {repo, rev, sha256}, expectedLean: "<read from mathlib's lean-toolchain for validation>" }`. A mismatch between expectedLean and the actual toolchain is `config-invalid` (fail closed, no silent rebuild). Mathlib source hash: the GitHub *source tarball* for the pinned rev (canonical archive), not a clone |
| Proof-binding check | **reuse pattern** | formal-design's `Inspector.lean` (declaration existence, kind, elaborated-type comparison, scoped axiom audit — the verdict assembly spans the whole audit function; anchors: `Inspector.lean` audit region). We adapt the pattern; process conventions alone were never the valuable part |
| Structured CLI output | **new convention** | `lean-check.mjs:297-299` prints single-line JSON on the result path (help paths print text). Our scripts print single-line JSON to stdout on result paths; `--help` prints text |
| Retrieval engine | **new build on node:sqlite FTS5** | FTS5 verified working on Node v24.22.2 this session. Engines floor is Node ^22.19 — `node:sqlite` ships in 22.5+ (experimental) but our scripts **feature-detect** FTS5 at startup and fail closed with a version diagnostic if unavailable; README documents the Node-24 recommendation |
| Declaration extraction | **Lean metaprogram** | `Dumper.lean` (inside `scripts/`) compiles once in the wrapper project and walks the environment, emitting declarations AND per-module import edges (r2 finding 5: the index needs edges for reachability) |
| Subagent orchestration | **reuse, honest tiers** | v1 has no cheap/strong aliases (none exist in the alias table; the Task tool resolves `definition.model` only). "Tiers" (§7.2) are delegation choices: cheap lane = delegate to the existing executor subagent (pinned model); strong lane = main conversation. No new agent types, no settings, no aliases invented |
| MCP | **no new server (v1)** | retrieval/checking via skill-driven bash calls. The proof-state protocol is attempt-level (§5.1) and needs no MCP |
| Research memory | **reuse + one layer** | cross-session facts via `memory_save` (schema: `{name, type ∈ user|feedback|project|reference, description, body}`; the M1 close-out procedure specifies per-fact type mapping and topic-file size discipline); structured proof experience in a workspace-local store (§7.2) |
| Evaluation infrastructure | **new, vwa-eval discipline** | fixtures/gold-set/scorer; CI checks structure only |
| Settings surface | **v1 zero settings** | run manifest carries all configuration. Mounting the plugin still updates capability manifest + parity docs (§3.4) |

### 3.3 Runtime seams and concurrency (r2 findings 10/23)

- Single-writer discipline: **all shared state (search state, both ledgers, experience store) is written only by the main conversation's process**. Delegated children never write shared state — they write only their attempt dir and return results as files.
- **Reservations happen only in the main conversation, strictly before dispatching a child** (r2 finding 10: parallel children reserving concurrently would race; since only the single main-conversation process reserves, read-modify-write is serialized by construction — no lock needed for budget.json).
- All shared-state files are written atomically (temp + rename) — **including the intent log inside `budget.json`**: the whole file is rewritten atomically on every ledger update; there is no literal byte-append anywhere in the write path. Multi-file updates (search + budget + claims) are sequenced through a **write-ahead intent record**: before a dispatch, the main conversation records `{opId, intent}` in `budget.json`; every subsequent ledger/claim write references the opId it settles. On crash, resume replays in a fixed order (v4): (1) reconcile `running` attempts by result.json hash first; (2) then roll back unsettled intents. **Rollback never refunds (v4, codex R3-4):** an unsettled intent whose attempt produced no result is marked `discarded` but its reservation is retained as a **conservative charge** (settled at the envelope amount, since actual usage is unknowable) until a later reconciliation replaces it if evidence arrives. Charges cannot be lost (no refund on missing settlement) or double-counted (settlement keyed by opId, idempotent).
- Cross-run experience store: workspace-local by default (§3.1); concurrent runs in *different* worktrees/workspaces have separate stores by construction. Two runs in the *same* workspace serialize through a lockfile (`.math/experience/.lock`, stale after 60s, fail-closed on conflict).
- Human confirmation (r2 finding 3): fidelity escalation and claim confirmations happen **only in the main conversation via `ask_user_question`** (executor children have no ask channel — their contract says so). `allowHumanFidelity: false` in the run manifest makes `disputed` a terminal `fidelity-failed` outcome with no escalation. The ledger accepts `human-confirmed` transitions only with a confirmation record referencing the user question/answer (recorded from the main conversation's ask event; a delegated child cannot produce one).

### 3.4 Repo integration surfaces (r2 finding 22 — full table)

| # | Surface | Change |
|---|---|---|
| 1 | `packages/plugin/dsh-cc-math/.claude-plugin/plugin.json` | manifest; version in lockstep with root release version (check-release-version gate) |
| 2 | `packages/plugin/dsh-cc-math/package.json` | package name `@dsh-cc/plugin-dsh-cc-math`; files whitelist: plugin.json, skills/, README.md, README.zh.md (NOT tests/, NOT README.i18n.yaml — dsh-cc-writing precedent) |
| 3 | `.claude-plugin/marketplace.json` | add plugin entry (marketplace.test.mjs enforces) |
| 4 | Root `README.md` + `README.zh.md` | marketplace count "five plugins" → six; bilingual both files |
| 5 | `packages/plugin/dsh-cc-math/tests/*.spec.ts` | package-level `tests/` (root vitest include `packages/*/*/tests/**/*.spec.ts`, `vitest.config.ts:96`) |
| 6 | `tsconfig.packages.json` | explicit reference entry (packages are not auto-referenced; vwa-eval is wired this way) |
| 7 | `pnpm-lock.yaml` | new workspace packages change the lockfile; commit together (pre-commit rejects drift) |
| 8 | `pnpm-workspace.yaml` | confirm packages/*/* glob covers the new paths |
| 9 | README trio + i18n hash pins | `README.i18n.yaml` + re-record hashes via the readme check |
| 10 | `docs/claude-code-capabilities.yaml` + parity docs | new plugin mount = capability-surface change; manifest + regenerated matrix in the same PR |
| 11 | `.github/workflows/presubmit.yml` | structure tests ride `pnpm exec vitest run` (already covered by #5); the `math-eval:check` root script must be ADDED to package.json AND invoked from presubmit's script list (a new script name alone is unwired) |
| 12 | New `.github/workflows/math-plugin.yml` (or a job in formal-design.yml) | cold `lean-run` fixtures need a provisioned Lean env — kept out of the 25-min vitest step (formal-design precedent: toolchain jobs live in their own workflow with `$RUNNER_TEMP` destinations) |
| 13 | `.gitignore` | `.math/` entry (formal-design ignore precedent) |
| 14 | `package.json` (root) | `math-eval:check` script |

## 4. M1: formalization and verification

### 4.1 Problem-dir artifact contract (P2)

`.math/runs/<run-id>/problems/<problem-id>/`:

```
statement.md        # original NL proposition (user-supplied, read-only)
statement.lean     # formal statement: `theorem <statementDeclName> : <prop> := sorry`
                   # (sorry REQUIRED — see statement-check mode below)
proof.lean         # SELF-CONTAINED proof: redeclares the full theorem
                   # `theorem <proofDeclName> : <prop> := <proof>` (imports only Mathlib modules,
                   # never statement.lean's sorry-ed declaration)
meta.json           # domain tags, source (benchmark id), difficulty
fidelity.json       # fidelity gate output (§4.3)
binding.json        # { statementDeclName, proofDeclName, mathlibRev, toolchainDigest } (renamed
                   # from manifest.json — r2 finding 12: one "manifest" name for two files)
search.json         # §5.1 (per-problem, r2 finding 11)
attempts/           # per-problem (r2 finding 11)
```

**Statement-check mode (r2 finding 4, three-seat convergence):** `statement.lean` uses `sorry` and is checked in a dedicated mode that (a) elaborates the file, (b) tolerates the `sorry` warning **in this mode only**, (c) records the elaborated type of `statementDeclName`. L2 proof checking (§4.4) never imports the sorry-ed statement: `proof.lean` is self-contained, and the binding check compares the elaborated type of `proofDeclName` against the recorded elaborated type of `statementDeclName` (term-level `definitionalEquality` comparison in the Inspector pattern — the compared objects are the elaborated proposition terms, defined exactly). The axiom audit runs on `proofDeclName` only (never indiscriminately over the environment — sorryAx from unrelated elaborations is out of scope by construction since proof.lean is self-contained).

### 4.2 Mathlib environment and premise retrieval (P1)

**Environment:** `mathlib-env.mjs` provisions at `.math/env/<env-id>/` (workspace-local, §3.1):

- `env-id` = `<mathlibRev>-<platform>` (Lean version derives from Mathlib's own `lean-toolchain` at that rev — §3.2 pin coupling; the platform suffix makes environment paths, receipts, and index keys one identity, v5).
- Steps: (1) local-first: if `.math/env/<env-id>/` exists with a valid receipt, reuse (this mirrors formal-design's receipt-skip, credited in §3.2); (2) provision the Lean toolchain version named by Mathlib's `lean-toolchain` (receipt discipline; absent-or-empty dest only; invalid receipt = hard error); (3) fetch the Mathlib source tarball for the pinned rev, verify sha256 against `mathlib-pin.json`; (4) **create a wrapper lake project** in the env dir (`lakefile.lean` depending on the local Mathlib path, `lean-toolchain` file matching) — user files are built through this project (r2 finding 7: bare "lake single-file build" without a project is not a thing; Dumper.lean and Inspector.lean also compile inside this wrapper). **Per-attempt build isolation (v4, codex R3-5):** the env's Mathlib source, oleans, and toolchain are immutable and shared read-only; every attempt compiles in its **own** build directory (`attempts/<id>/build/`, its own copy of the wrapper lakefile pointing at the shared immutable env) — parallel attempts never share mutable compilation inputs or build artifacts.
- (5) fetch prebuilt oleans via `lake exe cache get` (Mathlib release artifacts; no source build); (6) write `env.receipt.json`: `{ pin, leanDigest, mathlibSha256, cacheArtifactSha256, platform, provisionedAt }`.

Platforms: macOS arm64 + linux x64. Offline: a valid receipt + present artifacts need no network; verification re-checks digests locally. A missing cache artifact for the pinned rev is a provisioning error surfaced before any model spend.

**Index:** `mathlib-index.mjs` builds `.math/index-<env-id>.sqlite`:
- Runs `Dumper.lean` in the wrapper project: emits JSON lines `{name, kind, module, typeText}` for every public declaration **plus `{module, imports: [...]}` edges for every module** (r2 finding 5: reachability needs edges).
- SQLite: content table `decls(name PK, kind, module, typeText)` + `modules(module PK)` + `moduleEdges(importer, imported)` (v4: direction explicit — `importer` is the module whose source contains the `import` statement) + FTS5 virtual table over `(name, typeText)`. Idempotent per env receipt.

**Retrieval:** `mathlib-search.mjs --query "<shape or type fragment>" [--top N] [--kind theorem,lemma,def] [--imports <path to proof.lean or statement.lean>] [--json]`
- FTS5 MATCH, BM25; empty results = empty array exit 0; FTS5 syntax errors exit 2 with raw error.
- **Reachability, corrected direction (r2 finding 5, LeanDojo's actual definition):** with `--imports F`, the reachable set is declarations whose defining module belongs to the transitive import closure of F's import set: `{ decl ∈ M | M ∈ imports*(imports(F)) }`. The filter runs over **proof.lean's extensible import set** — the search loop may add imports to proof.lean and re-retrieve (r2 finding F-D); without `--imports`, no filter (flagged in output).

### 4.3 Formalization fidelity gate (RQ1; three-seat convergence on authority)

Three checks:

1. **Back-translation** (model): `statement.lean` → NL, compared with `statement.md`. Output `{ equivalent: true|false|uncertain, differences: [...] }`.
2. **Dual formalization with kernel-checked pair equivalence** (machine, *pair-level only*): generate `statement-b.lean` (different prompt strategy; strategy recorded in `fidelity.json`); generate and check `theorem eqv : P₁ ↔ P₂` in the wrapper project (repair budget: 1 round, distinct from the M2 repair budget). Outcomes: `equivalent` / `unknown` (failed proof search establishes unknown, NOT "differing" — r2 finding R1) / `skipped` (candidate-b generation failed).
3. **Premise audit** (model): enumerate explicit+implicit premises in `statement.md`; diff against hypotheses in `statement.lean`. Output `{ missing: [...], extra: [...] }`.

**Authority model (r2 convergence — the r2-draft's `machine-confirmed` grade is retracted):**

- The kernel pair-equivalence proves only that two formalizations agree **with each other** — it is never evidence about the NL statement. Both can share a mistranslation. It is recorded as a separate field `pairEquivalence: equivalent|unknown|skipped` and never upgrades fidelity on its own.
- `statement_faithful` grades:
  - `anchored`: a trusted reference formalization exists AND the kernel-checked reference equivalence (type-equality, or a kernel-checked equivalence proof recorded by the checker with its own repair rules) **passes**. The reference is the semantic anchor. `anchored` supports `proven`.
  - `human-confirmed`: a human confirmed equivalence via the §3.3 escalation channel (ask_user_question in the main conversation; confirmation record required). Supports `proven`.
  - `model-assessed`: check 1 = `equivalent` AND check 3 = clean AND **no reference exists** — supports only `proven-of-formal-statement`.
  - `disputed`: anything else. Terminal `fidelity-failed` if `allowHumanFidelity: false`; otherwise escalates to human.

**Exhaustive decision table (v4: the anchored check is itself an outcome — three-seat r3 convergence):**

| # | back-translation | premise audit | anchor check (if reference exists) | grade |
|---|---|---|---|---|
| 1 | equivalent | clean | not run (no reference) | model-assessed |
| 2 | equivalent | clean | kernel check passes (type-equal/equivalent) | anchored |
| 3 | equivalent | clean | kernel check FAILS | disputed (strong evidence of infidelity) |
| 4 | equivalent | clean | anchor check cannot run | disputed |
| 5 | equivalent | differences | — | disputed |
| 6 | uncertain | clean | — | disputed (v4: `uncertain` is not a pass; check 1 must be `equivalent` for any non-disputed grade) |
| 7 | uncertain | differences | — | disputed |
| 8 | false | any | — | disputed |
| 9 | any check failed to run (infrastructure failure, either check) | | | disputed |

`model-assessed` therefore means exactly: check 1 = `equivalent` AND check 3 = clean AND no reference exists (row 1 only — a reference whose check cannot run is row 4, `disputed`). `anchored` means exactly: row 2. `pairEquivalence` remains advisory data recorded alongside, never a grade input. Disputes carry a `disputeReason` field: `anchor-failed` (kernel evidence of infidelity) | `model-judgment` (rows 5–8) | `infra-failure` (rows 4/9 — the tooling produced no evidence, not evidence of infidelity). An `infra-failure` outcome is retried **inside the gate, before any dispute is committed**: on rows 4/9 the gate re-runs the failed check once; only if it fails again does the dispute commit with `disputeReason=infra-failure` (v6: the committed dispute is therefore never retried — the retry window is strictly pre-commitment, which carves it out of §3.3's terminal rule and §6.3's terminal edge by construction, since no `disputed` grade exists yet during the retry). Under `allowHumanFidelity=false`, a committed infra-failure dispute lands in terminal `fidelity-failed`; the reason field distinguishes tooling failure from infidelity evidence in every report.

**Fidelity measurement protocol (r2 finding 18 — fully specified):** unit = immutable `(NL statement, formal statement)` pair. "Accepted" = the gate's output grade is `model-assessed` or better (measured **before** any human escalation). Sample: all gate outputs from the ProofNet subset + ≥10 seeded corruptions (dropped hypothesis / weakened conclusion / swapped quantifier) injected blind. Double annotation (two humans, rubric: `faithful` / `meaning-changed` / `unjudgeable`; rubric-to-grade mapping: faithful ↔ model-assessed-or-better passes, meaning-changed ↔ should be disputed); disagreements adjudicated by a third **human** pass. `unjudgeable` annotations are excluded from both conditional-rate denominators and reported as their own rate (v4). Denominators reported separately for natural outputs and corrupted injections; both conditional rates reported: P(accepted | corrupted) and P(corrupted | accepted).

### 4.4 Three-layer verification with proof binding (RQ3)

`math-verify.mjs` produces three verdicts per problem:

**L2 formal proof (`lean-run.mjs`)** — the soundness core:
- Input: problem dir + `binding.json`.
- Execution: build `proof.lean` in the attempt's own build directory with its own wrapper-lakefile copy (per-attempt isolation, §4.2; cached oleans shared read-only; default timeout 300s, binding-overridable).
- Binding check (Inspector pattern): (a) `statement.lean` declares `statementDeclName` (statement-check mode records its elaborated type); (b) `proof.lean` declares `proofDeclName` — a theorem; (c) **the elaborated proposition of `statementDeclName` and the elaborated type of `proofDeclName` are compared by definitional equality** (the exact two terms are named; string comparison is never used); (d) `#print axioms proofDeclName` admits only {propext, Classical.choice, Quot.sound}.
- Failure semantics, scoped (r2 findings 15/F-C): L2 fails on **any error**, on **any sorry-bearing diagnostic** — matched by the structured diagnostic's message code where Lean provides one, falling back to substring matching on the message text (v4: the fallback is documented and unit-tested against the pinned version's actual sorry-warning text), on axiom-whitelist violation, and on any binding-check failure. Other warnings (unused variable, deprecation, linter) do NOT fail. The two rules are consistent because the sorry-scope is named.
- Diagnostics (r2 finding 16): `lean-run.mjs` emits its **own report JSON** (lean-check precedent): `{ status, diagnostics: [{file, line, col, severity, message, raw?}], binding: {...}, axioms: [...] }`. Lean's structured message output is used where available; unparseable messages are preserved verbatim in `raw`. An unparseable run = attempt failed (goal not closable from that run), and the raw text is attached to the repair prompt; a later successful repair attempt may close the goal.
- Hash binding: L2 verdict records sha256 of statement.lean + proof.lean + binding.json + env receipt digest. Any change invalidates.

**L1 computation (`sympy-run.mjs`)** — optional, with honest isolation semantics (v4, grok r3 finding — nested `sandbox-exec` under the host seatbelt is denied on macOS, so in-session network isolation is not available):
- Requires local Python ≥3.10 + sympy (probed at run start). Absent → `computation_verified = "not-applicable"` (tri-state: pass | fail | not-applicable).
- **Isolation tiers, recorded per run in `isolation: full | partial`:**
  - **full** (network-isolated): Linux CI runners with network namespace / no-egress runners — L1 results here are authoritative: a failing check is `computation_verified: fail` and may serve as counterexample evidence.
  - **partial** (in-session, any platform): fresh temp cwd under `.math/`, the outer workspace-write bash sandbox bounds filesystem writes, wall+CPU limits, 60s timeout — but network isolation is NOT guaranteed (macOS nested sandbox is denied). L1 results here are **advisory only**: they feed repair prompts, never `computation_verified: fail`, never falsification evidence. Recorded with the caveat.
- The tier is detected and recorded before execution; fail closed (no silent downgrade): a partial run that claims `fail` is a ledger error. A partial run whose checks all pass may write `pass`, annotated `isolation: partial` (positive support needs no network isolation); only `fail` is tier-gated.

**L3 semantic fidelity:** §4.3 grade.

**Repair feedback:** L2 failure → full diagnostics JSON + current proof.lean + the statement type. L1 failure → minimal counterexample. L3 failure → difference list. When L1 returns an authoritative (full-tier) counterexample while L2 passes, the claim moves per the §6.3 conflict rule (`statement_faithful=disputed` + `fidelity-failed` or escalation) — the conflict is never silently resolved (r2 finding 13).

## 5. M2: guided proof search

### 5.1 Search loop and state

State is `search.json` **per problem** (inside the problem dir, §4.1; schemaVersion 1):

```json
{
  "schemaVersion": 1, "runId": "…", "problemId": "…",
  "status": "running|solved|unsolved-with-progress|budget-exhausted|fidelity-failed",
  "goals": [ { "id": "g-001", "parent": null, "statementShape": "…",
               "state": "open|in-progress|closed|abandoned",
               "closedBy": "attempt-003|null" } ],
  "attempts": [ { "id": "attempt-003", "goalId": "g-001", "repairRoundsUsed": 0,
                  "dir": "attempts/attempt-003/", "opId": "op-007",
                  "status": "pending|running|passed|failed|discarded",
                  "inputHash": "sha256 of prompt inputs file", "resultHash": "sha256 of result.json|null" } ],
  "scaffolds": [ { "goalId": "g-001", "childProblemId": "p-002", "depth": 1,
                   "connectingImplication": "…", "state": "open|child-proven|integrated|dead" } ],
  "scheduler": { "nextAttemptId": 4, "branchPolicy": "serial-2-then-parallel" }
}
```

- `result.json` schema (per attempt): `{ attemptId, status: passed|failed, diagnostics: <lean-run report>, usage: { promptTokens, completionTokens }, closedGoals: [...] }`. It is written atomically (temp+rename).
- Goal identity and closure: a goal closes **only** when an attempt's proof.lean passes the full L2 check bound to that goal's statement.
- Proof-state signal: attempt-level diagnostics + goal statement shape. No tactic-level interactive states (explicit; no MCP in v1).
- Resume: **fixed order (v4)** — (1) reconcile `running` attempts by result.json hash; (2) then roll back unsettled opId intents per §3.3 (rollback charges conservatively, never refunds). The write-ahead protocol (§3.3) makes every crash point recoverable.
- Scheduling: first 2 attempts serial; then parallel executor-delegated branches.

### 5.2 Self-correction rounds (P4 anchor)

Max **2 repair rounds** per attempt. Repair prompts include the full diagnostics JSON. Repair rounds consume the attempt's token envelope, not a new attempt id.

### 5.3 Budget semantics (honest enforcement model)

- **Attempts axis — enforced by construction**: reservations are made **only by the main-conversation process, strictly before dispatch** (§3.3); the ledger refuses reservations exceeding `maxAttempts` (default 8). Children never reserve, so there is no race.
- **Token axis — cooperative; admission exact, consumption advisory (v4 — the one-envelope numerical claim is removed, codex R3-3):** admission control is exact: a new reservation is granted only if `settled usage + outstanding reservations + new reservation ≤ maxTokens` (default 200K/problem). Envelopes (default 25K) are prompt-level instructions to children, not mechanical ceilings — a child that ignores its envelope can overspend, and the overshoot is bounded only by that child's completion, not by a numerical guarantee. Settlement replaces the reservation with actual usage (from result.json usage + main-conversation transcript accounting). All chargeable operations are enumerated: generation, retrieval prompts, fidelity checks, repairs, scaffolds — child scaffold problems share the parent budget (ledger lineage).
- **Wall-clock**: per-attempt subprocess timeouts (enforced) + run deadline checked at every ledger call (cooperative).
- DoD claim: "admission rule proven by tests; consumption-after-dispatch is cooperatively bounded only" — stated exactly, no numerical overshoot guarantee.

### 5.4 Scaffolding and lemma discovery (P4; complete failure semantics, r2 finding 17)

- Retrieval first on stuck goals (reformulated queries; extensible imports, §4.2).
- Subgoal degradation with required connecting implication. Scaffold states: `open` → `child-proven` (child's own L2 passes; child claim recorded independently) → `integrated` (parent closes via its own checked proof that uses the child result) | `dead` (child falsified, or child `fidelity-failed`, or child `unsolved-with-progress`/budget-exhausted, or connecting implication cannot be discharged, or parent abandoned while child in flight — each listed). Any child terminal other than a proven claim marks the scaffold `dead` (the parent goal stays open, other branches continue). Depth counts nodes; cap 3 terminates that branch (goal → `abandoned`), not the problem. Cycle rejection by lineage.
- Strengthened assumptions discharge inside the parent's closing proof.

## 6. M3: mathematical exploration and discovery

### 6.1 Discovery loop (P5/P6)

Run manifest (§9.1, extended) carries all discovery parameters: `discovery: { selectionK, convergenceG, rngSeed, populationSize, programLanguage, evaluatorSignature }` (r2 finding 12 — strict schema now includes them).

```
1. select parents (seeded RNG: top-K by score + K random)
2. LLM mutates programs
3. evaluator gate (§6.2) — failing individuals discarded
4. scored insertion; new records generate claims (§6.3)
5. budget exhausted or converged (no improvement for G generations) → terminal
```

Population snapshots: `population/gen-<n>.json` `{schemaVersion, rngState, individuals: [{id, program, score, evaluatorVersion, parentIds}]}` (rngState recorded for resume; seeded selection makes *selection* reproducible — model-generated programs are documented as not bit-reproducible, r2 finding R9 honesty).

### 6.2 Evaluator gate

1. **Trusted examples**: positive/negative examples supplied in the run manifest **before** the loop (user-supplied or literature-known; never generated by the evaluator's own generation pass). Evaluator must pass all.
2. **Property double-implementation**: independent checker program per claimed invariant (different generation pass). Disagreement fails the gate.
3. Evaluator versions hash-pinned into claims; a change mints a new version and moves affected claims to `revalidation-pending` (§6.3).
4. Correlated-mistake caveat documented in the skill (two model-generated implementations agreeing is weak evidence).
5. Feasibility (runs) separated from objective scoring (achieves).

### 6.3 Claim status taxonomy (complete transition table; core subset ships in M0, r2 finding 13)

```
States: open, proven, proven-of-formal-statement, experiment-supported, falsified,
        revalidation-pending, superseded, fidelity-failed

open → proven                       L2 pass + statement_faithful ∈ {anchored, human-confirmed}
                                    + NO outstanding L1 counterexample (v4 guard: a recorded
                                    full-isolation counterexample blocks `proven`)
open → proven-of-formal-statement   L2 pass + statement_faithful = model-assessed
open → experiment-supported         experiment evidence (evaluator version hash + snapshot ref)
open → falsified                    counterexample evidence (program demonstrating the violation,
                                    or Lean proof of the negation) — full isolation tier only
                                    for computational counterexamples (§4.4)
proven-of-formal-statement → proven  later fidelity upgrade (anchored reference check passes,
                                    or human confirmation via §3.3 channel) + NO outstanding
                                    full-isolation L1 counterexample (same guard as open → proven, v5)
experiment-supported → proven      formal proof later supplied, guarded EXACTLY as
                                    open → proven (L2 + anchored/human-confirmed fidelity +
                                    no outstanding L1 counterexample — v4: no weaker path)
proven|proven-of-formal-statement|experiment-supported → superseded
                                    fidelity correction, or evaluator revalidation failure
falsified → superseded              fidelity correction of the statement it falsified
any(non-terminal) → revalidation-pending   evaluator version changed (v4: terminal
                                    `fidelity-failed` and `superseded` are excluded as sources)
revalidation-pending → prior state revalidation passed
revalidation-pending → superseded  revalidation failed
any(non-terminal) → fidelity-failed  disputed with allowHumanFidelity=false (terminal; terminal
                                    states are never re-sources, v5)
L1-counterexample vs L2-pass conflict → the claim's `statement_faithful` field is set to
                                    `disputed` and the claim status moves to `fidelity-failed`
                                    (terminal) or escalates per §3.3 — the ledger represents
                                    the conflict as this explicit state pair, never auto-resolves
```

- `computation_verified` (pass|fail|not-applicable): a computational **pass is never required** for `proven` (many abstract theorems have no meaningful computational test), but an outstanding authoritative (full-isolation-tier) L1 counterexample **blocks promotion** (the guard in the `open → proven` edge above).
- Ledger integrity: chain hash over `claims.jsonl` (canonicalized JSON, field order fixed, hash = sha256 of entry bytes + previous hash); `--verify` detects any field edit. Typed verification records `{kind, verdict, bindingHashes}` produced only by the verifier scripts; transitions require them.
- The M0 ledger ships the core subset: {open, proven, proven-of-formal-statement, falsified, superseded, fidelity-failed} + chain hash + typed records; {experiment-supported, revalidation-pending} and their transitions arrive with M3 (each milestone's PR extends the table; the ledger rejects unknown states — forward-compatible by explicit enumeration, not silently).

**Novelty (advisory, never gates):** `unknown | known-equivalent | possibly-new | novel-to-harness`, with the mandatory "not a mathematical novelty claim" qualifier.

## 7. Experience reuse and research memory (RQ5)

### 7.1 Cross-session facts

Durable conclusions via `memory_save` at run end. The M1 close-out procedure (in `references/evidence.md`) specifies per-fact: type mapping (theorem/counterexample → `reference`; project state → `project`), name slug, and one-fact-per-topic-file size discipline.

### 7.2 Proof experience store (P3 verifier-gated)

`.math/experience/` (workspace-local, §3.1; cross-run lock, §3.3):
- **Success store**: only `formal_proof_valid` records — `{goalShape, premises, tacticSkeleton, sourceProblem, verifiedAt, bindingHashes}`.
- **Failure store**: `{goalShape, failedApproach, errorClass}` — consulted before generation.
- Retrieval: `experience.mjs --query "<goal shape>"` (FTS5).
- Tiering, honest v1 semantics (r2 finding 9): cheap lane = delegate to the existing executor subagent (its pinned model); strong lane = main conversation. No aliases invented, no settings. The choice rule (experience-hit → cheap; miss or repair-round-1 failure → strong) is a skill-level routing instruction, not a runtime mechanism.

## 8. Evaluation and cost-benefit (RQ6)

### 8.1 Benchmarks

`packages/evaluation/math-eval/fixtures/` — miniF2F valid subset (~48), ProofNet subset (~40; three artifacts + reference formalizations natively present → doubles as M1 fidelity eval set AND the trusted-anchor source), PutnamBench sample (~30). Each fixture dir records `{source, license, fetchedAt, sha256, problemIds}`; problem identities for each slice are pinned in `gold-set.json`; redistribution-forbidding licenses fail CI.

### 8.2 Metrics

- `pass@1` (fixed cap), `pass@k` (k ∈ {4,8}; each of the k runs is a full independent run of the config).
- `tokens-per-solved`, `wall-clock-per-solved` (actual usage reported alongside).
- Verification reliability: §4.3 protocol.
- M3: known-answer reproduction rate.

### 8.3 Ablation matrix (corrected semantics)

**Budget matching = fixed caps (v4: F1 is the one declared exception).** Every config gets the same pre-declared envelope (maxAttempts, token cap, wall-clock cap, one single model lane — the main conversation, so tier routing is out of the picture entirely) — **except F1, which is defined as the search config with attempts capped at 1** (that exception is the point of F1; it is stated here so no other config may deviate). Early stop allowed; unused budget reported, never forced spent; actual usage always reported separately.

**Uniform scoring for every config A–H incl. F1 (v4 — proof benchmarks require a checked proof; two-seat r3 convergence):** the scorer takes the candidate's stated final answer, which for proof benchmarks consists of a **statement AND a proof** (for A/B the NL answer text incl. its proof; for C–H/F1 the formal statement and proof produced). The scorer formalizes-or-passes the candidate's **own** statement and proof, then checks: (a) the candidate statement is kernel type-equal to the benchmark's reference statement — or a kernel-checked equivalence proof between the two, recorded by the scorer under its own budget and rules; (b) **the candidate's proof passes the full L2 check** (compile, binding, sorry/axiom rules) against the candidate statement. A candidate that merely restates the benchmark theorem supplies no valid proof and does not pass. The scorer never supplies proofs or missing reasoning — it only translates what the candidate itself asserted. Scorer formalization is model-assisted with a fixed, pre-declared budget charged to the scorer (not the config), one repair round. Reference formalizations come from the benchmark fixtures (trusted anchors, §4.3).

| Config | prompt | bash+lean | retrieval | feedback | search/multi-sample | experience |
|---|---|---|---|---|---|---|
| A baseline | — | — | — | — | — | — |
| B +prompt | ✓ | — | — | — | — | — |
| C +tools | ✓ | ✓ | — | — | — | — |
| D +retrieval | ✓ | ✓ | ✓ | — | — | — |
| E +feedback | ✓ | ✓ | — | ✓ | — | — |
| H +retrieval+feedback | ✓ | ✓ | ✓ | ✓ | — | — |
| F +search (over H) | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| F1 search@1 | ✓ | ✓ | ✓ | ✓ | (attempts=1) | — |
| G full | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

Attribution (narrowed and honest): C→D isolates retrieval; C→E isolates feedback; H→F isolates the search mechanism **inclusive of its extra sampling** (this is what "search" means in this harness; F1 vs H additionally reports the single-attempt variant so sampling cost is separable); F→G isolates experience. Experience snapshot: built from a **designated training split** of the fixtures (split recorded in gold-set.json; test problems write-blocked; empty snapshot makes G≡F and is reported as such — snapshot provenance line in every report). Tool CPU cost (index build, Lean runs) reported separately, one-time-amortized.

### 8.4 CI wiring

- Structure-only tests in CI (fixtures integrity, gold-set hashes, scorer units, license records) — no model calls.
- `pnpm math-eval:check` added to root package.json AND wired into presubmit's script list (§3.4 row 11).
- Real evaluation offline on demand.

## 9. Data and artifact specs

### 9.1 Run directory (strict schema; discovery fields included, r2 finding 12)

`.math/runs/<run-id>/`:

```
run-manifest.json  # STRICT schema: { goal, budget: {attempts, tokens, wallClockMs},
                   #   allowHumanFidelity: bool, tierPolicy: "main|delegated" (v1 lanes),
                   #   discovery: { selectionK, convergenceG, rngSeed, populationSize,
                   #                programLanguage, evaluatorSignature } | null,
                   #   trustedExamples: [...], createdAt }  — unknown fields rejected;
                   #   defaults (v4, written out): budget.attempts=8, budget.tokens=200000,
                   #   budget.wallClockMs=1800000, allowHumanFidelity=false,
                   #   tierPolicy="main", discovery=null
problems/*/        # §4.1 (per-problem: search.json, attempts/, binding.json, …)
population/        # §6.1 snapshots
claims.jsonl       # chain-hashed (main-conversation single writer)
budget.json        # reservation/settlement + write-ahead intents (opId-keyed, idempotent replay)
evidence/          # {claimId}/{kind}/… + RECEIPT.json
report.md          # claim references must show receipt verification results
```

### 9.2–9.4 Claim record, transitions, receipts

As §6.3; `claim-ledger.mjs --transition` validates the (milestone-current) table + typed records + hashes, exit 2 on illegal transitions; `--verify` checks the chain. RECEIPT.json: all file sha256s + generating command + timestamp.

## 10. Delivery plan and DoD

| Milestone | Deliverables | Acceptance |
|---|---|---|
| M0 foundation | plugin skeleton + §3.4 rows 1–14 + mathlib-env (wrapper project + olean cache) + index + search + lean-run with binding + statement-check mode + ledger (core states) + budget ledger (reservation/settlement/opId replay) | ① env cold-provisions on macOS arm64 (receipt valid; no Mathlib source build); ② lean-run: 10 pos/neg fixtures (negatives: sorry-warning, bad axiom, wrong-type proof, tampered hash, unparseable run) all judged correctly; ③ binding rejects `theorem foo : True` for an unrelated statement; ④ statement-check mode tolerates statement sorry, L2 does not; ⑤ chain-hash detects manual claims edit; ⑥ reservation gate refuses over-cap dispatch; opId replay rolls back an unsettled intent (tests); ⑦ L1 isolation tiers: partial tier runs advisory-only and a partial run claiming `fail` is a ledger error (test); authoritative failure requires full tier (test); ⑧ structure tests green in CI incl. new workflow job |
| M1 | three-artifact contract + fidelity gate (3 checks, decision table, anchored grade) + math-verify | ① ProofNet subset 40 problems formalized — procedure specified: import selection via retrieval, declaration naming convention (`<problemId>_stmt` / `<problemId>_proof`), sorry policy per §4.1; gate outcome distribution reported; ② anchored-grade kernel check works on seeded equal/unequal reference pairs; ③ measurement protocol runs on corrupted-pair set; ④ worked example |
| M2 | search loop + repair + scaffolding | ① minimal internal runner (single-problem, A vs F, fixed caps, usage report; if A solves zero, the ratio threshold does not apply and the absolute token cap — 250K/problem — must be **satisfied** by F, not merely reported) with pre-declared non-degradation threshold: tokens-per-solved ≤ A's × 1.5, or absolute cap 250K/problem; ② repair cap (2), scaffold depth cap (3), branch-only termination enforced (tests); ③ resume discards tampered attempts and conservatively charges unsettled intents (test); scaffold failure matrix (§5.4 states) covered by tests |
| M3 | discovery loop + evaluator gate + experience store + extended claim table | ① known-answer reproduction on injected problems; ② evaluator gate rejects a deliberately broken evaluator (test); ③ illegal transitions across the FULL §6.3 table exit 2 (test matrix); ④ experience store rejects non-verified records (injection test); ⑤ revalidation-pending lifecycle test |
| Eval | math-eval package + ablation + report | ① all 9 configs run the benchmark with artifacts on disk; ② reliability numbers reported; ③ CI structure tests green |

Each milestone a separate PR stacked on M0, with per-PR file lists and Verification fields (behavior / driver / observable result) per the change-cookbook convention.

## 11. Risks and mitigations

1. **Fidelity residual surface**: checks 1/3 are model judgments; the anchored grade removes the model from the loop wherever a reference exists; false-accept is measured (§4.3).
2. **Mathlib cache availability**: pin prefers tagged releases with published caches; missing cache = pre-spend provisioning error.
3. **Diagnostics parsing**: own-report-JSON pattern; unparseable = failed attempt with raw preserved; parser fixtures pinned to the pinned version (CI re-records on pin bump).
4. **Two vendored toolchains**: v1 accepted; shared library follow-up.
5. **Token overshoot**: admission control exact; consumption-after-dispatch cooperatively bounded only (child envelopes are instructive); documented threat model.
6. **Pseudo-discoveries**: trusted examples, double-implementation, caveats.
7. **Experience pollution**: verifier-gated + chain-hash + ablation write-blocking.
8. **Licenses**: delivery-blocking checklist.
9. **Node floor**: FTS5 feature-detect, fail closed with diagnostic.

## 12. Non-goals

- No model training/fine-tuning.
- No interactive tactic-level proof state channel, no Lean IDE, no MCP server (v1). The loop is attempt-level.
- No claim of mathematical novelty — novelty is advisory.
- No preset default mounting (optional marketplace plugin).
- No upstream harness changes.
- No cross-plugin shared Lean runtime (follow-up).
- No new npm runtime deps. Python+sympy optional (L1 tri-state); in-session L1 runs at the partial (advisory) isolation tier — authoritative L1 failure and falsification require the full (network-isolated) tier; a partial run claiming failure is a ledger error.
- No new model aliases or per-tier runtime dispatch (v1 tiers are delegation choices among existing pinned lanes).
- Tactic-level proving, multi-prover backends, large-scale parallel evolution infrastructure: out of scope.

## 13. Review ledger

Three-seat blind review (dsh-cc-agents:critic subagent, cc-codex-bridge lane, cc-grok-bridge lane; seats mutually blind, same-revision delta re-reviews). Working drafts and briefs live in `.scratch/mrh-*` and `.scratch/{review,delta}-brief-mrh*.md` (uncommitted).

| Round | Design revision | critic | codex | grok | Key folds |
|---|---|---|---|---|---|
| r1 (full) | v1 | GWC (2×P0, 7×P1, 4×P2) | NO-GO (3×P0, 12×P1) | (auth failure, absent) | fabricated repo precedents removed; Mathlib olean-cache provisioning; budget enforcement honesty; search.json/claim schemas; proof binding via Inspector pattern; ablation budget semantics; English rewrite |
| r2 (delta) | v2 | GWC (3×P1) | NO-GO (8×P1) | NO-GO (14×P0, 10×P1) — full review | fidelity authority restructured (machine-confirmed retracted → anchored/human-confirmed/model-assessed/disputed); statement sorry policy + statement-check mode; reachability direction corrected; scorer against reference statement; sandbox-exec named; workspace-local storage; claim machine completed; 14-row repo-integration table |
| r3 (delta) | v3 | GWC (1×P1) | NO-GO (5×P1) | GWC (3×P0, 7×P1) | anchor check as outcome column (9-row table); scorer requires candidate proof (restatement fails); experiment-upgrade guard; budget one-envelope claim removed; rollback never refunds; per-attempt build isolation; sandbox honesty tiers; disputeReason |
| r4 (delta) | v4 | GO (2×P2) | GWC (4×P2) | GWC (4×P1 stale-sentence conflicts) | env-id single identity; model-assessed exact definition; computation gating wording; M0 DoD / §12 sandbox alignment; partial-tier pass semantics; upgrade-path L1 guard |
| r5 (micro) | v5 | GWC (1×P2) | GO (0) | GWC (1 finding) | env-id duplicate removed; infra-failure retry window made explicitly pre-commitment |
| r6 (final) | v6 | **GO** | **GO** | **GO** | — (confirmations only, zero findings) |

Cross-seat convergences that shaped the design (top-confidence folds): fidelity-gate authority (all three seats, r2–r3), statement.lean sorry semantics (all three, r2), premise-reachability direction (codex+grok, r2), uniform scorer contract (all three, r2–r3), anchored-check-as-outcome (all three, r3).
