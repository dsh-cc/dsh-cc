# Persistent-write auditing: memory & learned-skill content lint at the write chokepoints (design)

- Date: 2026-10-09
- Status: draft v3 — internal critic GO after 3 rounds; user sign-off pending. NOT yet implemented.
- Scope: internal changes to `packages/memory/memory` (save/writeback), `packages/memory/memory-consolidation` (dream writer), `packages/skill/skill-claude-code` (learned store), `packages/session/command-learn` (apply/promote call sites passing audit context). New typed session events + one JSONL ledger. Default: lint ON (warn-tag only), model audit OFF, block OFF.
- Sources: TokenWall (every natural-language token stream crossing a privilege boundary is attack surface; layered audit pipeline), Compositional-Harm boundary (local monitors are blind unless they sit at the layer where harm assembles — here: the write chokepoints), plus the dsh-cc-internal fact that memory topic files and learned skills are **re-injected into every future session** — a poisoned one is a persistent injection channel.

## 1. Problem

dsh-cc audits *tool calls* (gauge/permission rules) but not *durable writes to
its own prompt supply*. Two write surfaces feed text that rides future system
prompts:

1. **Memory** — `memory_save` (model-written), `/learn apply` (transcript-mined),
   and dream consolidation (fully unsupervised, runs at pressure/cadence). All
   three converge on a single chokepoint:
   `writeMemoryFiles(fs, dir, writes, auditCtx?)`
   (`packages/memory/memory/src/writeback.ts:167` — it already receives `fs`
   and `dir`; all three callers pass through it), called from `save.ts:215/239`,
   `packages/session/command-learn/src/write.ts:70`, and
   `packages/memory/memory-consolidation/src/memory-job.ts:149-150`. Here `fs`
   is the `@deepseek-ai/dsh-fs` FileSystem wrapper (policy applied per call),
   not `node:fs` — so a trailing optional param is safe. Scope carve-out:
   fixed-format machine dotfiles are explicitly excluded from the
   "single chokepoint" claim — pressure/lock marker files, the diagnostics
   `.dream-last-error.json` (bypasses `writeMemoryFiles` at
   `memory/diagnostics.ts:13`), and `title.txt` sidecar writes are structured
   machine output, not model-authored prose.
2. **Learned skills** — `manage_skill` and `/learn promote=` converge on
   `LearnedSkillStore.create/update`
   (`packages/skill/skill-claude-code/src/learned-store.ts:126/169`).

A hostile or drifting writer (dream run over poisoned transcripts; a model
skill-write carrying imperative instructions) persists text that the recall
injector (`recall.ts:378-381`) and the skills catalog then feed forward.
TokenWall's framing: the privileged sink here is not a tool call but the future
prompt. Today nothing inspects the content at either chokepoint.

Probe note: the chokepoints are real single points (verified 2026-10-09; no
bypassing content writers found), which is what makes this cheap: two wrapper
seams cover every prose writer.

## 2. Goals and non-goals

Goals:

1. **W1 — deterministic content lint, always-on, warn-tag.** A small fixed
   rule set scans content at both chokepoints; hits are tagged (frontmatter
   marker + session event + ledger row), never silently.
2. **W2 — provenance-aware posture.** The audit context (which writer) rides
   the call: `memory_save` / `learn-apply` / `dream` / `manage_skill` /
   `learn-promote`; dream-origin content is the strictest tier by default.
3. **W3 — optional model audit (off).** For dream-origin writes and flagged
   lint hits, an opt-in second opinion via the side-query lane
   (`runSideQuery`, `packages/llm-tuning/side-query/src/index.ts:80`), with the
   A11-style discipline that its precision must be dogfooded before any block
   list depends on it.

Non-goals:

- **Never silently drop content.** v1 never blocks a write. Blocking is a §7
  follow-up gated on lint precision data.
- No audit of *reads* (catalog/recall injection time). Follow-up §7 — the
  write-side tag already feeds any future load-side policy.
- No scrubbing/rewriting of memory content (transcript-secrets owns secret
  redaction; this design *flags*, it does not edit).
- Not a general prompt-injection shield for transient context — durable writes
  only.

## 3. Design

### 3.1 The seam

