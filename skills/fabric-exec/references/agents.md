# Agents and rlm reference

`fabric_exec` can spawn one-shot child agents, create persistent event-driven actors, and run recursive queries. For the sandbox model and `tools` discovery, see the parent `fabric-exec` skill; for actor coordination across sessions, see `mesh.md`.

Every method takes a single options object.

## One-shot child agents

- `agents.run(args)` runs to completion and returns `FabricAgentResult` with `{ id, runner, status, text, value?, error?, usage, turns, toolCalls, runnerSessionId? }`.
- `agents.spawn(args)` returns a background `FabricAgentHandle` with an `id`. Then use `agents.wait({ id })`, `agents.status({ id })`, `agents.stop({ id })`.
- `agents.list({ scope? })` returns agent participants. `scope` defaults to `"local"`; use `"lineage"` for every agent under the same root across recursive runtimes, or `"project"` for all live project agents. Local entries retain full run detail; remote entries are bounded participant summaries.
- `agents.cleanup({ id, deleteBranch? })` returns `{ cleaned }` and removes a worktree branch.

`args` is a `FabricAgentRequest`: `{ task, name?, runner?, transport?, model?, thinking?, tools?, timeoutMs?, extensions?, recursive?, worktree?, schema? }`.

- `runner` is `pi` or `claude` and defaults to `agents.runner` (`pi`).
- `transport` is one of `auto`, `process`, `tmux`, `screen`, `localterm`, `herdr` (default `process`). `auto` tries Herdr when the parent runs inside a Herdr workspace, then LocalTerm, tmux, screen, and process.
- Pi `model` values are `provider/id` keys from `tools.models()`; omitted uses `agents.model` or inherits the host model. Claude values are `claude/<value>` keys from `agents.models({ runner: "claude" })`; omitted uses `agents.claude.model` or Claude Code's runtime default. `agents.models()` defaults to the configured runner; Claude discovery is a local CLI control handshake and makes no model inference request.
- `thinking` is the reasoning effort (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`); defaults to `agents.thinking` (`medium`) and is clamped to the model's supported levels (next highest when unsupported).
- `tools` defaults to `agents.defaultTools`. Claude maps `read→Read`, `grep→Grep`, `find/ls→Glob`, `bash→Bash`, `edit→Edit`, and `write→Write`; other tool names fail before launch.
- `schema` is a JSON Schema; the worker returns validated structured data in `result.value`.
- `worktree: true` creates a dedicated Git worktree on branch `pi-fabric/<name>-<id>`, retained until `agents.cleanup()`.
- Omit `timeoutMs` normally. It defaults to `agents.timeoutMs` (60 minutes by default), and per-call values below that configured default are ignored. Set it only to request a longer run.

```ts
const result = await agents.run({
  name: "security-review",
  task: "Review the current diff for concrete security defects. Do not edit files.",
  tools: ["read", "grep", "find", "ls"],
});
return result;
```

```ts
const handle = await agents.spawn({ task: "Map the persistence layer.", transport: "tmux" });
// independent work here
return await agents.wait({ id: handle.id });
```

Detached `agents.spawn()` runs already notify Main on terminal completion when `agents.notifyOnComplete` is enabled (the default). The notification is a triggered follow-up. Use `agents.wait()` when the current Fabric program needs the result, `agents.status()` only for a point-in-time progress inspection, and lifecycle subscriptions when another participant's Pi boundary matters. Calling `wait()` makes that run foreground work and suppresses the detached completion notification.

## Participant lifecycle subscriptions

Lifecycle subscriptions are durable, source-qualified mesh routes. They let Main, an actor, or an active agent react to another root/agent/actor without model-authored polling.

- `agents.subscribe({ from, events, to?, delivery, triggerTurn, once? })` creates a subscription. `from` is an exact participant id; `"main"` means the caller's lineage root. `to` defaults to that Main id.
- `agents.subscriptions({ from?, to? })` lists project subscriptions.
- `agents.unsubscribe({ id })` removes one.
- `delivery` is `steer` or `followUp`. State `triggerTurn: true | false` explicitly; it controls whether delivery to an idle Main starts a turn.
- `once: true` removes the subscription after its first successful matching delivery. Omitted keeps it active.
- Creation starts at the current mesh sequence, so old lifecycle events are not replayed. Delivery cursors persist across owner restarts. Delivery is at-least-once across a crash between message insertion and cursor persistence; use the lifecycle event `id` to deduplicate side effects.

Exact Pi events are `pi.input`, `pi.agent_start`, `pi.agent_end`, `pi.turn_end`, `pi.agent_settled`, `pi.tool_error`, and `pi.session_compact`. Runner-neutral terminal events are `run.completed`, `run.failed`, `run.stopped`, and `run.timed_out`. Pi events are observed from Pi's host/RPC lifecycle; run events also cover Claude-backed children and actor activations. Envelopes contain bounded operational metadata, source identity, timestamps, and a run id when applicable, never a transcript snapshot.

`pi.agent_settled` means Pi has no automatic retry, compaction retry, or queued continuation left at that boundary. It does not mean a persistent root or actor can never receive future work. Use a `run.*` event when terminal process/run status is what matters.

```ts
const peer = (await agents.peers())[0];
if (!peer) return { subscribed: false };
return agents.subscribe({
  from: peer.id,
  events: ["pi.agent_settled"],
  to: "main",
  delivery: "followUp",
  triggerTurn: true,
  once: true,
});
```

## Trajectory handoff

`agents.handoff({ model, task?, when?, ... })` schedules a blocking Pi-to-Pi trajectory handoff at the end of the current outer `fabric_exec`. Inside the guest it returns a deferred marker immediately, so calls after it still run. Once the complete program and all outer result middleware finish, Fabric forks the native assistant `fabric_exec` call plus its exact native `toolResult`, starts the explicit `provider/id` target in the same workspace, and waits before Main can infer again. Do not expect child output inside the same guest program; Main receives it as the final outer tool result.

`when` is guest-only and must be a pure synchronous predicate over immutable successful-call facts. It is deleted before the host validates the request:

```ts
await pi.edit({ path: "src/guard.ts", edits: [{ oldText, newText }] });
await agents.handoff({
  model: "anthropic/claude-haiku-4-5",
  task: "Continue from this completed Fabric invocation.",
  when: ({ count }) => count("pi.edit") >= 1,
});
await pi.bash({ command: "pnpm test guard" });
return "Frontier invocation complete";
```

Facts include every successful resolved bridge call completed before `agents.handoff()`, from `pi.*`, `extensions.*`, `mcp.*`, external providers, and generic `tools.call()`. Use `count()` for all calls, `count(ref)` for one, or `count([ref, ...])` for a set. Computed calls are recorded under their target ref rather than `fabric.$call`; failed calls do not count. A false or asynchronous predicate starts no child and errors clearly. Omit `when` for unconditional scheduling.

The guest result is `{ scheduled: true, status: "deferred", boundary: "fabric_exec_end" }`; the final outer tool result is `{ handedOff, completed, status, agent, implementation, error? }`. `model` is required and handoff is always Pi-backed. It also accepts `name`, `transport`, `thinking`, `tools`, `timeoutMs`, `extensions`, `recursive`, and `schema`; it deliberately omits `worktree` so implementation remains in the caller's workspace. Do not run handoff in a parallel branch that keeps mutating the same files.

## Automatic prewalk

`/fabric prewalk [task]` arms one automatic handoff when a Fabric invocation contains a successful `pi.edit`, `pi.write`, or `schema.commit`. With a task it submits the task immediately; without one it captures the next user input. The executor is the dedicated `prewalk.model` setting under `/fabric settings`, or an interactive model choice when unset. The `prewalk.alwaysRearm` setting keeps it armed across successive tasks until `/fabric prewalk --off`.

Prewalk injects no system-prompt guidance and does not ask Main to call a handoff API. A trigger marks the current outer invocation but does not stop it: all later sequential and parallel nested calls finish normally. The host claims after execution settles, forks the finalized native `fabric_exec` call/result pair, spawns, and waits. The terminating result suppresses Main's automatic post-tool inference. If the captured task settles without a trigger, the arm is cancelled rather than leaking into the next task unless `prewalk.alwaysRearm` is enabled; in that mode the completed task is cleared before the next input is captured. Use `/fabric prewalk --status` or `/fabric prewalk --off`. Prewalk requires enabled agents and full code mode, and is disabled by Schema enforce mode.

Use `/fabric agents` to list children and `/fabric attach <id>` for the attach command. Abort signals propagate to the transport and selected child process. Claude runs use official `claude -p` stream JSON with `dontAsk`, `--tools`, and `--allowedTools`; `extensions: false` adds Claude safe mode. One-shot Claude sessions use `--no-session-persistence`. Claude cannot use `recursive: true`, `fabric_exec`, or direct mesh APIs.

## Unified participants and steering

Every live root, one-shot/recursive agent, and persistent actor is represented in one project participant directory. Participant kinds are intrinsic (`"root"`, `"agent"`, or `"actor"`); **Main** and **Peer** are UI/API views of root participants, not separate identity classes. **Peer is a reserved Fabric term for another root Pi session.** A request to inspect, wait for, or coordinate with a “peer” means call `agents.peers()` first; `agents.list()` lists child agents and cannot establish whether a peer root has settled. Execution remains local to an `ownerHostId` and authenticated `ownerIdentityId`, while `rootId` and optional `parentId` describe lineage. Host leases remove a crashed host and all participants it owns from live discovery together. Shared records deliberately omit agent prompts, results, and errors; full detail stays local.

- `agents.self()` returns the caller's `FabricParticipantInfo`.
- `agents.members({ scope?, kinds?, includeStale? })` returns the unified directory. `scope` is `"local"`, `"lineage"`, or `"project"` (default); `kinds` filters intrinsic kinds. Normal discovery excludes stale hosts.
- `agents.main()` remains the compatibility view of the caller's root as `{ id, name: "Main", kind: "main", ... }`; the stable alias `"main"` resolves to that exact root id.
- `agents.peers()` remains the compatibility view of other live roots as `Peer <session-prefix>`. It is derived from `agents.members`, not maintained by a second registry.
- `agents.status({ id })` accepts any known participant id. Local runs/actors return full local detail; remote participants return their bounded directory summary.
- `agents.steer({ id, message, data? })` and `agents.followUp(...)` target Main, a live one-shot child, or an actor without discarding context.
- `agents.stop({ id })` can stop a local or remotely owned agent/actor when its participant advertises `"stop"`. It returns the local agent result, local actor info, or an acknowledged remote control result according to the target.
- `agents.setSteeringMode({ id, mode })` / `agents.setFollowUpMode({ id, mode })` remain local one-shot controls.

Local delivery returns `routed: "main" | "local"`. Cross-process delivery resolves the participant's exact owner host and identity, publishes an owner-addressed control command, and accepts only a version/target/identity-matched acknowledgement. Success returns `{ queued, messageId, routed: "mesh", acknowledged: true }`; an unknown id, stale owner, owner rejection, or acknowledgement timeout throws instead of reporting an unverified queue. This path requires `mesh.enabled`. Ordinary non-recursive Pi children and Claude children/actors can receive host-routed messages but cannot initiate `agents.*` calls because they do not run Fabric themselves.

```ts
const main = await agents.main();
const project = await agents.members({ scope: "project" });
const peerRoot = project.find((participant) => participant.kind === "root" && participant.id !== main.id);
if (peerRoot) await agents.steer({ id: peerRoot.id, message: "Coordinate on the shared migration." });
await agents.followUp({ id: main.id, message: "After the audit, reconcile the worker findings." });
const handle = await agents.spawn({ task: "Audit auth flows.", tools: ["read", "grep", "find", "ls"] });
// Watch progress, then redirect between turns without losing the child's context.
const s = await agents.status({ id: handle.id });
if (s.text.includes("rotating refresh tokens")) {
  await agents.steer({ id: handle.id, message: "Skip refresh-token rotation; focus on session expiry only." });
  await agents.setSteeringMode({ id: handle.id, mode: "all" });
}
return await agents.wait({ id: handle.id });
```

Prefer `agents.steer` over `agents.stop` + `agents.spawn` when the child has useful context you would otherwise discard. Use `agents.stop` only when the child is genuinely off-track and a fresh task is cheaper than a redirect. Steering a finished agent throws; check `agents.status` or the participant capabilities first. In the dashboard, `s`, `u`, and `x` use the same ownership-aware path for local and remote participants.

## Persistent actors

`agents.create(args)` returns `FabricActorInfo`. An actor has a fixed `runner`, a serial mailbox, and optional subscriptions to parent events or durable mesh topics. It processes messages one at a time, coalesces repeated host events by default, and restores with the project actor registry. Pi actors resume their Fabric-owned Pi session file. Claude actors persist the session ID emitted by `claude -p` and launch later activations with `--resume <id>` while keeping a Fabric-owned stream transcript.

`args` is a `FabricActorRequest`. `delivery` defaults to `mailbox`; `steer`/`followUp` require an explicit `triggerTurn: true | false`, while `mailbox`/`nextTurn` reject `triggerTurn: true`.

- `runner` is fixed at creation. Omitted uses `agents.runner`. Pi actors are recursively Fabric-equipped; Claude actors retain Claude context and use Claude Code tools, while mailbox/event delivery and coordination remain host-managed (no `fabric_exec` or direct `mesh.*` inside Claude).
- `model` follows the selected runner's key format. Omitted uses that runner's configured/default model. `agents.setModel({ id, model? })` changes or clears the override for the next activation without replacing the actor session; `tell`/`ask` payloads do not change it.
- `thinking` is the reasoning effort forwarded to the actor's runs (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). Omitted inherits `agents.thinking` (default `medium`), clamped to the model's supported levels. Change it later with `agents.setThinking({ id, thinking? })` or `e` from the dashboard actor detail; omitting `thinking` clears the override.
- `events` may contain any session-bound public Pi extension event: `resources_discover`; `session_start`, `session_info_changed`, `session_before_switch`, `session_before_fork`, `session_before_compact`, `session_compact`, `session_shutdown`, `session_before_tree`, `session_tree`; `input`, `before_agent_start`; `agent_start`, `agent_end`, `agent_settled`; `turn_start`, `turn_end`; `message_start`, `message_update`, `message_end`; `context`, `before_provider_headers`, `before_provider_request`, `after_provider_response`; `tool_execution_start`, `tool_call`, `tool_execution_update`, `tool_result`, `tool_execution_end`; `model_select`, `thinking_level_select`, and `user_bash`. Fabric also provides synthetic `tool_error`. `project_trust` is unavailable because it precedes trusted actor-registry initialization. These are asynchronous observations and cannot mutate or block the originating Pi hook.
- Host events automatically forward every Pi `ImageContent` block to the actor's selected model. The JSON envelope and persisted mailbox contain only redacted indexed descriptors; raw base64 travels through the transient worker prompt and may then follow the selected runner's ordinary persistent-session semantics. No media flag is required. Credential-shaped fields and unrelated encoded blobs are redacted before persistence.
- `topics` lists durable mesh topics to subscribe to (see `mesh.md`).
- `responseMode` is `text` (every non-empty response becomes an outbox message) or `directive` (validated `{ action, message?, data? }` where `action` is `silent`, `message`, or `stop`; the actor decides whether to intervene).
- `delivery` is `mailbox`, `steer`, `followUp`, or `nextTurn`. An actor cannot escalate it in a response; the owner can replace it with `agents.setDeliveryPolicy({ id, delivery, triggerTurn, scope? })`.
- `triggerTurn` is mandatory for `steer`/`followUp`: `true` starts Main when idle; `false` is passive and the delivered message visibly says it will not start Main. `mailbox`/`nextTurn` never start Main. `coalesce` is on by default.
- `validWhile` is an optional pure synchronous predicate checked before an activation runs and again before its result is delivered. It receives immutable `{ activation, current }` facts. Return `false` or `{ valid: false, reason? }` to record the activation as stale and suppress delivery; an invalidated blocking `agents.ask()` rejects. The predicate source persists with project actors and global templates, so it cannot use closures, tools, promises, or host APIs.
- `timeoutMs` follows the same floor as one-shot agents: omit it normally and set it only above `agents.timeoutMs` when an activation needs longer.
- `tools` is the actor's persisted allowlist and defaults to `agents.defaultTools`. Replace it for future activations with `agents.setTools({ id, tools })`; an empty list disables optional tools. Pi actors retain the host-required `fabric_exec` tool unless created with `extensions: false`. Use `scope: "global"` to update a reusable template instead.
- `extensions` is `true` by default (a Pi actor is recursively Fabric-equipped with the host-required `fabric_exec` tool). Set `extensions: false` to disable Fabric for a Pi actor: the activation runs with `extensions: false` and `recursive: false`, so `fabric_exec` is not injected and the actor cannot call `agents.*` or `mesh.*`; the host still manages its mailbox and delivery (same coordination model as a Claude actor). This does not restrict ordinary tools: also use `tools: ["read", "grep", "find", "ls"]` for a read-only actor or `tools: []` for no tools. Fixed at creation.

```ts
return agents.create({
  name: "auth-supervisor",
  instructions: "Watch the main session until the auth migration is complete and tested. Prefer silence; reply with a directive only for material drift, a blocker, or verified completion.",
  events: ["agent_settled", "tool_error"],
  validWhile: ({ activation, current }) => {
    if (activation.kind !== "hostEvent") return true;
    if (activation.sequence !== current.latestActivationSequence) return false;
    return activation.event !== "tool_error" || activation.mainRevision === current.mainRevision;
  },
  responseMode: "directive",
  delivery: "steer",
  triggerTurn: true,
  tools: ["read", "grep", "find", "ls"],
});
```

For a native asynchronous vision handoff, create one actor with an explicit multimodal `model`, `events: ["input"]`, `responseMode: "directive"`, passive `delivery: "steer"`, `triggerTurn: false`, `coalesce: false`, `validWhile: ({ activation }) => activation.kind !== "hostEvent" || (activation.signal?.media?.length ?? 0) > 0`, `tools: []`, and usually `extensions: false`. Instruct it to return `silent` when no image is attached and otherwise return only a compact visual description for Main. Fabric attaches prompt images automatically; do not add base64 to the task or mailbox data. The actor does not block Main's current inference.

Mailbox:

- `agents.ask({ id, message, data? })` returns a `FabricActorMessage` (blocking exchange).
- `agents.tell({ id, message, data? })` returns `{ queued, messageId }` (fire and forget).
- `agents.actorStatus({ id })` and `agents.actors()` return full info only for locally owned actors. Discover remote actors through `agents.members({ kinds: ["actor"] })`.
- `agents.setModel({ id, model? })` and `agents.setThinking({ id, thinking? })` migrate the next activation while preserving the actor's runner session.
- `agents.setTools({ id, tools, scope? })` replaces the persisted tool allowlist for a project actor (default) or global template.
- `agents.setDeliveryPolicy({ id, delivery, triggerTurn, scope? })` replaces the explicit project/global continuation policy without recreating the actor. In the dashboard, press `y` on an actor/template for the same control.
- `agents.messages({ id, limit? })` returns owner-local message history; passive shared-registry views cannot read another owner's mailbox.
- `agents.remove({ id })` returns `{ removed }`.
- `agents.log({ id, type?, lines?, runId? })` reads the LLM/agent log for a locally owned actor or one-shot run. `type` is `session` (the actor's `session.jsonl` transcript — every user/assistant turn and tool call), `run` (the last retained run's `events.jsonl` event stream), or `all` (both; default `session` for actors). Actors retain their last `MAX_RETAINED_RUNS` runs so logs survive after success. Returns `{ actorId, actorName, sessionFile, logDir, session, run?, retainedRuns }` (actors) or `{ id, runDirectory, logFile, status?, events }` (one-shot runs). Use this to inspect what an "offending" actor actually sent to its model. From the TUI: `/fabric log <id>` previews, `/fabric export-log <id> [path]` writes the raw `session.jsonl` + retained `runs/` to disk.

## Recursive queries

`rlm.query(args)` is a budget-aware `agents.run({ ...args, runner: "pi", recursive: true })` with Fabric enabled in the child. Claude runners are deliberately rejected for recursion. Its usage counts toward `budget.spent()` and the `tokenBudget` guard. Recursion is rejected at `agents.maxDepth`. Approving the initial recursive call delegates only the `agent` risk capability to recursive children; network, execution, and write approvals are not inherited. Each Fabric process enforces its own concurrency and timeout limits.

```ts
return rlm.query({ task: "Decompose this repository and produce a compact architecture map.", transport: "process" });
```

`council.run({ task, roles, synthesize?, ...agentOptions })` runs several `agents.run` calls concurrently under the agent semaphore and optionally synthesizes them. The full council pattern is user-invoked; never load `/skill:fabric-council` autonomously.
