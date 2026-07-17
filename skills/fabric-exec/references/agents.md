# Agents and rlm reference

`fabric_exec` can spawn one-shot child agents, create persistent event-driven actors, and run recursive queries. For the sandbox model and `tools` discovery, see the parent `fabric-exec` skill; for actor coordination across sessions, see `mesh.md`.

Every method takes a single options object.

## One-shot child agents

- `agents.run(args)` runs to completion and returns `FabricAgentResult` with `{ id, runner, status, text, value?, error?, usage, turns, toolCalls, runnerSessionId? }`.
- `agents.spawn(args)` returns a background `FabricAgentHandle` with an `id`. Then use `agents.wait({ id })`, `agents.status({ id })`, `agents.stop({ id })`.
- `agents.list()` returns all children.
- `agents.cleanup({ id, deleteBranch? })` returns `{ cleaned }` and removes a worktree branch.

`args` is a `FabricAgentRequest`: `{ task, name?, runner?, transport?, model?, thinking?, tools?, timeoutMs?, extensions?, recursive?, worktree?, schema? }`.

- `runner` is `pi` or `claude` and defaults to `subagents.runner` (`pi`).
- `transport` is one of `auto`, `process`, `tmux`, `screen`, `localterm` (default `process`). `auto` tries LocalTerm, tmux, screen, then process.
- Pi `model` values are `provider/id` keys from `tools.models()`; omitted uses `subagents.model` or inherits the host model. Claude values are `claude/<value>` keys from `agents.models({ runner: "claude" })`; omitted uses `subagents.claude.model` or Claude Code's runtime default. `agents.models()` defaults to the configured runner; Claude discovery is a local CLI control handshake and makes no model inference request.
- `thinking` is the reasoning effort (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`); defaults to `subagents.thinking` (`medium`) and is clamped to the model's supported levels (next highest when unsupported).
- `tools` defaults to `subagents.defaultTools`. Claude maps `read→Read`, `grep→Grep`, `find/ls→Glob`, `bash→Bash`, `edit→Edit`, and `write→Write`; other tool names fail before launch.
- `schema` is a JSON Schema; the worker returns validated structured data in `result.value`.
- `worktree: true` creates a dedicated Git worktree on branch `pi-fabric/<name>-<id>`, retained until `agents.cleanup()`.

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

Use `/fabric agents` to list children and `/fabric attach <id>` for the attach command. Abort signals propagate to the transport and selected child process. Claude runs use official `claude -p` stream JSON with `dontAsk`, `--tools`, and `--allowedTools`; `extensions: false` adds Claude safe mode. One-shot Claude sessions use `--no-session-persistence`. Claude cannot use `recursive: true`, `fabric_exec`, or direct mesh APIs.

## Steering running agents

Any Fabric-equipped agent (the main agent, a recursive child, or a persistent actor) can steer any other running agent instead of stopping and respawning it, preserving the child's accumulated context. This mirrors Pi core's RPC `steer` / `follow_up` queue, delivered between the child's turns.

- `agents.steer({ id, message, data? })` queues a message delivered to a running one-shot subagent **between its turns** — after the current turn's tool calls finish, before the next LLM call. For a persistent actor it enqueues a mailbox message (equivalent to `tell`). Returns `{ queued, messageId, routed }`.
- `agents.followUp({ id, message, data? })` queues a message delivered only **after the agent finishes** (one-shot), or enqueues a mailbox message (actor).
- `agents.setSteeringMode({ id, mode })` / `agents.setFollowUpMode({ id, mode })` set how queued steer/follow-up messages are delivered to a running one-shot subagent: `"all"` (deliver every queued message after the current turn / when the agent finishes) or `"one-at-a-time"` (one per turn / per completion — the default). Local subagent only.
- `agents.status({ id })` surfaces the live queue on the result as `pendingMessages: { steering: string[]; followUp: string[] }`, so you can observe how many steers are pending before steering again or stopping.

`routed` is `"local"` when the target is a subagent or actor in this process, or `"mesh"` when the id is not local: the call publishes a `fabric.steer` mesh event the owning process relays to its local target (see `mesh.md`). This is how an agent in one Pi process steers an agent in another — the fabric that lets any agent steer any other.

```ts
const handle = await agents.spawn({ task: "Audit auth flows.", tools: ["read", "grep", "find", "ls"] });
// Watch progress, then redirect between turns without losing the child's context.
const s = await agents.status({ id: handle.id });
if (s.text.includes("rotating refresh tokens")) {
  await agents.steer({ id: handle.id, message: "Skip refresh-token rotation; focus on session expiry only." });
  await agents.setSteeringMode({ id: handle.id, mode: "all" });
}
return await agents.wait({ id: handle.id });
```

Prefer `agents.steer` over `agents.stop` + `agents.spawn` when the child has useful context you would otherwise discard. Use `agents.stop` only when the child is genuinely off-track and a fresh task is cheaper than a redirect. Steering a finished subagent throws `already finished` — check `agents.status` first.

## Persistent actors

`agents.create(args)` returns `FabricActorInfo`. An actor has a fixed `runner`, a serial mailbox, and optional subscriptions to parent events or durable mesh topics. It processes messages one at a time, coalesces repeated host events by default, and restores with the project actor registry. Pi actors resume their Fabric-owned Pi session file. Claude actors persist the session ID emitted by `claude -p` and launch later activations with `--resume <id>` while keeping a Fabric-owned stream transcript.

`args` is a `FabricActorRequest`: `{ name, instructions, runner?, events?, topics?, delivery?, responseMode?, triggerTurn?, coalesce?, model?, thinking?, tools?, transport?, timeoutMs? }`.

- `runner` is fixed at creation. Omitted uses `subagents.runner`. Pi actors are recursively Fabric-equipped; Claude actors retain Claude context and use Claude Code tools, while mailbox/event delivery and coordination remain host-managed (no `fabric_exec` or direct `mesh.*` inside Claude).
- `model` follows the selected runner's key format. Omitted uses that runner's configured/default model. The dashboard can change an actor model override for its next activation; `tell`/`ask` payloads do not change it.
- `thinking` is the reasoning effort forwarded to the actor's runs (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). Omitted inherits `subagents.thinking` (default `medium`), clamped to the model's supported levels. Change it later with `e` from the dashboard actor detail, or by recreating the actor.
- `events` is a subset of `input`, `turn_end`, `agent_settled`, `tool_error`, `session_compact` (host events to subscribe to).
- `topics` lists durable mesh topics to subscribe to (see `mesh.md`).
- `responseMode` is `text` (every non-empty response becomes an outbox message) or `directive` (validated `{ action, message?, data? }` where `action` is `silent`, `message`, or `stop`; the actor decides whether to intervene).
- `delivery` is `mailbox`, `steer`, `followUp`, or `nextTurn`; fixed at creation, an actor cannot escalate it.
- `triggerTurn` fires on the first event of a coalesced burst; `coalesce` is on by default.

```ts
return agents.create({
  name: "auth-supervisor",
  instructions: "Watch the main session until the auth migration is complete and tested. Prefer silence; reply with a directive only for material drift, a blocker, or verified completion.",
  events: ["agent_settled", "tool_error"],
  responseMode: "directive",
  delivery: "steer",
  triggerTurn: true,
  tools: ["read", "grep", "find", "ls"],
});
```

Mailbox:

- `agents.ask({ id, message, data? })` returns a `FabricActorMessage` (blocking exchange).
- `agents.tell({ id, message, data? })` returns `{ queued, messageId }` (fire and forget).
- `agents.actorStatus({ id })` and `agents.actors()` return actor info.
- `agents.messages({ id, limit? })` returns message history.
- `agents.remove({ id })` returns `{ removed }`.
- `agents.log({ id, type?, lines?, runId? })` reads the LLM/agent log for an actor or one-shot run. `type` is `session` (the actor's `session.jsonl` transcript — every user/assistant turn and tool call), `run` (the last retained run's `events.jsonl` event stream), or `all` (both; default `session` for actors). Actors retain their last `MAX_RETAINED_RUNS` runs so logs survive after success. Returns `{ actorId, actorName, sessionFile, logDir, session, run?, retainedRuns }` (actors) or `{ id, runDirectory, logFile, status?, events }` (one-shot runs). Use this to inspect what an "offending" actor actually sent to its model. From the TUI: `/fabric log <id>` previews, `/fabric export-log <id> [path]` writes the raw `session.jsonl` + retained `runs/` to disk.

## Recursive queries

`rlm.query(args)` is a budget-aware `agents.run({ ...args, runner: "pi", recursive: true })` with Fabric enabled in the child. Claude runners are deliberately rejected for recursion. Its usage counts toward `budget.spent()` and the `tokenBudget` guard. Recursion is rejected at `subagents.maxDepth`. Approving the initial recursive call delegates only the `agent` risk capability to recursive children; network, execution, and write approvals are not inherited. Each Fabric process enforces its own concurrency and timeout limits.

```ts
return rlm.query({ task: "Decompose this repository and produce a compact architecture map.", transport: "process" });
```

`council.run({ task, roles, synthesize?, ...agentOptions })` runs several `agents.run` calls concurrently under the subagent semaphore and optionally synthesizes them; load `/skill:fabric-council` for the pattern.
