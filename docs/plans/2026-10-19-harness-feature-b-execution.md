# Feature B: isolated execution and the dsh substrate adapter

- Status: proposed.
- Parent: [Harness experiments](2026-10-19-harness-experiments.md).
- Package: `packages/evaluation/harness-runner` (`@dsh-cc/harness-runner`, private).
- Depends on: [A](2026-10-19-harness-feature-a-contracts.md).

## 1. Problem and solution

Re-running a task in the current workspace can reuse a previous answer, mutate user files, send an external request twice, or read evaluator labels. A worktree alone does not isolate process execution, home-directory memory, networking, or credentials.

Run every sample in a fresh Linux OCI container from a pinned image. Use a controller outside the container for credentials, model transport, budgets, immutable storage, and evaluation. Supply a small dsh launcher contract and a substrate adapter. Do not add another LLM SDK or import Python Harness² into the runtime.

## 2. Ownership and public interface

```ts
interface Runner {
  preflight(plan: ExecutionPlan): Promise<PreflightReport>;
  execute(run: Run, signal: AbortSignal): Promise<ExecutionResult>;
  inspect(runId: string): Promise<ExecutionResult | undefined>;
}
interface ExecutionResult {
  schemaVersion: 1; runId: string; attemptId: string;
  executionKey: Digest;
  status: 'completed' | 'failed' | 'cancelled' | 'interrupted';
  stopReason: string;
  artifacts: FileRef[]; trajectory: Digest; diagnostics: Digest;
  usage: UsageEntry[]; wallMs: number;
  assurance: 'enforced' | 'unverified';
  isolationAttestation: Digest;
}
interface UsageEntry {
  callId: string; role: 'solver' | 'proposer' | 'selector' | 'reviewer';
  inputTokens: number | null; outputTokens: number | null;
  costMicroUsd: number | null;
  accounting: 'provider' | 'reserved-upper-bound' | 'unknown';
}
```

`ExecutionPlan` is A's immutable `plan` blob: `{schemaVersion:1, suiteDigest, repetitions, runOrderSeed, imageDigest, resources, networkProfile, brokerConfigDigest, maxExecutionAttempts:2}`. `resources` contains safe positive integers `memoryMiB`, `cpusMilli`, `pids`, `workspaceMiB`, and `timeoutMs`; defaults are 4096, 2000, 256, 1024, and 600000. Bounds are respectively 256–65536, 100–16000, 32–1024, 64–16384, and 1000–3600000. Suite digest includes all task records in sorted taskId order. Repetition count is 1–10; confirmation requires at least 3 under C.

The runner imports A's validated types and store. The dsh launcher uses the existing host Session/Agent and prepared LLM APIs through a dedicated harness entry point described below. Core runner logic receives a `Launcher` dependency; tests use a fake launcher. Production cannot replace it with an unversioned shell command.

## 3. Required dsh launcher seam

Add a private launcher module in the runner package with these exported operations:

- `describe(request)`: build a fresh experiment-only dsh context, resolve all configuration, load only the supplied profile, prepare model routes, and return A's effective snapshot descriptors. It does not dispatch a model request.
- `run(request, emit, signal)`: use the frozen context from `describe`, execute one supplied task prompt, emit normalized events, await all child work, flush outputs, and return the final stop reason.

The concrete implementation MUST instantiate the installed harness's public session/agent composition entry points. Before coding this adapter, add a compatibility test against the dsh version pinned in presubmit. This test MUST prove: explicit home/profile selection; disabled ambient instructions, memory and plugin discovery; inherited tool/child isolation; captured effective prompts and model options; cancellation; awaited disposal. If any of these controls is not available through public APIs, add the minimum upstream dsh seam first and pin its verified version. Do not emulate isolation with a prompt or quietly use an unrestricted CLI. The B implementation is blocked until this compatibility test passes; no guessed host function name is part of the contract.

