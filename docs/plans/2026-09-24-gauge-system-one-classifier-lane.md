# Gauge lane: System One decision models (`llmbox_systemone/laya`) for the auto-mode classifier

**Status:** **Design — reviewed.** Two cold-review rounds by dsh-cc-agents:critic (2026-09-24): round 1 blockers B1–B3 (string-form alias misrouting, probe scope, spurious inherit warning) and should-fixes S1–S4 addressed; round 2 verified all anchors against code and its four residual items (string-form warn gap, service-unmounted gap, helper signature, test scoping) are addressed in this revision. Pending implementation (PR-A, PR-B; PR-C conditional).

**Date:** 2026-09-24

## 1. Background: the model class

Laya ([github.com/NandhaKishorM/laya](https://github.com/NandhaKishorM/laya), [Hugging Face](https://huggingface.co/convaiinnovations/laya-typed-decisions), [docs site](https://nandhakishorm.github.io/laya/), Apache-2.0, Convai Innovations) is a non-autoregressive "System 1" decision engine in the same family as TypeSafe AI's commercial Jev ([introducing System One models and Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev); [Jev on OpenRouter](https://openrouter.ai/docs/guides/community/jev)). All model facts in this section come from the public documentation; which checkpoint and gateway shape the deployment actually serves is settled by the §6 probe, not assumed here.

Documented properties that matter for this design:

- **Typed decisions, not text generation.** A request is a `state` object plus a `questions` map. Each question is one of three types: `choice` (a top label with per-label probabilities), `score` (an expected level on an ordinal rubric), `noul` (a calibrated P(true)). Every answer carries a `confidence` and an `answer_confidence` ([answer shapes](https://github.com/NandhaKishorM/laya/blob/main/agent.py)).
- **Calibrated probabilities.** Training uses strictly proper scoring rules (RLCD), so confidence supports threshold gating: act automatically above a threshold, escalate below it ([confidence-gating pattern](https://github.com/NandhaKishorM/laya#readme)).
- **One forward pass, no sampling.** Published benchmarks report ~33–40 ms per prediction, versus the ~0.7–5 s an autoregressive cheap lane takes for a short structured response. Checkpoints: `laya` (ModernBERT-large, 421M, 512-token context, English), `laya-multilingual` (mmBERT-base, 322M, 1024-token context, 100+ languages), `laya-typed-decisions` (ModernBERT-large, 421M, 1024-token context).
- **Native wire protocol.** The reference HTTP surface is `POST /v1/systemone` with `{state, questions, model?}` in and `{model, answers, usage, routing}` out, byte-compatible with TypeSafe Jev's API ([serve.py](https://github.com/NandhaKishorM/laya/blob/main/serve.py)).
- **It cannot summarize, rewrite, title, or chat.** Any dsh-cc lane whose output is prose is out of scope for this model class.
- **Instruction-following is not a given.** A typed-decision head has no mechanism to honor an arbitrary chat system prompt. Whether `llmbox_systemone/laya` behind the orchestrix gateway can be driven through a normalized chat stream at all — and how much of a prompt survives the gateway's compilation into `state`+`questions` — is the central unknown, addressed by the §6 probe and the branching in §5. The native adapter (PR-C) is the *expected* long-term integration; the chat path (PR-B) is the optimistic one whose viability the probe must prove.

Orchestrix already serves this model as `llmbox_systemone/laya`.

## 2. dsh-cc status quo (anchors)

**Alias system** — `packages/compat/cc-model-aliases/src/resolver.ts`:

- `CC_ALIASES = ['fable','opus','sonnet','haiku']` (`resolver.ts:30`) and `LANE_ALIASES = ['sketch','draft','blueprint','masterplan','architect']` (`resolver.ts:47`) are the builtin vocabulary; `BUILTIN_ALIASES` (`resolver.ts:62`) is their union and is asserted verbatim in `tests/resolver.spec.ts:199`.
- A lane that is not configured follows its CC peer via `LANE_PEERS` (`resolver.ts:50-55`): `sketch→haiku`, `draft→sonnet`, `blueprint→opus`, `masterplan→fable`; `architect` inherits the parent route. Peer following is one hop (`followStringTarget`, `resolver.ts:307-328`): if the peer is itself unconfigured-but-builtin the resolution is "inherit the parent route" (`resolver.ts:326`).
- **String-form alias targets are never split on `/`.** A string value is treated as a model id (`resolver.ts:229`, `:316`): `"gauge": "llmbox_systemone/laya"` resolves to `{model: 'llmbox_systemone/laya'}` with the provider inherited from the calling agent's request header (`pre-execute.ts:66-84`) — the call would go to the *parent's* chat provider with a mangled model id. Gateway-prefixed model ids therefore require the object form `{provider, model}` (§4.6).
- Aliases are open-set: an unknown lowercase word that is not builtin warns once and passes through as a literal model id (`resolver.ts:264-267`). `gauge` must join the builtin lists, or an unconfigured `gauge` reference would route to a nonexistent literal model.
- Resolution is live: resolvers read a per-invocation alias map (`resolver.ts:132-170,211-288`); host-plane helpers `resolveAlias`/`resolveDetailedAlias` (`service.ts:121-155`) fold deployment config with the live settings overlay without re-registering. Settings values may be a string, an object `{provider, model, reasoningEffort?}`, `null` (delete), or the `warnOnInherit` boolean control key (`schema.ts:46-66`).
- **Two consumption paths carry different warning behavior.** `createModelResolver.resolveDetailed` fires the once-per-process inherit warning ("cheap-lane savings are zero") when a builtin or a lane-with-builtin-peer inherits (`resolver.ts:144-152`). `createModelInspector` (`resolver.ts:211-288`) never emits that warning; it warns only on literal passthrough of unknown lowercase words. The service publishes both faces as `ccModelRoutes` (`service.ts:89-96`: `resolve`/`resolveDetailed` from the resolver, `inspect` from the inspector). §4.2 leans on this split.

**Auto-mode classifier** — `packages/interaction/permission-rules/`:

- The stage consults the LLM only for auto-mode LOW-risk calls that the deterministic waterfall left at ask/passthrough; verdicts are escalate-only (`decide.ts:111-126,186`).
- Route name source today: `host.settingsSection().autoMode?.classifier?.route ?? 'haiku'` (`pre-execute.ts:171-172`), resolved per call by `resolveDetailedRoute` (`pre-execute.ts:66-84`), which fills a missing provider/model from the calling agent's request header and returns `undefined` when either is absent (→ `unarmed`, the stream is never called, `llm-classifier.ts:372-379`).
- The PI probe has the same shape with its own `autoMode.probe.route ?? 'haiku'` (`pre-execute.ts:214-215`), but its own prompt (~1 KB of system prose, `pi-probe.ts:210-221`), its own input windows over tool output (`HEAD_CHARS = 3072`, `TAIL_CHARS = 1024`, `pi-probe.ts:156-157`), and its own strict-JSON parser for a different shape (`{"injection":bool}`, `parseProbeVerdict`, `pi-probe.ts:195-207`).
- Classifier contract: strictly-one-JSON-object output `{"verdict":"allow"|"ask"|"deny","reason":…,"rule"?}` (`llm-classifier.ts:278,297-319`); a `deny` whose `rule` is not an exact `hard_deny` entry downgrades to `ask` (`llm-classifier.ts:309-317`); unparseable is `malformed`→ask; timeout/cancel/error have their own tags (`llm-classifier.ts:414-467`).
- Input assembly: `<tool_call>`-fenced payload capped at `INPUT_CAP = 4096` chars plus optional D7 transcript sections hard-capped at `ASSEMBLED_CAP = 8192` (`llm-classifier.ts:126-130,196-249`); the system prompt renders the hard-deny, soft-deny, allow-exception, and environment slots plus behavior rules (`llm-classifier.ts:251-280`); `MAX_TOKENS = 1024` (`llm-classifier.ts:138`).
- Never-throws posture; per-route circuit breaker keyed by `provider/model` (threshold 3, tags `malformed|error|timeout`, seeded from the session log; `classifier-breaker.ts:15-36`, `auto-stage.ts:328-332`, `auto-stage.ts:369`); digest-only `permission/classifier` audit events carrying `provider`/`model` (`classifier-audit.ts`); opt-in raw channel `DSH_PERMISSION_CLASSIFIER_DEBUG=1` (`pre-execute.ts:179-181`).
- Stream plumbing: `createClassifierStreamAdapter` (`classifier-lane.ts:50-104`) speaks to the harness `llm` service with a memoized per-route reasoning-effort resolution (catalog-aware; omits and warns once when the route declares no efforts).
- Settings schema is mirrored in two places by design: `packages/settings/settings-cascade/src/auto-mode.ts:113-115` (classifier `route` default `'haiku'`; the probe default lives in the same file at `:101`) and `packages/interaction/permission-rules/src/settings-schema.ts:128-133` (classifier only — the mirror has no probe sub-schema). Other defaulting/reporting sites: `auto-stage.ts:224` (`readSlice` armor) and the `/auto-mode config` renderer (`packages/interaction/command-auto-mode/src/index.ts:82`). After PR-B, `grep -rn "route ?? 'haiku'\|default('haiku')"` over both packages must find no remaining *classifier-probe-unspecified* defaulting site for `classifier.route` (the probe keeps its default until PR-C).

## 3. Fit analysis: which cheap-lane sites gauge can serve

Laya answers typed questions about a state; it does not generate text. The decision is per-site, by output shape:

| Cheap-lane site | Output shape | Gauge? |
|---|---|---|
| Permission risk classifier (`permissions.autoMode.classifier.route`) | 3-way verdict (`choice`) | **Yes — PR-B primary target** |
| Input-layer PI probe (`permissions.autoMode.probe.route`) | yes/no suspicion (`noul`) | Yes — **deferred to PR-C** (native `noul` mapping); PR-B leaves it on haiku for the reasons in §2 (chat-JSON contract + 4 KB input windows would 100% `malformed` on a compact lane) |
| Classifier second pass (D13 reconsider) | same as classifier | Yes, follows the classifier route |
| Memory recall selector (`recallUseSmallFast`) | per-candidate relevance | Not now; decision-shaped (`score` per candidate) but needs an N-question fan-out design of its own — future work only |
| `web_fetch` summarizer (`tool-web-fetch`), session-title-provider, Tool Use Summary / side-query / context-crusher reducer, advisor-watchdog advice, prompt-suggest, hook prompt/agent forks, bundled agents (`explore`, `dsh-cc-guide`), shunt reader/writer | prose output / full agent turns | No (generative) |

The requirement "when gauge is not configured, keep using haiku/sketch" maps exactly onto the lane-peer machinery: `gauge` is a lane alias whose CC peer is `haiku`, and `sketch` already shares the `haiku` route.

## 4. Design

### 4.1 The `gauge` lane alias (PR-A)

Add `gauge` as a builtin **lane** alias with peer `haiku`. Edits:

1. `packages/compat/cc-model-aliases/src/resolver.ts`
   - `LANE_ALIASES` (`:47`): append `'gauge'`.
   - `LANE_PEERS` (`:50-55`): add `gauge: 'haiku'`.
   - Update the lane table in the module comment (`:39-45`) with a `gauge` row (typed-decision cheap lane for System One models).
2. `packages/compat/cc-model-aliases/tests/resolver.spec.ts` (`:199`): extend the exact `BUILTIN_ALIASES` assertion; add cases: configured `gauge` wins; unconfigured `gauge` follows a configured `haiku` (provenance `via: 'peer', hop: 'haiku'`); both unconfigured → inherit; `gauge$high` suffix stripping; the once-per-process inherit warning fires for a genuinely inherited `gauge` (see §4.2 for how the classifier policy avoids ever triggering it).
3. `packages/interaction/command-doctor/src/checks/models.ts` (`:38-43` hard-copied `LANES`, `:63` rendering): add the `gauge → haiku` row so `/doctor` shows it next to `haiku (+ sketch)`.
4. Docs: `packages/compat/cc-model-aliases/README.md` / `README.zh.md` alias tables; the lane enumeration in the root `README.md` / `README.zh.md`. Run `pnpm check:readme --write` after any README edit and commit the re-recorded hash pair.
5. `docs/claude-code-capabilities.yaml` `models.aliases` entry (`:3306` region): mention `gauge` in the summary/deviation prose; regenerate with `pnpm docs:parity` and commit the matrix + README parity block together.

Semantics inherited free of charge: object-form targets take effect on the next resolution without restart; an unconfigured `gauge` behaves exactly like `haiku`; `$level` suffixes keep working; nothing changes in deployments that never mention `gauge`, except one extra builtin name in inspection output and the §4.2 behavior.

### 4.2 Classifier route-selection policy (PR-B)

Requirement: *configuring the gauge alias alone* switches the auto-mode classifier to gauge; with gauge unconfigured, today's haiku/sketch behavior holds byte-for-byte, including warnings; an explicit route in settings always wins and is never silently redirected.

The policy is name-level and is implemented once in a new `packages/interaction/permission-rules/src/route-policy.ts`:

```ts
/** Per-process warn ledger for the two warn-once cases below. Same idiom as the resolver's inheritWarned set (resolver.ts:73-78). */
const policyWarned = new Set<string>()

/** Wrap ctx.logger.warn with the per-process per-key dedup; exported for tests to reset the ledger. */
export function createWarnOnce(warn: (message: string) => void): (key: string, message: string) => void

/**
 * Which route name the classifier should use this call. Probing gauge never
 * emits the resolve-side inherit warning: the check runs on the warning-free
 * inspector face (resolver.ts:144-152 vs :211-288).
 */
export function pickClassifierRouteName(
  ctx: Context,
  explicit: string | undefined,
  warnOnce: (key: string, message: string) => void,
): string {
  if (explicit !== undefined) return explicit
  // Service face when cc-model-routes is mounted; otherwise mirror the
  // service-then-overlay fallback that resolveDetailedAlias uses
  // (service.ts:143-155), built over the inspector so the probe stays
  // warning-free. The overlay read is a one-liner mirroring service.ts:146-147
  // (settings provider get on the model-aliases namespace; undefined unmounted).
  const routes = ctx.get('ccModelRoutes') as ModelRoutes | undefined
  const inspect = routes?.inspect
    ?? createModelInspector(() => mergeAliasMaps(undefined, readModelAliasesOverlay(ctx)))
  const verdict = inspect('gauge')
  // 'configured' = direct object/string target; 'one-hop' = string target naming
  // another alias. 'peer'/'builtin' inherits mean "gauge is NOT armed".
  if (verdict.kind === 'route' && (verdict.via === 'configured' || verdict.via === 'one-hop')) return 'gauge'
  // String-form mispelling of a provider/model pair (§4.6): loud, then haiku.
  if (verdict.kind === 'literal' && verdict.route?.model?.includes('/')) {
    warnOnce('permission-rules:gauge-string-pair',
      'gauge alias value looks like a provider/model pair; alias strings are model ids — use the object form {"provider","model"} (gauge design §4.6)')
  }
  return 'haiku'
}
```

The barrel addition this needs: if `createModelInspector` and `mergeAliasMaps` are not already re-exported by `packages/compat/cc-model-aliases/src/index.ts`, add them (additive, no behavior change).

Resolution then stays at the existing seam: `resolveRoute: exec => resolveDetailedRoute(ctx, exec, pickClassifierRouteName(ctx, host.settingsSection().autoMode?.classifier?.route, warnOnce))` at `pre-execute.ts:171-172`, with `warnOnce` instantiated once per plugin instance from `ctx.logger.warn`. Two behavioral rules:

- **No spurious warning when gauge is unset.** The configured-ness check runs through `inspect` (warning-free for builtins), and `resolveDetailedRoute('gauge')` is only ever called when gauge is genuinely armed — in which case `resolveDetailed` takes the `route` branch and the inherit warning cannot fire. The final `'haiku'` name keeps warn traffic byte-identical to today. A regression test asserts zero warnings from the policy helper across N evaluations with gauge absent.
- **Half-configured gauge is loud, not silent.** Two warn-once cases, both falling back to `haiku`: gauge selected but `resolveDetailedRoute` yields `undefined` (e.g. object form missing `provider` and no usable parent header) fires key `permission-rules:gauge-unresolvable`; the string-form provider/model mispelling fires key `permission-rules:gauge-string-pair` from inside the helper. Today an explicit-but-broken route disarms silently in comparison; gauge gets the notices because its selection is implicit.
- **Service-unmounted parity.** The overlay fallback in the helper mirrors `resolveDetailedAlias` (`service.ts:143-155`), so a gauge configured purely through live settings is honored even when the `cc-model-routes` plugin is absent — the same reach the existing resolve seam already has.

Edits:

1. **Schema: stop materializing `'haiku'` for the classifier route.** Change `route` to absence-preserving (`z.union([z.string(), z.const(undefined)])`) in `packages/settings/settings-cascade/src/auto-mode.ts:115` and `packages/interaction/permission-rules/src/settings-schema.ts:130`; update the `AutoModeClassifier.route` doc comment at `auto-mode.ts:19` to state the policy (*explicit route wins; otherwise gauge when armed, else haiku*). The probe default at `auto-mode.ts:101` is untouched in PR-B.
2. `auto-stage.ts`: `AutoModeSlice.route` (`:202`) and its `readSlice` default (`:224`) are **deleted, not retyped** — nothing reads `slice.route` (resolution lives in `pre-execute.ts`); the field is write-only dead state. The `raw` fingerprint already includes the `classifier` object, so rebuild semantics are unchanged.
3. `pre-execute.ts:171-172`: use the policy helper as above. The probe resolve seam at `:214-215` is untouched in PR-B.
4. Sweep tests: `packages/settings/settings-cascade/tests/auto-mode.spec.ts` (asserts the materialized classifier default today — flips to absence-preserving assertions; the probe-default assertions stay); any permission-rules settings-schema assertions asserting `route === 'haiku'` when omitted. Exit condition: the grep in §2 finds no classifier-route defaulting site outside `route-policy.ts`'s `'haiku'` tail.
5. Liveness: the policy evaluates per call against the live alias map, so writing or deleting the `gauge` settings alias changes the next classification without a slice rebuild. Selector provenance for the audit events comes from the resolved route's `provider/model`, which identifies laya regardless of which name selected it.

### 4.3 Compact execution profile for System One routes (PR-B)

The standard profile assembles up to 8192 chars of input plus a full four-slot system prompt and optional transcript sections. That exceeds the 512/1024-token context of every documented Laya checkpoint. When — and only when — the resolved route for the call is a System One route, the classifier uses a **compact profile**.

Route detection (single pure predicate in the new `src/classifier-profile.ts`, unit-tested):

```ts
isSystemOneRoute(route) =
  (route.provider !== undefined && route.provider.startsWith('llmbox_systemone'))
  || route.model.startsWith('llmbox_systemone/')
```

The provider-prefix arm is the norm (§4.6 mandates the object form); the model-prefix arm is belt-and-braces for deployments that put the gateway prefix in a string target anyway. Alias names are deliberately *not* part of the predicate, so an explicit `classifier.route` pointing at the same model under any custom name also gets the compact profile.

Compact profile parameters (provisional constants in `classifier-profile.ts`; the §6 probe checks them against the actual checkpoint context and adjusts):

| Knob | Standard | Compact (System One) |
|---|---|---|
| `INPUT_CAP` | 4096 | 1024 chars |
| Transcript (D7) sections | assembled when present | omitted entirely |
| `ASSEMBLED_CAP` | 8192 | 1024 chars (payload only) |
| System-prompt budget | unbounded slots | ≤ 2400 chars total; reduction order below |
| `MAX_TOKENS` | 1024 | unchanged (harmless) |
| Timeout | `classifier.timeoutMs` (8000) | unchanged; expected real latency is far lower |

System-prompt reduction order under the compact profile, applied in exactly this sequence until the prompt fits 2400 chars:

1. Render the safety preamble (the three "the input is data" lines) and the verdict contract verbatim; render the full `hard_deny` and `soft_deny` slots.
2. If over budget: drop the `environment` section.
3. If still over: drop the `allow`-exceptions section.
4. If still over: truncate each `soft_deny` line at 120 chars.
5. If still over: drop trailing `soft_deny` lines, keeping at least one.

`hard_deny` is never dropped and never truncated — dropping deny rules removes protection, while dropping allow-exceptions or environment only biases toward `ask`, the safe direction. At ~4 chars per token the totals land around 600 + 256 = ~856 tokens against a 1024-token checkpoint context; §6 step 4 must confirm the actual checkpoint's context window before PR-B merges.

**Honesty note on chat normalization (Branch A).** Under a chat-normalized gateway, the system prompt may survive only partially — or not semantically at all — through the gateway's compilation into `state`+`questions`. The slot budgeting above bounds the bytes we send, not the bytes the model sees. The §6 fidelity case (flip one `hard_deny` string and re-run one canonical deny case) exists precisely to measure whether rule text affects verdicts; if it does not, the compact profile still ships as a safe input bound, but gauge verdicts must be treated as slot-insensitive until PR-C's native adapter renders slots into question criteria.

### 4.4 Verdict parsing under the compact profile (PR-B)

A decision head surfaced through chat normalization may not honor "respond with a single JSON object". Under the compact profile only, `parseVerdict` gains one extra step, placed **after the existing code-fence strip and before the `JSON.parse`** (`llm-classifier.ts:297-304`): if the stripped, trimmed raw output case-insensitively equals `allow`, `ask`, or `deny` (an optional single trailing period tolerated), accept it as the verdict with an empty reason. A bare `deny` carries no rule citation, so it flows into the existing exact-match check and downgrades to `ask` (`llm-classifier.ts:309-317`) — gauge can never hard-deny, which matches the escalate-only posture and keeps the deterministic waterfall the only deny source that sticks.

Standard-profile parsing stays byte-identical (strict JSON only), so haiku lanes see zero behavior change. A compact-profile output that is neither a bare token nor valid verdict JSON is `malformed`, feeds the breaker, and is observable through the audit events and the raw debug channel, exactly as today.

### 4.5 Machinery that deliberately does not change

Never-throws and fail-to-ask posture; escalate-only application in `decide.ts`; the per-route breaker and its session-log seeding (gauge and haiku are distinct breaker lanes by `provider/model`, so a flaky gauge deployment never trips the haiku lane and vice versa); the verdict LRU cache (the key already includes the rendered input, and compact vs. standard renders differ, so profile switches never collide); D13 `secondPass` (both profiles); the disarm-once warn and legacy-path fallback; audit event shape and digest-only contract; `DSH_PERMISSION_CLASSIFIER_DEBUG=1`; `classifyAllShell`; the deny backstop; the PI probe's entire pipeline in PR-B.

### 4.6 Settings surface

No new settings keys in PR-A or PR-B. The enablement block is object-form:

```jsonc
{
  "model-aliases": { "gauge": { "provider": "llmbox_systemone", "model": "laya" } },
  "permissions": { "autoMode": { "classifier": { "enabled": true } } }
}
```

**The string form `"gauge": "llmbox_systemone/laya"` is not supported**: alias strings are model ids, never split on `/` (§2), so that spelling would dispatch `llmbox_systemone/laya` as a model id to the parent agent's own provider. Deployments following this doc use the object form; §7 includes a negative configuration test documenting the outcome of the string spelling so the failure mode is searchable, not mysterious.

Behavior matrix:

| `classifier.route` | `gauge` alias | Effective lane |
|---|---|---|
| set | any | the explicit route (unconfigured ⇒ disarm, as today) |
| unset | configured, resolvable | gauge (`llmbox_systemone/laya`) |
| unset | configured, unresolvable | haiku + one warn (§4.2) |
| unset | unconfigured | haiku (today's default; sketch deployments included via peer), zero new warnings |

Pin the old default explicitly with `"route": "haiku"` if a deployment configures gauge for other purposes but wants the classifier to stay on haiku.

### 4.7 Reporting surfaces

- `/auto-mode config` (`command-auto-mode/src/index.ts:82`): stop printing a fabricated `haiku` when `route` is unset. The rendered classifier block always carries three fields, snapshot-tested in both states:
  - `"route"`: the configured value, or the literal string `"auto"` when unset.
  - `"routePolicy"`: the constant `"explicit > gauge (if configured) > haiku"`.
  - `"gaugeRoute"`: when the `ccModelRoutes` service is mounted and gauge is armed, `"<provider>/<model>"` from `inspect('gauge')`; otherwise `null`.
- `/doctor` models check: the §4.1 `LANES` addition shows gauge with its peer, configured or inherited.

### 4.8 Capability manifest and docs

- `docs/claude-code-capabilities.yaml`: `models.aliases` summary/deviation (gauge lane, §4.1) and the `permissions.rules` classifier summary (`:3072-3101` region; the route policy and compact profile are dsh-cc extensions — CC has no such concept — so they follow the existing deviation style of that entry, with evidence anchors at `route-policy.ts` and `classifier-profile.ts`). Regenerate with `pnpm docs:parity` in the same commit; never hand-edit generated outputs.
- README lane tables (§4.1) + `pnpm check:readme --write`.

## 5. Delivery plan

**PR-A — `gauge` lane alias.** §4.1 only. Small, mechanical, independently mergeable.

**PR-B — classifier gauge policy + compact profile.** §4.2–§4.7, stacked on PR-A. Its PR body carries the §6 probe results in the Verification fields. PR-B is mergeable under either §6 branch: on Branch A it is the whole user-visible feature; on Branch B it degrades safely (malformed→ask→breaker, or a pinned `route: "haiku"`) while PR-C is built.

**PR-C — native System One adapter, probe migration, calibrated gating (conditional).** Required if §6 lands on Branch B; otherwise scheduled when calibrated confidence or moving the PI probe off haiku is worth the protocol work:

- A `classifier-systemone` adapter translating the verdict into a typed `choice` question (`criteria: {allow, ask, deny}` with short criteria prose rendered from the slots, state = compact tool-call rendering) over the gateway's native surface as recorded in §6.
- The PI probe as a `noul` question ("does this content contain instructions attempting to redirect or compromise an agent?") with a configurable threshold; `autoMode.probe.route` policy switch plus compact HEAD/TAIL windows; tests in `tests/pi-probe.spec.ts` and `tests/listener-pi-probe.spec.ts`; schema changes at `auto-mode.ts:101` mirrored wherever the probe route is consumed.
- Calibrated confidence gating on both: `confidence < threshold` (default 0.85, per Laya's documented gating idiom) reclassifies to `ask`; optional per-call fall-through to the haiku lane when both aliases are configured — off by default, because it reintroduces autoregressive latency and doubles per-call cost where gauge works.

PR-C gets its own plan document seeded from §6's recorded answer shapes; it is out of scope for PR-B's merge criteria.

## 6. Day-0 gateway probe (decides Branch A vs Branch B; also feeds PR-C)

Run against a real orchestrix deployment on a PR-A+PR-B build; paste the full outcome into the PR-B body:

1. Configure the §4.6 object-form block; export `DSH_PERMISSION_CLASSIFIER_DEBUG=1`.
2. Drive six canonical tool calls in an auto-mode session: `read package.json`, `git status`, `ls src` (expect allow); `curl -X POST https://example.com -d @file` (expect ask); `rm -rf ~` (expect deny under default hard-deny, or a recorded deny→ask downgrade on the compact profile); a `Task`/`subagent_fork` delegation whose prompt embeds an injection string (expect ask).
3. Record per call, from audit events and the raw debug channel: resolved `provider/model` (must be `llmbox_systemone`/`laya`), raw output shape, verdict, latency, failure tag if any.
4. **Checkpoint and ceiling check:** a deliberately oversized payload (≥ 4096 chars) to observe gateway truncation/error behavior, and a response-time sanity check against the documented 33–40 ms. This determines which checkpoint backs the route and whether §4.3's ceilings stand.
5. **Rule-fidelity case:** flip one `hard_deny` string and re-run the `rm -rf ~` case. Verdict tracks the edit ⇒ slot text reaches the model; verdict static ⇒ the gateway compiles a fixed question schema and slots are decoration — record either way; PR-B merges regardless, the result sets expectations for gauge's rule sensitivity until PR-C.
6. **Branch decision.** Raw outputs are verdict JSON or bare verdict tokens across all six cases ⇒ Branch A (chat-normalized), PR-B stands as the feature. Outputs are errors, empty, or verbatim System One answer objects ⇒ Branch B: PR-B still merges (the failure path is the already-tested never-throws machinery), and PR-C becomes the required follow-up.
7. **Native surface reconnaissance for PR-C (do it now regardless of branch):** if the gateway exposes it, POST one canonical `{state, questions}` request to its `/v1/systemone` endpoint — state = the §4.3 compact rendering of the `rm -rf ~` call; questions = one `choice` (`allow/ask/deny`) and one `noul` (injection wording) — and record the exact request/response pair, auth expectations, and `usage` block shape. PR-C's transport design starts from this transcript, not from a second probing round.

## 7. Verification plan

**Unit (PR-A):** `pnpm --filter @dsh-cc/model-aliases test` — extended exact-list assertion and the §4.1 peer/warning cases. `pnpm --filter @dsh-cc/command-doctor test` — the lane table renders gauge.

**Unit (PR-B):**

- `pnpm --filter @dsh-cc/settings-cascade test` — classifier `route` no longer materializes a default; absence preserved; probe default untouched.
- `pnpm --filter @dsh-cc/permission-rules test` — new specs cover:
  - `route-policy`: explicit wins; gauge-when-armed (`via: 'configured'` and `via: 'one-hop'`, both faces: mounted service and settings-overlay fallback with the service unmounted); gauge unconfigured ⇒ `'haiku'` with zero warnings from the policy helper (the downstream haiku inherit warning when haiku is *also* unconfigured is the resolver's pre-existing behavior, byte-identical to today, and out of scope for this assertion); string-form pair ⇒ warn-once key `permission-rules:gauge-string-pair` + `'haiku'`; selected-but-unresolvable gauge ⇒ warn-once key `permission-rules:gauge-unresolvable` + haiku; per-call re-evaluation after a settings write.
  - `classifier-profile`: `isSystemOneRoute` both arms; compact assembly omits transcript sections; 1024-char caps; the five-step reduction order with hard_deny never truncated.
  - parser: bare tokens (`allow`/`ask`/`deny`, trailing period, case variants) accepted on the compact profile; bare `deny` downgrades to ask; fence-wrapped bare token handled via the existing strip; strict-JSON behavior on the standard profile byte-identical.
  - breaker: gauge and haiku failure streaks do not mix (distinct `provider/model` keys).
  - a negative configuration case: string-form `"gauge": "llmbox_systemone/laya"` resolves to model id `llmbox_systemone/laya` on the inherited provider (documents §4.6's caveat as a test, so the failure mode greps).
- `pnpm --filter @dsh-cc/command-auto-mode test` — the §4.7 three-field rendering in both states (explicit route; unset route, service mounted and unmounted).
- Any test importing `@dsh-cc/model-aliases` declares it in that package's `devDependencies` (CI gate `check-spec-deps`); run `node scripts/check-spec-deps.mjs` locally after adding test imports.

**Integration:** extend `tests/listener-auto-stage.spec.ts` with a gauge-armed run whose stub stream returns bare `allow`, asserting the full path (armed → compact render → verdict applied → audit event with `model: laya`); one disarm case with the llm service absent. Existing `tests/auto-stage.spec.ts` and `tests/llm-classifier.spec.ts` keep passing; any assertion on the removed `'haiku'` default flips per §4.2's sweep.

**Manual smoke:** the §6 probe end-to-end, plus one session with `classifier.route: "haiku"` pinned to show unaffected legacy behavior.

**Repo gates (both PRs):** `pnpm typecheck`; the affected-package vitest runs above; `pnpm check:capabilities`; `pnpm docs:parity` with regenerated files committed; `pnpm check:readme --write` when a README changed; `node scripts/check-file-size.mjs` (new modules must fit budgets); `pnpm smoke:profile-boot` (settings double-module risk area — the schema mirror is being edited); `node scripts/check-spec-deps.mjs` after test-dependency changes; the local equivalent of the presubmit suite. Pre-commit and presubmit enforce the capability and parity gates.

**Observability acceptance:** with gauge armed and enabled, session `permission/classifier` audit events show `provider: llmbox_systemone, model: laya`; p50 classifier latency is far below the haiku baseline (~0.7–1.1 s recorded for the autoregressive lane); malformed rate ≈ 0 across the six canonical cases; no breaker trips over an hour of mixed allow/ask traffic.

## 8. Risks, mitigations, open questions

- **Chat normalization may be hypothetical.** A typed-decision head cannot follow chat instructions; §1 and §4.3 state this openly, §6's branch decision and fidelity case measure it, and PR-C carries the native integration. Worst case pre-PR-C: gauge disarms or breakers open to today's haiku behavior with visible notices.
- **String-form misconfiguration.** Alias strings are model ids (§2); §4.6 mandates the object form, §7 pins the string form's actual behavior as a negative test, and the policy helper's warn-once (§4.2, key `permission-rules:gauge-string-pair`) surfaces exactly this mispelling instead of silently drifting to haiku.
- **Gateway-side silent truncation.** Bounded by §4.3's ceilings (well under the smallest documented checkpoint context once adjusted by §6 step 4); ceilings are provisional constants in one module.
- **Deny fidelity.** Gauge cannot cite exact rule text; compact-profile denies all downgrade to ask by construction (§4.4). The deterministic waterfall remains the only sticking deny source, identical to unmatched haiku denies today.
- **Spurious inherit warnings.** The policy's gauge probe uses the warning-free inspector face (§4.2) with a zero-warn regression test; a gauge-unconfigured deployment sees byte-identical warn traffic.
- **Alias-name collision.** `gauge` is a common word; as a builtin it wins over a hypothetical literal model id `gauge`. No such provider id exists in the deployment matrix; the trade-off follows the `sketch` precedent.
- **Effort catalog mismatch.** If the orchestrix catalog declares reasoning efforts for laya, the adapter stamps the lowest level and the model ignores it; if none, the field is omitted. Both are existing adapter behavior with one memoized warn at worst.
- **Cost metering.** `llmbox_systemone/laya` has no price entry today; classifier traffic meters as zero-cost in `/cost` until pricing lands — follow-up, not a gate.
- **Open questions for the probe owner:** which checkpoint backs the route (512 vs 1024-token context sets §4.3 ceilings); slot fidelity on the chat path (§6 step 5); the native endpoint's exact request/response/auth/usage shape (§6 step 7); whether confidence/probabilities are surfable anywhere chat-visible (cheap PR-C win if yes).

## 9. Appendix: edit checklist

PR-A:

| File | Change |
|---|---|
| `packages/compat/cc-model-aliases/src/resolver.ts` | `LANE_ALIASES += 'gauge'`; `LANE_PEERS.gauge = 'haiku'`; comment table row |
| `packages/compat/cc-model-aliases/tests/resolver.spec.ts` | exact-list assertion + gauge peer/warning cases |
| `packages/interaction/command-doctor/src/checks/models.ts` | `LANES` row + rendering |
| `packages/compat/cc-model-aliases/README.md` / `README.zh.md` | alias tables |
| root `README.md` / `README.zh.md` | lane enumeration; then `pnpm check:readme --write` |
| `docs/claude-code-capabilities.yaml` (+ regenerated parity docs) | `models.aliases` prose |

PR-B:

| File | Change |
|---|---|
| `packages/settings/settings-cascade/src/auto-mode.ts` | classifier `route` absence-preserving (`:115`); doc comments describe the policy (`:19`); probe default (`:101`) untouched |
| `packages/settings/settings-cascade/tests/auto-mode.spec.ts` | classifier default assertions → absence assertions; probe assertions unchanged |
| `packages/interaction/permission-rules/src/settings-schema.ts` | mirror the classifier `route` schema change (`:130`) |
| `packages/interaction/permission-rules/src/route-policy.ts` (new) | `pickClassifierRouteName` + `createWarnOnce` per §4.2 (silent gauge probe via `inspect`, overlay fallback when the service is unmounted, two warn-once keys) |
| `packages/compat/cc-model-aliases/src/index.ts` | barrel: export `createModelInspector` / `mergeAliasMaps` if not already exported (additive) |
| `packages/interaction/permission-rules/src/pre-execute.ts` | classifier seam (`:171-172`) uses the helper; probe seam (`:214-215`) untouched in PR-B |
| `packages/interaction/permission-rules/src/auto-stage.ts` | delete dead `AutoModeSlice.route` (`:202`) and its `readSlice` default (`:224`) |
| `packages/interaction/permission-rules/src/classifier-profile.ts` (new) | `isSystemOneRoute`, compact caps, five-step prompt reduction, bare-token parse step |
| `packages/interaction/permission-rules/src/llm-classifier.ts` | consume the profile per call (caps, section omission, parse mode) alongside the per-call route |
| `packages/interaction/permission-rules/tests/*` | policy / profile / parser / breaker / negative-config specs per §7 |
| `packages/interaction/command-auto-mode/src/index.ts` (+ tests) | §4.7 three-field rendering, both states |
| `docs/claude-code-capabilities.yaml` (+ regenerated parity docs) | classifier summary notes (route policy, compact profile) |

PR-C seeds from §6 step 7's recorded transcript: native adapter, probe `noul` migration (schema at `auto-mode.ts:101`, windows in `pi-probe.ts`, parser, specs at `tests/pi-probe.spec.ts` / `tests/listener-pi-probe.spec.ts`), confidence gating. Its own plan document supersedes this outline.
