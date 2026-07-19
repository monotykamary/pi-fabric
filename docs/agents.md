# Agents, actors & mesh

This is the human-facing reference for Fabric's multi-agent runtime. The model-facing API lives in [`skills/fabric-exec/references/agents.md`](../skills/fabric-exec/references/agents.md) and [`mesh.md`](../skills/fabric-exec/references/mesh.md); the reusable patterns live in the [skills](../skills/) (`fabric-workflow`, `fabric-swarm`, `fabric-council`, `fabric-rlm`, `fabric-supervisor`, `fabric-advisor`, `fabric-fusion`). See [configuration](configuration.md) for the `subagents` and `mesh` settings.

## Workflows

Fabric programs already keep orchestration and intermediate values in code. The workflow globals add Claude Code-style names and progress phases without introducing a second JavaScript runtime.

Available helpers:

- `workflow.agent(prompt, options)` or `agent(...)` — one worker. Set `label` on every call.
- `workflow.parallel(thunks, { concurrency })` or `parallel(...)` — fan-out. Pass functions, not promises.
- `workflow.pipeline(items, ...stages)` or `pipeline(...)` — per-item sequential stages with cross-item concurrency.
- `workflow.configure({ name, description })` — names the activity surface.
- `workflow.phase(name, { id?, description?, total? })` or `phase(...)` — progress groups.
- `workflow.item(...)` — non-agent work items whose status changes over time.
- `workflow.event(...)` — notable milestones in the dashboard feed.
- `workflow.log(...)` — compact progress notes.
- `workflow.budget` — token-budget observations.

`fabric_exec` accepts optional `agentBudget` and `tokenBudget` limits; configuration supplies a hard per-execution agent cap. A JSON Schema on an agent request makes the worker return validated structured data through `result.value`; workflow helpers return that value directly and otherwise return the agent's final text. See [`/skill:fabric-workflow`](../skills/fabric-workflow/SKILL.md) for the full pattern.

## Subagents

```ts
const result = await agents.run({
  name: "security-review",
  task: "Review the current diff for concrete security defects. Do not edit files.",
  transport: "localterm",
  tools: ["read", "grep", "find", "ls"],
});
return result;
```

Background handles are explicit:

```ts
const handle = await agents.spawn({
  task: "Map the persistence layer and identify its public entry points.",
  transport: "tmux",
});

// Do independent work here.

return await agents.wait({ id: handle.id });
```

`runner` is `"pi"` or `"claude"` and defaults to `subagents.runner` (`"pi"`). Pi children use `subagents.model` or inherit the parent model unless `model` is specified. Claude children use `subagents.claude.model` or Claude Code's own runtime default. Their tool allowlist defaults to `subagents.defaultTools`. Reasoning effort defaults to `subagents.thinking` (`medium`); Pi clamps it to model support, while Claude forwards it through `--effort` (`off`/`minimal` map to `low`).

### Claude Code runner

Install and authenticate the official Claude Code CLI (`claude`) normally; Fabric invokes that binary rather than Anthropic's Agent SDK or a third-party API client. Select it per call or globally:

```ts
const models = await agents.models({ runner: "claude" });
const haiku = models.find((model) => model.key === "claude/haiku");
return agents.run({
  runner: "claude",
  model: haiku?.key,
  task: "Review the current diff. Do not edit files.",
  tools: ["read", "grep", "find", "ls"],
});
```

`agents.models({ runner: "claude" })` asks the installed CLI for its initialization model catalog, including aliases, resolved IDs, descriptions, and supported effort levels. The list is not hard-coded and the handshake sends no user prompt or model inference request, so model discovery itself is not billable. Because it launches the configured local binary, model-authored `agents.models` calls carry Fabric's `execute` risk. Fabric caches it for 60 seconds. Claude model keys use `claude/<runtime-value>` (for example `claude/default`, `claude/sonnet`, or `claude/haiku`); Fabric strips that namespace before `--model`.