Expose the module as a private executable `dsh-harness-runner` reading exactly one request JSON file and writing JSONL events to stdout. Pass argv as an array, never through a shell. Request fields are `{schemaVersion:1, runId, attemptId, taskDigest, snapshotDigest, promptPath, inputRoot, outputRoot, profilePath, brokerSocket}`; all paths are controller-assigned container paths. It has no API key or arbitrary command field. Final event is `run-ended`; absence of that event is not completion.

No session resume, workflow prefix replay, user skill auto-discovery, global MCP connection, consolidation, or automatic learning is enabled. A declared subagent may run inside the same container and budget; it inherits all restrictions and emits a child relation. Uncaptured delegation fails the run with `EXECUTION_FAILED` detail `UNTRACKED_CHILD`.

## 4. Container and network contract

Use rootless Podman on Linux. Other runtimes and native execution are unsupported in v1. `preflight` checks the Podman version, rootless mode, pinned local image digest, effective seccomp and resource limits, and broker reachability. It then starts a canary that attempts forbidden host and network access. If the canary can reach them, return `ISOLATION_UNAVAILABLE` without any paid call.

Container settings are: nonroot UID, read-only root filesystem, all capabilities dropped, `no-new-privileges`, default seccomp, no host PID/IPC namespace, no container engine socket, bounded tmpfs for `/tmp` and `/work`, and explicit CPU/memory/PID limits. Mount immutable task files at `/input`, selected harness files at `/harness`, and a fresh empty directory at `/output`. Input mounts are read-only and exclude the repository `.git`, evaluator, store, host home, and previous samples. Create `/home/agent` anew in tmpfs. Only copy the declared task inputs; do not mount the whole repository for convenience. `TZ`, locale and controlled PATH are set by the image.

Use `--network=none`. The only outbound channel is a mounted Unix-domain model-broker socket at `/run/model-broker.sock`. The broker accepts one configured provider protocol from the pinned launcher, validates an experiment/attempt-scoped bearer capability, enforces the frozen route and per-call limits, and forwards through the existing host prepared model service. The capability is an ephemeral socket credential, not a provider credential; never save it in artifacts. It cannot request arbitrary URLs, change models, or read files. Broker requests carry `callId`, role, serialized messages/tool definitions, and maximum output tokens. They MUST match the snapshot's route/tool descriptors and the controller's budget reservation. All children use the same broker. The broker never exposes sealed evaluation data.

Default profile is `offline-text`: no web, shell-network, remote MCP, or provider-native browsing. Shell and generated helper scripts may operate within the container. Tasks requiring external web access are unsupported in v1 and fail preflight; a future network profile requires a separate versioned design. This explicit limitation keeps public benchmark answer leakage out of the first pilot.

The isolation attestation records image and runtime digests, options, mounted manifest digests, network profile, canary outcomes, and launcher protocol. Only successful enforcement is `assurance: enforced`. Diagnostic runs marked `unverified` cannot enter C's adoption decision or E's validated experience.

## 5. Scheduling, retry, and cancellation

Create one logical Run for each `(variant, task, repetition)`. Derive a stable scheduling order by sorting taskId, repetition, and variantId, then shuffling with a SHA-256 counter stream seeded by `runOrderSeed`. Scheduling order does not imply deterministic model output. Seed is null when unsupported and MUST be reported as such. Each variant receives the same supported seed for a task/repetition pair.

A run has at most two attempts. Retry only a broker-confirmed pre-dispatch transport failure or container-start failure after confirming no model call and no task execution began. A model/tool failure, invalid output, timeout after dispatch, or unknown dispatch status is not automatically retried. It produces a failed or interrupted sample and remains in C's denominator. An operator may start a new experiment; they cannot replace the failed sample in place.