**Memory seam — `writeMemoryFiles(fs, dir, writes, auditCtx?)` ONLY**
(`writeback.ts:167`). It already receives `fs` and `dir`; all three callers
pass through it. `validateMemoryWrites` is NOT part of the seam: its signature
is `(input: unknown, opts?)` (`writeback.ts:99-102`), and `save.ts:222`
already passes `{allowOverLimitEntrypoint}` — a positional `auditCtx` there
would collide. The `fs` argument is the `@deepseek-ai/dsh-fs` FileSystem
wrapper (policy-per-call), not `node:fs`, so a trailing optional param is
safe.

**MEMORY.md policy:** `save.ts` always writes the index alongside topics
(`save.ts:217-219`) and it has no frontmatter — lint its CONTENT (event +
ledger row on a hit) but NEVER tag it: no frontmatter injection into the
index (the index parser's tolerance for injected frontmatter is unverified,
stated as such).

**Skill seam:** one optional options field on `LearnedSkillStoreOptions` —

```
audit?: { origin, agent?, linter? }
```

**Dependency (explicit decision):** the linter lives in
`packages/memory/memory/src/write-audit.ts` and is injected via
`LearnedSkillStoreOptions.audit.linter` — but tool-manage-skill does not
depend on `@dsh-cc/memory` today. Decision: add
`"@dsh-cc/memory": "workspace:^"` to
`packages/core/tool-manage-skill/package.json` dependencies. The
"keeping package boundaries" claim is **deleted** — constructor injection
moves the dependency to the composer site; the leaf-package alternative was
rejected as heavier for ~50 lines of regex; command-learn already depends on
`@dsh-cc/memory`, so only tool-manage-skill gains a dep. **Checklist:** the
new cross-package dep must land BEFORE `pnpm install --frozen-lockfile`
(lockfile timing lesson); cycle-check: assert `@dsh-cc/memory` does not
depend on tool-manage-skill (grep its package.json; report the result).

Both composer sites construct the store locally
(`tool-manage-skill/src/index.ts:76-85`,
`command-learn/src/index.ts:179-188`), so this is zero interface churn —
no shared new package (a shared-new-package alternative was considered and
rejected). Callers thread it:

- `save.ts:189-259` handler → `{ origin:'memory-save', agent: exec.agent }`.
- `command-learn/src/write.ts:70` → `{ origin:'learn-apply', agent: /* from exec if present */ }`.
- `memory-job.ts:149-150` → `{ origin:'dream', agent: /* the dream child agent */ }`.
- `manage_skill` via `tool-manage-skill/src/index.ts:76-85` → `{ origin:'skill-manage', agent: exec.agent }`.
- `/learn promote=` (`command-learn/src/index.ts:179-188`) → `{ origin:'skill-promote', … }`.

Adding an optional trailing parameter keeps all existing signatures compatible.

### 3.2 W1 — the lint rules (fixed set, data-not-code)

`lint.json` in a shared new module `packages/memory/memory/src/write-audit.ts`
(exported for reuse; the skill store receives the linter via the
`audit.linter` options field (§3.1) — see the §3.1 dependency decision:
constructor injection moves the dependency to the composer site):

| rule id | match (case-insensitive, on full content) | severity |
|---|---|---|
| `role-marker` | `<\/?system>|<\/?assistant>|\[SYSTEM\]` | high |
| `imperative-override` | `ignore (all\|any\|previous) instructions?|from now on|you must always|do not ask` | high |
| `tool-schema-shape` | `"(name\|input_schema\|parameters)"\s*:` within a code fence | medium |
| `hook-config-shape` | `"(preToolUse\|postToolUse\|hooks)"\s*:` | medium |
| `external-fetch-instruction` | an imperative and a fetch-imperative `(curl\|wget\|fetch)\s+http` **within the SAME line** | high |

Initial set deliberately small; precision over recall; tuning data comes from
the ledger (§3.4) before any rule is added.

On a hit: (a) the `x-write-audit: "flagged:<rule-id>@<ts>"` frontmatter key is
**UPSERTED** — an existing `x-write-audit` value is replaced, never appended
as a duplicate key. Tag placement: memory topic files get the frontmatter key
prepended (memory topic files carry frontmatter; unknown keys are inert by
convention); skill files get the key inserted into the parsed frontmatter
`data` **before** serialize/stringify (create: inside `serializeLearnedSkill`,
`learned-store.ts:63-69`; update: before `:197`), keeping the YAML round-trip
clean; (b) a session event is appended when `auditCtx.agent` is reachable
(§3.4); (c) one ledger row (§3.4). The write itself proceeds — warn-tag only.