Claude runs use `claude -p` with stream-JSON input/output, partial messages, `--permission-mode dontAsk`, and both `--tools` and `--allowedTools`. Fabric maps its portable core allowlist as follows:

| Fabric tool  | Claude Code tool |
| ------------ | ---------------- |
| `read`       | `Read`           |
| `grep`       | `Grep`           |
| `find`, `ls` | `Glob`           |
| `bash`       | `Bash`           |
| `edit`       | `Edit`           |
| `write`      | `Write`          |

Unknown tools fail before launch. `extensions: false` starts Claude in safe mode; the default `true` preserves the user's normal Claude Code customizations while the explicit tool list still controls model-facing tools. JSON schemas use Claude's native `--json-schema`; usage, cost, turns, tool activity, errors, and Claude's session ID are normalized into the ordinary Fabric result and dashboard transcript. One-shot runs add `--no-session-persistence`.

Claude-backed children are intentionally **not recursively Fabric-equipped**: `recursive: true`, `fabric_exec`, and direct `mesh.*` access are rejected. Use `runner: "pi"` for RLM/recursive Fabric, or use a Claude-backed persistent actor for host-managed mailbox/event coordination.

### Transports

| Transport   | Behavior                                                   | Attach command               |
| ----------- | ---------------------------------------------------------- | ---------------------------- |
| `process`   | Detached local worker process; default and lowest overhead | none                         |
| `tmux`      | One detached tmux session per child                        | `tmux attach-session -t …`   |
| `screen`    | One detached GNU Screen session per child                  | `screen -r …`                |
| `localterm` | One pinned LocalTerm PTY per child                         | `localterm session attach …` |
| `auto`      | Tries LocalTerm, tmux, screen, then process                | transport-specific           |

LocalTerm already exposes the needed tmux-parity primitives: detached creation, pinning, listing, capture, exec, attach, and kill. Pi Fabric therefore requires no LocalTerm patch. Start its daemon before selecting it:

```bash
localterm start
```

Use `/fabric agents` to list children and `/fabric attach <id>` to display the appropriate attach command. Abort signals propagate to the transport and selected child process. When a program uses orchestration entry points (`agent`/`workflow.agent`, `agents.run`/`agents.wait`/`agents.ask`, `council.run`, `rlm.query`)—including `agents.*` refs invoked through `tools.call()` and refs computed at runtime—Fabric raises the whole-program `executor.timeoutMs` to at least `subagents.timeoutMs`, so the parent deadline cannot stop children that are still within their own per-agent budget.

Set `worktree: true` to create a dedicated Git worktree and `pi-fabric/<name>-<id>` branch. Worktrees are retained for inspection until `agents.cleanup()` is called.

## Steering running agents

Any Fabric-equipped agent can steer a running one-shot subagent **between its turns** instead of stopping and respawning it, preserving the child's accumulated context — mirroring Pi core's RPC `steer`/`follow_up` queue:

```ts
const handle = await agents.spawn({ task: "Audit auth flows.", tools: ["read", "grep", "find", "ls"] });
const s = await agents.status({ id: handle.id });
if (s.text.includes("rotating refresh tokens")) {
  await agents.steer({ id: handle.id, message: "Skip refresh-token rotation; focus on session expiry only." });
  await agents.setSteeringMode({ id: handle.id, mode: "all" });
}
return await agents.wait({ id: handle.id });
```

`agents.steer({ id, message })` is delivered after the current turn's tool calls, before the next LLM call; `agents.followUp({ id, message })` is delivered after the agent finishes; `agents.setSteeringMode`/`setFollowUpMode` set `"all"` vs `"one-at-a-time"` delivery. Pi uses its RPC queue; Claude uses additional user records on the same `claude -p` stream so the session and context are preserved. `agents.status({ id }).pendingMessages` shows the live queue. For an id not local to this process, `agents.steer` publishes a `fabric.steer` mesh event the owning process relays — so an agent in one Pi process can steer an agent in another. See [`references/agents.md`](../skills/fabric-exec/references/agents.md).