On cancellation or timeout: stop accepting broker calls, signal abort, allow five seconds for disposal, kill the container, await exit, collect usage, seal the attempt, and remove staging mounts. A controller crash leaves the attempt `interrupted`; recovery queries broker call records, terminates any orphaned container by its attempt label, and settles its outstanding reservations. It MUST NOT automatically resend a possibly dispatched call.

A completed sample is reusable only within the same experiment and the exact executionKey, with verified output blobs, all child sessions settled, known accounting, and enforced isolation. Reuse is resume, not an independent observation. Cross-experiment execution caching is disabled in v1. An interrupted attempt is never a cache hit.

## 6. Artifacts and trajectories

Normalize events into `{schemaVersion:1, seq, runId, attemptId, kind, sessionId, parentSessionId?, data}` with kinds `run-started`, `model-call`, `model-result`, `tool-call`, `tool-result`, `child-started`, `child-ended`, `artifact`, `error`, and `run-ended`. Tool arguments/results remain separate from instructions. Do not persist hidden reasoning streams; public tool actions, observations, and final text are sufficient. Provider usage and broker call IDs are captured independently of stdout.

After exit, collect only declared `outputPaths`. Reject symlinks and special files again on collection. Limits: 10 MiB per text artifact, 100 MiB total, 10,000 files. A missing required output is `OUTPUT_INVALID`, not an empty success. Preserve original bytes in the controller store. Screenshots or PDF assets require an explicit task adapter; v1 VWA accepts UTF-8 Markdown only. Persist stdout/stderr as bounded diagnostics, with a truncation marker after 10 MiB; truncation never changes artifact bytes or scoring input. If the full normalized trajectory exceeds 100 MiB, fail `LIMIT_EXCEEDED`; do not silently judge a partial trajectory.

Reports expose digests and relative paths by default. Explicit raw export may include task text; warn in the command help that source content and outputs are retained locally. Broker credentials are removed before diagnostics persistence. A failed redaction check fails export, not execution accounting.

## 7. Harness² bridge

Ship `bridges/harness2/dsh_substrate.py`, a README, and fixture protocol tests in the runner package. Pin the exact reference revision in the parent design. The bridge implements upstream `surface`, `materialise`, `execute`, `read_trajectory`, and `preflight` by calling the versioned private executable, mapping `Install.fingerprint` to A's snapshot digest, and rendering events as `[ACTION]`, `[OBSERVATION]`, and `[ERROR]`. Its editable surface maps prompt/guidance/memory/skills/agent definitions/helpers to the allowlist in D. Unsupported plugin and guardrail edits are rejected, not ignored.

The bridge is an interoperability research adapter, not a second adoption engine. Upstream selection and library state MUST NOT write E's validated records or apply patches. Results obtained under upstream selection conventions are labeled `external-research` and need a fresh C confirmation before promotion. Upstream `execute` returning a run directory does not imply a successful result; verify `result.json` and required outputs. Changed upstream interfaces fail preflight with an actionable pinned-revision message.

## 8. Acceptance and TDD sequence

| Test | Required result |
| --- | --- |
| Fake launcher streams output and settles a child | Ordered complete trajectory and attributed usage |
| Public host composition lacks a required isolation control | Compatibility test fails; no CLI fallback |
| Host home secret, sibling workspace, previous output, evaluator file | Container cannot read any of them |
| TCP/DNS request or provider-native web tool | Denied; model broker still works |
| Child changes route or exceeds tool policy | Broker rejects before dispatch |
| Generated script creates symlink at output path | Collection fails; host file is not copied |
| Cancel with child running; controller crash after dispatch | Child/container terminate; usage preserved; no resend |
| Successful result resumed versus repetition incremented | First reused; second executes independently |
| Unknown dispatch status | Interrupted sample and conservative accounting |
| Changed upstream bridge contract | Explicit preflight failure |

Unit tests run without containers. The Linux integration suite requires rootless Podman and MUST execute on a dedicated CI runner before B is released; a skipped suite is not a pass. The model-backed smoke test is manually invoked and reports actual expenditure.