**Recall interplay (required edit):** `recall` injects the RAW full file text
at `recall.ts:371-373` — frontmatter included, `x-write-audit` tag and all
(the earlier ":349/:373 parse site" reading was mislocated). The strip of the
`x-write-audit` key applies to the raw text at that injection point (or
inside `parseMemoryTopic`), so the tag never re-enters prompts.

### 3.3 W2 — posture by origin

| origin | v1 posture |
|---|---|
| memory-save, skill-manage | lint; tag on hit |
| learn-apply, skill-promote | lint; tag on hit (these are human-reviewed flows already) |
| dream | lint; tag on hit; AND if `write-audit.modelAudit` is on, queued for W2 model audit (§3.5) |

Rationale: dream is the only fully unsupervised writer — it gets the deepest
optional inspection; human-adjacent flows stay cheap.

### 3.4 Events + ledger

- Session events when agent reachable: `session.append('write-audit/flag',
  { v:1, origin, target:fileName, rule, ts })` (module augmentation pattern:
  `packages/hooks/hook-protocol/src/types.ts:8-9`).
- Ledger always (even without a session):
  `<dshHome>/write-audit/flags-<projectKey>.jsonl`, one row per flag,
  detached `void appendFile().catch(debugLog)`, projectKey convention
  (`sha256(cwd)[:16]`). **Required:** `mkdir(dir, {recursive: true})` at
  first use before the first `appendFile` — node `appendFile` does not
  create parent dirs, and without it the whole dogfood dataset silently
  vanishes.

### 3.5 W3 — model audit (opt-in, off)

When `write-audit.modelAudit` is on, dream-origin content (and lint `high`
hits of any origin) get one side-query (`runSideQuery`, default alias `haiku`
— `:69`) with a verdict question `safe|suspicious` + one-line reason; an answer
of `suspicious` adds `x-write-audit-model: suspicious:<ts>` and a ledger row.
Never blocks. Budget: one call per write, hard timeout via side-query options;
failures degrade to no-op (fail-open — measurement, not gate).

### 3.6 Configuration

Kebab namespace (`registerNamespaceSafe` precedent,
`packages/interaction/advisor-watchdog/src/settings.ts:6`):

- `write-audit.enabled` — default `true` (lint only).
- `write-audit.modelAudit` — default `false`.
- `write-audit.lintScale` — reserved, not implemented in v1 (state absent).

### 3.7 Failure discipline

Lint is pure-regex over already-in-memory content — no I/O added to the write
path beyond the ledger's detached append. Any lint/model-audit error ⇒ write
proceeds untagged + debug log. The chokepoints' existing failure modes (cap
rejection etc.) are unchanged.

## 4. Edge cases

- Writes during subagent sessions (dream children): `auditCtx.agent` is the
  dream child; session events land in the child session's transcript; ledger is
  project-keyed so the rollup is still per-workspace.
- Frontmatter-parse-tolerant: if a topic file lacks frontmatter (legacy), the
  tag is prepended as a new frontmatter block; SKILL.md files always have
  frontmatter (name grammar enforced at learned-store.ts:25,28,127,170).
- Legit false positive class: memory topics *about* hooks or schemas (e.g. this
  very write-up as a memory) — accepted; tags are reviewable, content never
  blocked, and the dogfood rollup measures rule-hit rates before any escalation.
- Replay storms: none — a re-write UPSERTs the `x-write-audit` key (ts
  refreshes, no duplicate keys).

## 5. Verification plan

