# @dsh-cc/coordinator

English | [中文](README.zh.md)

Coordinator mode is an agent-scoped orchestration role over continuable subagents: when active, the hosting agent stops editing the workspace directly and instead delegates work to named background workers and routes messages among them. Activation is a deployment flag — Config `enabled` or the `DSH_COORDINATOR_MODE` env — and it takes effect on the agent whose scope mounts this package, so a preset [composes it](../preset/agent-presets/README.md) into a session and the mode survives resume by being re-mounted from that pinned composition.

## Activation and tool restriction

`apply(ctx, config)` resolves `config.enabled ?? DSH_COORDINATOR_MODE`, and when inactive registers nothing — a preset may mount it unconditionally. When active it requires an agent-scoped context (it reads the mounted `agent`), because tool restriction is an agent-scoped operation; mounting it on a plain context fails loud rather than masking every agent. It then installs, all scoped to that agent:

- a `coordinator:mode` system-prompt section (`installCoordinatorMode`'s `sectionOrder`, default prompt-order 110) stating the orchestration role, the delegation tool list, and the result-return protocol;
- the scheduling tools `spawn_worker`, `send_to_worker`, `worker_broadcast`, and `worker_tasks`;
- a scoped [tool restriction](../../core/tools/README.md) via `ctx.tools.restrict()`, defaulting to `{ deny: ['write', 'edit'] }` (Config `restrict` overrides, and may use an `allow` mask instead).

Disposing the plugin fiber reverses every registration in one pass, so disabling coordinator mode restores the agent's full tool surface.

## Delegation surface

The scheduling tools are thin adapters over the subagent service, so residency, cold resume, and delivery authority remain the service's:

- `spawn_worker(name, prompt)` calls `ctx.subagents.startContinuable()` and records the durable child id under the given name.
- `send_to_worker(worker, message)` resolves a name (or durable id) and steers or wakes that worker through `ctx.subagents.sendMessage()` — a running worker takes the message at its next step boundary, an idle or parked one is woken (or cold-resumed). Sender attribution is derived from the live coordinator Agent.
- `worker_broadcast(message)` sends the same content to every registered worker (steer + wake semantics as above).
- `worker_tasks()` lists registered workers with a live status from the Agent registry.

An unknown worker reference is an errored result; a scheduling tool invoked without a calling agent fails loud.

## Result return and completion (reused protocols)

Coordinator mode does not reinvent worker-to-coordinator reporting, and there is no report tool. A worker returns its outcome by sending a message back to the coordinator with the harness `send_message` control tool (addressed to the coordinator's session id), and when a worker settles the subagent service's continuation settlement injects its `subagent-settled` notice into the coordinator agent's session as a waking message ([`dsh-subagent` continuation settlement delivery](../subagent/README.md)) — the completion notification that wakes the coordinator's loop. This package documents that reuse rather than duplicating the wake; its tests assert the notice reaches the coordinator session.

## Directory

The `Section` texts and constants live in `src/section.ts`; the worker bookkeeping, scheduling tools, activation gate, and disposer live in `src/index.ts`.