## Persistent actors

`agents.create()` creates a named actor with a fixed runner, a persistent runner session, a serial mailbox, and optional subscriptions to parent-session events or durable mesh topics:

```ts
return agents.create({
  name: "auth-supervisor",
  instructions: `Watch the main session until the auth migration is complete and tested.
Prefer silence. Reply with a directive only for material drift, a blocker, or verified completion.`,
  events: ["agent_settled", "tool_error"],
  responseMode: "directive",
  delivery: "steer",
  triggerTurn: true,
  thinking: "high",
  tools: ["read", "grep", "find", "ls"],
});
```

A host-managed Claude actor uses the same mailbox and event surface while retaining Claude Code context across activations:

```ts
return agents.create({
  name: "claude-reviewer",
  runner: "claude",
  model: "claude/haiku",
  instructions: "Review each delivered event and report only concrete regressions.",
  events: ["agent_settled", "tool_error"],
  responseMode: "directive",
  delivery: "steer",
  tools: ["read", "grep", "find", "ls"],
});
```

Claude actors can retain context, inspect/edit with mapped Claude Code tools, consume host events and mesh messages delivered by Fabric, and return text or directives. They cannot themselves call `fabric_exec`, `agents.*`, or `mesh.*`; use a Pi actor when the actor must recursively coordinate through Fabric. If Claude's private session has been removed, the next activation fails clearly rather than silently discarding actor context. Recreate the actor to start a fresh Claude session.

This is the primitive behind emergent supervisors and advisors; neither requires another extension. Host events include a bounded recent-session snapshot. Actors process messages one at a time, coalesce repeated host events by default, and restore with the trusted project actor registry. Pi actors keep model context in their Fabric-owned Pi session file. Claude actors persist the session ID emitted by the official CLI, reapply tools/permissions/schema/system-prompt flags on every activation, and use `--resume <id>` after the first message; Fabric also keeps a runner-neutral stream transcript instead of reading Claude's private JSONL format. Each actor's reasoning effort is its `thinking` level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`), defaulting to `subagents.thinking` (`medium`); set it at creation or change it later with `e` from the dashboard.

### Response modes and delivery

Two response modes are available:

- `text`: every non-empty response becomes an actor outbox message.
- `directive`: validated `{ action: "silent" | "message" | "stop", message?, data? }` output lets the actor decide whether intervention is useful.

Delivery can remain in `mailbox` or enter the main session as `steer`, `followUp`, or `nextTurn`. The creator fixes delivery policy; an actor cannot escalate it in a response. Use `agents.ask()` for a blocking exchange, `agents.tell()` for fire-and-forget mail, `agents.messages()` for history, and `agents.remove()` for cleanup.

## Global actor templates

Persistent actors live in a project mesh, but a persona worth reusing across projects belongs in a project-independent **template library** stored in your agent dir (`~/.pi/agent/fabric/actors/`). Templates carry only an actor definition — name, instructions, subscriptions, and run settings — never any history (mailbox, session transcript, or run logs). They are not live; you stamp one into a project to make it run.

```ts
// Save a reusable persona to the global registry (not a live actor).
return agents.create({
  name: "security-reviewer",
  instructions: "Review changes for security defects. Reply with a directive only for material drift.",
  events: ["agent_settled"],
  responseMode: "directive",
  scope: "global",
});

// List templates, then stamp one into the current project as a fresh actor.
const [template] = agents.actors({ scope: "global" });
return agents.import({ name: template.name });                       // fresh: no inherited history
return agents.import({ name: "security-reviewer", as: "security-reviewer-2" }); // rename on collision

// Promote a tuned project actor back to the global library (no history).
return agents.export({ id: actorId, overwrite: true });

