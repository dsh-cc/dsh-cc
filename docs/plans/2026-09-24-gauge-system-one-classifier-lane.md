# Gauge lane: System One protocol for typed decisions (native `/v1/systemone`)

**Status:** **Design — revised (native System One trunk).** Supersedes the 2026-09-24 revision that treated chat-normalized classifier streaming as the primary path (former PR-B). Revision drivers: architect review of PR #141; Research primary-source check (TypeSafe / learnjev / Laya); user clarification that **orchestrix is a multi-protocol gateway** (Anthropic-compatible + OpenAI-compatible **plus** a separate System One face). Prior critic rounds' seam anchors (alias string-form, inspector vs resolveDetailed, deny exact-match, settings mirrors) remain verified against `main` as of 2026-09-24 and are retained where still relevant.

**Date:** 2026-09-24 (rev 2)

## 1. Background: model class and gateway shape

### 1.1 System One models (Jev / Laya)

Laya ([github.com/NandhaKishorM/laya](https://github.com/NandhaKishorM/laya), [Hugging Face](https://huggingface.co/convaiinnovations/laya-typed-decisions), Apache-2.0) and TypeSafe's Jev ([introducing System One models and Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev); [docs](https://docs.typesafe.ai)) are **not** chat LLMs. Public contract facts that bind this design:

- **Typed decisions, not text generation.** Request: `state` + `questions` + `model`. Each question is `choice`, `score`, or `noul`. Response: typed `answers` (+ `usage`). No free-text generation, no fourth question type, no chat transcript out.
- **No chat surface on the protocol.** Official learnjev: *no chat endpoint, no system prompt, no streaming*. Top-level fields are `state` / `model` / `questions` only (no `temperature`, `max_tokens`, `system`).
- **Calibrated probabilities (class claim).** `choice` and `score` answers carry `confidence` (and per-label / per-level `probabilities`). **`noul` answers do not carry `confidence`** — gating uses the `noul` probability in `[0,1]` itself.
- **Cardinality.** Choice: up to **255** options on Jev; Laya specialist checkpoints often need tighter budgets (~20 unless head config changes). Score: 2–10 ordered levels.
- **Language.** English is the primary training language; CJK is weaker. Classifier/probe English criteria first.
- **Wire.** `POST /v1/systemone` with Bearer auth. Laya claims schema-identical answers and that clients can repoint `baseUrl`. Same wire ≠ same behavior (option budget, calibration, specialist training).
- **Failure codes (TypeSafe HTTP):** 401 / 422 / 429 / 529. Error body schema not fully published — treat unknown bodies as transport errors → fail-safe.

Any dsh-cc lane whose output is prose (titles, WebFetch summaries, TUS, agent turns, prompt-suggest) is **out of scope** for gauge.

### 1.2 orchestrix: multi-protocol gateway

**orchestrix** exposes **three protocol faces**, not one:

| Face | Typical consumers | Models |
|---|---|---|
| Anthropic-compatible | Agent turns, `ctx.llm.stream`, side-query | Chat LLMs (incl. cheap `haiku`) |
| OpenAI-compatible | Same class of chat completions | Chat LLMs |
| **System One** (`POST /v1/systemone`) | Typed decision callers | `llmbox_systemone/laya` (and Jev-class) |

**Implication:** integrating gauge is **protocol routing**, not "resolve another alias into the same chat stream." Former Branch A (hope the gateway compiles a chat prompt into System One) is **not** the product path. Day-0 work records the System One face's auth, URL, and answer shapes; it does not decide whether chat can fake them.

## 2. dsh-cc status quo (anchors, verified 2026-09-24 against `main`)

**Alias system** — `packages/compat/cc-model-aliases/src/resolver.ts`:

- `CC_ALIASES = ['fable','opus','sonnet','haiku']` (`:30`); `LANE_ALIASES = ['sketch','draft','blueprint','masterplan','architect']` (`:47`); `LANE_PEERS` (`:50-55`): `sketch→haiku`, …; `architect` inherits parent.
- **String-form alias targets are never split on `/`.** A string is a model id (`:229`, `:316`). `"gauge": "llmbox_systemone/laya"` would send that whole string as `model` on the **parent chat** provider — wrong protocol. Object form `{provider, model}` is required for any chat-map entry that names a gateway-prefixed id; System One routing still must not use `ctx.llm.stream` (see §4).
- `createModelResolver.resolveDetailed` can emit the once-per-process inherit warning; `createModelInspector` does not warn on builtin inherit (`:147-152` vs `:211-288`). `createModelInspector` / `mergeAliasMaps` are **already** exported from `packages/compat/cc-model-aliases/src/index.ts` (`:16`).

**Auto-mode classifier** — `packages/interaction/permission-rules/`:

- Route today: `host.settingsSection().autoMode?.classifier?.route ?? 'haiku'` (`pre-execute.ts:171-172`); probe: `…probe?.route ?? 'haiku'` (`:214-215`).
- Verdict JSON `allow|ask|deny`; deny without exact `hard_deny` rule string → ask (`llm-classifier.ts:309-317`). Escalate-only application in `decide.ts`.
- Chat assembly caps: `INPUT_CAP=4096`, `ASSEMBLED_CAP=8192`, `MAX_TOKENS=1024` (`llm-classifier.ts:126-138`) — relevant to the **haiku** path only after this revision.
- PI probe: separate prompt/windows/parser (`{"injection": bool}`); not classifier JSON.
- Settings: classifier + probe `route` default `'haiku'` in `settings-cascade` `auto-mode.ts` (`:101`, `:114`) and classifier mirror in `permission-rules` `settings-schema.ts` (`:128`).

**No runtime `systemone` / `llmbox_systemone` wiring exists on `main` today** — only this plan on the PR branch.

## 3. Fit analysis

| Site | Shape | Gauge? |
|---|---|---|
| Permission risk classifier | 3-way `choice` + confidence gate | **Yes — PR-B primary** (native) |
| PI probe | yes/no → `noul` + threshold on `noul` | **Yes — PR-C** |
| Classifier second pass (D13) | follows classifier route | Yes with classifier |
| Memory recall selector | N× `score` / staged choice | Future only |
| WebFetch / titles / TUS / side-query prose / agents (`explore`, …) | generative | **No** |

Unconfigured gauge must leave haiku/sketch behavior byte-identical.

## 4. Design

### 4.1 Protocol routing (non-negotiable)

```
resolve "gauge" config
        │
        ├─► System One client ── POST {baseUrl}/v1/systemone
        │         state + questions → answers
        │
        └─► NEVER ctx.llm.stream / Anthropic / OpenAI chat faces
```

Chat faces keep serving `haiku` and the construction ladder (`sketch`…`architect`). Gauge is a **decision lane** selected by policy helpers, not a drop-in `model:` for agent frontmatter.

### 4.2 The `gauge` lane alias (PR-A)

Add `gauge` as a builtin **lane** alias with peer `haiku` (unconfigured fallback for inspection / doctor / explicit "behave like cheap chat lane when unset"):

1. `LANE_ALIASES` += `'gauge'`; `LANE_PEERS.gauge = 'haiku'`; comment table row: *typed-decision / System One lane (not generative)*.
2. Tests: configured wins; unconfigured follows haiku peer; both unset → inherit; `$level` suffix stripping; inherit warning cases as today for genuine inherit via `resolveDetailed`.
3. `/doctor` models `LANES` hard-copy (`command-doctor/.../models.ts:38-43`) + READMEs + `docs/claude-code-capabilities.yaml` (then `pnpm docs:parity` / `pnpm check:readme --write`).

**Invariant (encode in README + capabilities deviation):**

- Do **not** set agent frontmatter `model: gauge`.
- Generative callers (`runSideQuery`, title providers, …) must continue to default to `haiku` / explicit chat aliases — never silently treat gauge as a chat model id.
- Configuring gauge means "System One backend available for decision consumers," not "all cheap lanes flip."

### 4.3 Settings surface

Enablement (object form only in `model-aliases`):

```jsonc
{
  "model-aliases": {
    "gauge": {
      "provider": "llmbox_systemone",
      "model": "laya",
      // recommended optional metadata (PR-B):
      // "protocol": "systemone",
      // "baseUrl": "https://<orchestrix-host>"  // if not implied by provider
    }
  },
  "permissions": {
    "autoMode": {
      "classifier": {
        "enabled": true
        // omit route → policy may select gauge when armed (PR-B);
        // pin "route": "haiku" to force chat classifier
      }
    }
  }
}
```

**String form `"gauge": "llmbox_systemone/laya"` is not supported** (alias strings are model ids; would hit the wrong protocol). Negative test documents that failure mode.

**Protocol metadata:** do not forever key off `provider.startsWith('llmbox_systemone')`. Prefer an explicit `protocol: "systemone"` (or equivalent capability bit) on the alias object; treat the `llmbox_systemone` provider name as **one** orchestrix deployment convention. Day-0 probe records the deployment's actual base URL and auth.

Behavior matrix (classifier, after PR-B):

| `classifier.route` | `gauge` alias | Effective path |
|---|---|---|
| set to chat alias | any | today's chat classifier (haiku/…) |
| set to `gauge` or System One route | resolvable | native System One |
| unset | configured + resolvable + consumer armed | native System One (see arming below) |
| unset | unconfigured | haiku chat path, zero new warnings |
| unset | configured but unresolvable | haiku + warn-once |

**Arming default:** prefer **opt-in** for the first ship (`classifier` uses gauge only when `route` is explicitly `gauge` **or** a dedicated `useGauge: true` / equivalent is set). Auto-prefer when alias exists may follow once Day-0 probe + dogfood are green. Document the chosen default in PR-B's body; do not silently raise production defaults.

### 4.4 Native System One client (PR-B)

New deep module (preferred name: `@dsh-cc/typed-decision`, or a focused adapter under permission-rules if package split is deferred):

Responsibilities:

- Build `POST /v1/systemone` requests (`state`, `model`, `questions`).
- Auth from env / settings (`apiKeyEnv`, Bearer).
- Parse `answers` into domain types; **do not** re-export raw wire types at classifier call sites.
- Map transport/validation errors to typed failure tags (`timeout` / `error` / `malformed` / HTTP class).
- **Never throw** to callers (match classifier posture).

Classifier adapter:

- `state`: compact structured rendering of the tool call (prefer JSON object state over a giant chat transcript). Bound size for gateway context (probe-adjusted; start from ~1–2k tokens of evidence, not 8k chat assemblies).
- One `choice` question `verdict` with `criteria: { allow, ask, deny }` — criteria prose derived from hard_deny / soft_deny / allow-exception **slots as criteria text**, not as a chat system prompt.
- Read `answers.verdict.choice`, `probabilities`, `confidence`.
- **Confidence gate:** if `confidence < threshold` (default **0.85**, settings-tunable) → treat as `ask`.
- **Deny citation:** if choice is `deny` but the adapter cannot attach an **exact** `hard_deny` rule string the existing checker accepts → downgrade to `ask` (same escalate-only law as today). Product sentence: **gauge accelerates allow vs ask; sticky deny remains the deterministic waterfall (and haiku path when pinned).**
- Breaker keyed by System One `provider/model` (isolated from haiku breaker).
- Audit events carry resolved protocol + model id.

**Explicitly deleted from the product path (former PR-B):**

- Compact chat profile / bare `allow|ask|deny` token parse / hoping chat normalization compiles prompts into questions.
- Using `isSystemOneRoute` solely to shrink chat prompts.

### 4.5 Route policy helper (PR-B)

Keep a `pickClassifierRouteName` (or richer `pickClassifierBackend`) that:

- Honors explicit `classifier.route`.
- Probes gauge via **inspector** (warning-free) for configured-ness.
- Warn-once on string-form pair misconfig and unresolvable gauge.
- Does **not** call `resolveDetailed('gauge')` merely to test inheritance (avoids spurious inherit warnings).

When the backend is System One, `pre-execute` invokes the typed-decision client — **not** `createClassifierStreamAdapter` / harness chat `llm`.

Schema: stop materializing default `'haiku'` for classifier `route` if policy needs absence-preserving "auto" (same seam analysis as before); probe default stays until PR-C. Delete dead `AutoModeSlice.route` write-only field if still unused.

### 4.6 Reporting

- `/auto-mode config`: show explicit route or `"auto"`; `routePolicy`; `gaugeRoute` / `gaugeProtocol` when armed.
- `/doctor`: show `gauge → haiku` peer row plus note that gauge is System One decision-only.

### 4.7 PI probe (PR-C)

- Map suspicion to a `noul` question (single testable proposition).
- Gate with `noul >= threshold` (configurable); **do not** look for `confidence` on noul.
- Compact HEAD/TAIL evidence in `state`; fail-safe to today's ask/allow policy on errors.
- Schema: absence-preserving or policy switch for `probe.route` analogous to classifier.

## 5. Delivery plan

| PR | Scope | Merge gate |
|---|---|---|
| **PR-A** | §4.2 alias + doctor + docs/parity | mechanical tests green |
| **PR-B** | §4.3–4.6 native client + classifier adapter + policy; **default off / explicit arming** | Day-0 probe transcript in PR body; unit + listener specs; never-throws |
| **PR-C** | §4.7 PI `noul`; optional confidence telemetry polish | separate plan if large |

Chat-normalization experiments are **out of scope** unless a future RFC reopens them with evidence; they must not block or redefine PR-B.

## 6. Day-0 gateway probe (System One face)

Run against real orchestrix **System One** URL (not the Anthropic/OpenAI faces):

1. Configure object-form gauge (+ auth env). Confirm requests hit `/v1/systemone` (debug/log).
2. POST canonical cases: benign allow-shaped tool calls; ask-shaped (`curl` POST); deny-shaped (`rm -rf ~`); injection-shaped payload for a parallel `noul`.
3. Record: HTTP status, answer JSON (choice + probabilities + confidence; noul value), latency, `usage`, truncation/422 behavior on oversized state.
4. **Criteria fidelity:** edit one hard_deny criterion string; confirm choice distribution moves (or document if gateway ignores criteria — then stop auto-arming).
5. Paste full transcript into PR-B Verification. **No Branch A/B chat decision.**

## 7. Verification plan

**PR-A:** model-aliases + command-doctor tests; README/parity gates.

**PR-B:**

- typed-decision client: happy path, 401/422/429/529 mapping, timeout, schema mismatch → failure tags.
- classifier adapter: choice parsing; confidence→ask; deny without exact rule→ask; breaker isolation from haiku; arming matrix; string-form negative config test.
- Integration listener: gauge-armed stub System One → allow applied + audit shows System One model; disarmed → haiku path unchanged.
- Repo gates: typecheck, affected vitest, capabilities/parity/readme as touched, `check-spec-deps`, file-size, smoke profile-boot if settings mirrors edited.

**PR-C:** pi-probe specs with noul threshold; no confidence field assumed.

## 8. Risks and open questions

- **Wrong-protocol footgun:** resolving gauge into chat stream — mitigated by client boundary + invariant docs + tests that fail if stream adapter is used for gauge.
- **Deny fidelity:** gauge cannot invent exact rule strings; sticky deny stays deterministic — product-clear.
- **Calibration:** class claim is population-calibrated; still gate on confidence / noul with dogfood thresholds.
- **Laya vs Jev option budgets** and English-primary accuracy on CJK tool args — probe + eval set language mix.
- **Cost metering** for `llmbox_systemone/*` may be zero until priced — follow-up.
- **Open:** exact orchestrix base path and auth header names (fill from Day-0); whether alias schema gains first-class `protocol` in PR-B or a parallel settings ns.

## 9. Appendix: edit checklist

**PR-A:** `resolver.ts` lanes/peers; `resolver.spec.ts`; `command-doctor` `LANES`; READMEs + parity; capabilities yaml.

**PR-B:** new typed-decision module; `route-policy` / classifier wiring in `pre-execute.ts`; settings absence-preserving classifier route + docs; `/auto-mode config` fields; tests listed in §7; **no** chat compact profile module.

**PR-C:** probe schema + `pi-probe` native noul + specs.

## 10. Changelog vs previous plan revision

- Trunk flipped from chat-normalized classifier (former PR-B) to **native `/v1/systemone`**.
- Documented orchestrix as **multi-protocol** (Anthropic + OpenAI + System One).
- Removed Branch A/B chat gate as the delivery hinge; Day-0 = System One face recon.
- Recorded `noul` has no `confidence`; choice/score confidence gating first-class.
- gauge = decision lane invariant (no generative `model: gauge`).
- Prefer explicit arming / default-off for first classifier ship.
- Protocol detection via metadata, not only `llmbox_systemone` string prefix.
