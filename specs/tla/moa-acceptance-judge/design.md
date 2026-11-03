# Design: moa-acceptance-judge (SystemOne S1-10 judge-loop placeholder guard)

Model directory: `specs/tla/moa-acceptance-judge`. Module `Model`,
spec `Spec`, safety-only.

## Formal design screening

- mode: **auto** (session-scoped; the project rules carry no formal-design
  screening clause at this revision — user request 2026-11-02; adoption
  snippet at `<skill>/references/agents-snippet.md`).
- decision: **enabled**
- triggerIds: FD-T1 (the inFlight WeakMap placeholder and the completed LRU
  are per-Agent shared state across repeated stops and mode switches),
  FD-T2 (a cancelled request settles late and its `finally` races a newer
  placeholder; a repeated stop must not issue a second request).
- backends: `["tla"]`, modelDirs: `{"tla": "specs/tla/moa-acceptance-judge"}`.
- **Deviation from the screening table** (recorded): the plan said "extend
  moa-cascade-routing". The existing model assigns all 16 variables
  explicitly in every action; wiring the S1-10 placeholder guard into it
  would be a ~75-point mechanical rewrite of a verified model. Per the
  extend-vs-new criterion, the WeakMap placeholder/token guard is a **new
  state machine** layered over the escalation flow (which stays modeled by
  `moa-cascade-routing`), so it got its own model. The escalation ladder
  itself is out of scope here by construction.
- behavioral source: `docs/plans/2026-11-02-systemone-10-moa-acceptance.md`
  — the lifecycle paragraph (WeakMap<Agent,{token,key}>; the completed LRU
  holds at most 16 entries; a repeated stop hitting inFlight/completed
  issues zero requests; the `finally` block deletes the placeholder only
  when the map's token equals its own token; dispose/mode-switch cancel
  but the old finally must not clear a later placeholder; dimensions
  shadow disables the same round's legacy judge) and the modes table
  (a tool-using turn is observe-only in every mode).

## Requirements

- **REQ-1** A stop is judged at most once: one network request per stop;
  a repeated stop hitting inFlight or completed issues zero requests.
- **REQ-2** Completed is marked whether answered or unavailable, so the
  same stop never self-retries.
- **REQ-3** The `finally` deletes the placeholder only when the settling
  token equals the placeholder's own token.
- **REQ-4** A mode switch cancels the old request, and a new placeholder
  starts only after the old one settles.
- **REQ-5** A tool-using turn is observe-only in every mode — recorded,
  never escalated, and escalated at most once per stop.

## State variables

| Variable | Meaning |
|---|---|
| `stop` | the current stop's key (0 = none) |
| `pTok`, `pStop` | the in-flight placeholder (token, owning stop key) |
| `completed` | stop keys that reached a terminal state (the LRU's presence bit) |
| `reqCount`, `followCount` | per-stop request and escalation history |
| `toolTurn` | the current stop executed tools |
| `cancelled` | the in-flight request was cancelled (mode switch/dispose) |
| `dimsShadow` | the dimensions-shadow precedence is active |
| `faults` | probe-injected fault witnesses |

## Coverage matrix

| Invariant | Requirement | Adverse trace challenged |
|---|---|---|
| `OneRequestPerStop` | REQ-1 | `RedispatchCompleted` probe: a completed stop re-judged |
| `CompletedStaysSettled` | REQ-2 | a placeholder still owning a completed key |
| `NoStaleFinallyDelete` | REQ-3 | `WrongTokenFinally` probe: a mismatched token deletes the placeholder |
| `NoRacedPlaceholder` | REQ-4 | `ModeSwitchRaces` probe: a new placeholder before the cancelled one settles |
| `ToolTurnNeverActed` | REQ-5 | `ToolTurnEscalates` probe |
| `NoFaults` | all | union of all fault witnesses |

State-space notes (from checking): the dimensions-shadow precedence (the
same round's legacy judge is disabled) is already covered by
`moa-cascade-routing`'s `ShadowInert` invariant, so this model drops its
own shadow variable; escalation is bounded to once per stop (the design's
"escalate to the next distinct tier only once"), which also bounds
`followCount`. The mode-switch cancel is asynchronous — the old
placeholder stays in flight until its own late settlement, and a new
generation may start only after that settlement (`JudgeDispatch` requires
`pTok = 0`).

## Bounds and assumptions

- Two stop keys, four tokens — enough for a repeated stop, a mode-switch
  race and a stale finally.
- The WeakMap per-Agent dimension and the LRU's 16-entry cap collapse to
  presence bits; the key formula (sessionId+originSeq+turn+finalAnswerSeq
  +answerHash+settings hash+routeRevision) is modeled as the stop key.
- Answer quality (the three noul dimensions, thresholds, reasons order)
  is out of scope: the settlement is one action regardless of verdict.
- The escalation ladder, floor/count recovery and `isStale`/`isEscalatable`
  re-checks stay in `moa-cascade-routing`'s domain; only the placeholder
  guard is modeled here.