// Refine a template's default instruction (the persona / system-prompt body).
return agents.setInstructions({ id: template.id, instructions: "Be brief.", scope: "global" });
```

`agents.setInstructions` also edits a live project actor (`scope: "project"`, the default); the new instruction takes effect on the actor's next queued message. History never crosses the project⇄global boundary — import and export move only the definition. Slash commands mirror the API: `/fabric global` lists templates, `/fabric import <name> [as <new>]` stamps one into the project, and `/fabric export <id> [--overwrite]` promotes a project actor. The dashboard lists global templates alongside live actors and lets you import, export, delete, and edit instructions without writing code.

## Councils

```ts
return council.run({
  task: "Review the current implementation and recommend whether it is ready to merge.",
  roles: ["correctness reviewer", "security reviewer", "test reviewer"],
  transport: "localterm",
  synthesize: true,
});
```

Council members run concurrently under the global subagent semaphore. With `synthesize: true`, a final child agent reconciles their reports. See [`/skill:fabric-council`](../skills/fabric-council/SKILL.md).

## Recursive queries

```ts
return rlm.query({
  runner: "pi",
  task: "Recursively decompose this repository and produce a compact architecture map.",
  transport: "process",
});
```

`rlm.query()` is `agents.run({ runner: "pi", recursive: true })` with Fabric enabled in the child. Claude runners are intentionally rejected for recursive Fabric. Recursion is rejected at `subagents.maxDepth`. Approval of the initial recursive call delegates only the `agent` risk capability to recursive children; network, execution, and write approvals are not inherited. Each Fabric process enforces its own configured concurrency and timeout limits. When `subagents.budgetUsd` is set, a shared append-only cost ledger bounds total spend across the whole recursion tree: every node records the cost of the children it spawns into one ledger file inherited via environment, and each node rejects a new child when the accumulated spend reaches the budget. The check is best-effort (concurrent children can each pass before any cost lands, so a tree may slightly overshoot); the race-free ceiling remains `subagents.maxPerExecution`. The result and live status of every recursive child carry a `budget` summary (`limit`, `spent`, `remaining`, `tokens`). Fabric also keeps the latest bounded nested-agent status tree in memory, so completed recursive leaves remain visible in **Topology · Run** after the child process removes its temporary nested run directories. The snapshot is released when the parent run is cleaned up or the Fabric session shuts down.

`subagents.maxTokensPerChild` (0 = disabled) bounds each child's cumulative token usage. The wall-clock `timeoutMs` and the cost `budgetUsd` bound time and money; this bounds a single runaway child's context before the host session compacts, terminating it with the same `timed_out` status and a `token limit` error. See [`/skill:fabric-rlm`](../skills/fabric-rlm/SKILL.md).

## Durable mesh coordination

The `mesh` API is a project-scoped, event-sourced coordination substrate:

```ts
const event = await mesh.publish({
  topic: "team.auth",
  kind: "finding",
  text: "Refresh-token rotation is not atomic",
  data: { path: "src/auth/refresh.ts" },
});

const task = await mesh.put({
  key: "tasks/auth-review",
  value: { status: "ready", owner: null },
  ifVersion: 0,
});

const claimed = await mesh.put({
  key: task.key,
  value: { status: "claimed", owner: "security-reviewer" },
  ifVersion: task.version,
});
return { event, claimed };
```

Topics provide durable channel and direct-message semantics with sequence cursors. `mesh.members()` discovers actor presence across live Fabric sessions. Versioned `get`/`put`/`delete` operations provide compare-and-swap state for task claims, leases, reservations, and decisions. Together with persistent actors, these are sufficient to express messenger-style swarms in Fabric code without a daemon or fixed planner/worker roles. See [`/skill:fabric-swarm`](../skills/fabric-swarm/SKILL.md) for the pattern and [`references/mesh.md`](../skills/fabric-exec/references/mesh.md) for the full API.