1. Unit: each lint rule with true/false fixture texts (including CJK content —
   NFKC normalization precedent from advisor's fingerprint collapse lesson).
2. Unit: tag placement into files with and without frontmatter (upsert —
   no duplicate key); write proceeds on lint throw (fault-injected);
   recall strips `x-write-audit` from the RAW text injected at
   `recall.ts:371-373` (tag never re-enters prompts).
3. Unit: origin threading — each of the five call sites passes its origin
   (asserted via store spy in package tests).
4. Integration (testkit): memory_save with a `role-marker` payload ⇒ file
   written AND tagged AND `write-audit/flag` event present in the session
   events snapshot.
5. Model-audit path: mocked side-query returns suspicious ⇒ model tag present;
   side-query failure ⇒ write unaffected.
6. Gates: `pnpm check:capabilities` (evidence rows on existing memory/skill
   surfaces — no new surface), `docs:parity`, `check:file-size`,
   `check-spec-deps` for spec imports.

Dogfood: run lint-only for two weeks on the dsh-cc workspace; review =
rule-hit count by rule, manual read of every flagged file (expected low
volume). Expected false-positive classes on this dev workspace: hook JSON /
tool-schema quotes inside memory content are routine — accepted, measured,
never blocking. Blocking-gate (softened): **per-rule precision measured from
the ledger** — blocking-tier entry is decided PER RULE: a rule enters the
blocking tier only if its OWN ledger precision is clean; no cross-rule
zero-false-positive requirement.

## 6. Why this shape and not a gateway

The privilege boundary in dsh-cc is not a network hop — it is *durable
re-injection*. The two chokepoints are single functions, so the cheapest correct
layer is in-process at the write, exactly where the harm assembles
(Compositional-Harm's "arrive at the assembling representation layer"). A
model-in-the-middle gateway in front of recall/catalog would cost a model call
per session for the same observable.

## 7. Follow-ups

1. Blocking tier: dream writes that hit `high` rules get held for review
   (`write-audit.blockDreamOnHigh`, default false) after the §5 per-rule
   precision gate passes — decided per rule, not globally.
2. Load-side policy: recall/catalog skip `x-write-audit`-flagged entries unless
   reviewed — consumes the v1 tags; needs its own precision evidence.
3. Marketplace skill install-time audit (read surface), joined with D5's
   portability lint note.
4. Rule-set versioning + telemetry-driven tuning (A11 discipline: any new rule
   ships with hit-rate baselines from the ledger).

## 8. Review ledger

- Round 1 (2026-10-09, internal critic): verdict **GO-WITH-AMENDMENTS**;
  chokepoint premise **VERIFIED** (no bypassing content writers found); all
  findings **adopted**:
  - Seam corrected: lint lives in `writeMemoryFiles` only
    (`writeback.ts:167`); `validateMemoryWrites` removed from the seam
    (signature/`allowOverLimitEntrypoint` collision).
  - MEMORY.md: content lint + event/ledger only, never tagged (index parser
    frontmatter tolerance remains **unverified** — hence the no-tag policy).
  - Idempotency: `x-write-audit` tagging is an upsert, never a duplicate
    key; skill path inserts into frontmatter `data` before serialize.
  - Skill-store injection: one `audit?: {origin, agent?, linter?}` options
    field, zero interface churn; shared-new-package alternative removed.
  - Scope carve-out: fixed-format machine dotfiles (pressure/lock markers,
    `.dream-last-error.json`, `title.txt`) excluded from the chokepoint claim.
  - Ledger: `mkdir(recursive)` before first append (otherwise dataset
    silently vanishes).
  - Rule tightening: `external-fetch-instruction` = fetch-imperative within
    the SAME line; per-rule precision replaces the global
    zero-false-positive gate (hook-JSON/tool-schema quotes accepted as
    routine dev-workspace false positives).
  - Recall: strips `x-write-audit` on parse so the tag never re-enters
    prompts.
  - Status: draft v2; round-2 confirm pending; user sign-off pending.
- Round 2 (2026-10-09, internal critic): verdict **GO-WITH-AMENDMENTS**;
  chokepoint premise **re-VERIFIED**; 1 major dep fix + 2 minors folded:
  - MAJOR dependency fix: explicit decision added (§3.1) — add
    `"@dsh-cc/memory": "workspace:^"` to tool-manage-skill deps; "keeping
    package boundaries" claim deleted (constructor injection moves the dep to
    the composer site; leaf-package alternative rejected as heavier for ~50
    lines of regex; command-learn already depends on `@dsh-cc/memory`).
    Checklist: dep lands BEFORE `pnpm install --frozen-lockfile`. Cycle
    risk checked: grep of `packages/memory/memory/package.json` shows NO
    `tool-manage-skill` dependency (no cycle).
  - MINOR: §4 idempotency bullet corrected — re-write UPSERTs the key (ts
    refreshes, no duplicate keys).
  - MINOR: §3.2 recall strip site corrected — recall injects the RAW full
    file text at `recall.ts:371-373` (frontmatter included); strip applies
    there (or inside `parseMemoryTopic`); §5.2 verification names the
    raw-injection point explicitly.
  - Status: draft v3 — internal critic GO-WITH-AMENDMENTS round 2 fully
    folded; final confirm pending; user sign-off pending.
