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

### Trajectory-preserving handoff

A handoff is a blocking Pi-to-Pi delegation over a real fork of the caller's active session branch, rather than a fresh worker that receives only a task string. One complete `fabric_exec` invocation is the atomic frontier unit. An explicit `agents.handoff()` call records a deferred request inside the guest; it does not spawn a child or stop the program at that line. Sequential and parallel calls after the request continue normally.

After the complete Fabric program returns, Pi finalizes the native outer `fabric_exec` tool result. At that `message_end` boundary, Fabric forks through the original assistant entry containing the native `fabric_exec` call and appends that exact finalized native `toolResult` to the child branch. It then starts the selected executor in the same workspace and waits before Pi can perform another Main inference. The child therefore sees exactly the outer call and frontier result finalized before handoff replacement, including the Fabric source, output, and persisted trace; nested calls are not rewritten into synthetic assistant turns. An in-memory source is materialized into the same native Pi session format.

Fabric adds no handoff-specific count or size limit. Normal `fabric_exec` output and trace projection limits still apply before the boundary. Handoff fails closed if the active outer turn cannot be identified or belongs to an incomplete parallel top-level tool batch.

```ts
await pi.edit({ path: "src/guard.ts", edits: [{ oldText, newText }] });
await agents.handoff({
  model: "anthropic/claude-haiku-4-5",
  task: "Continue from this completed Fabric invocation.",
  when: ({ count }) => count("pi.edit") >= 1,
});
await pi.bash({ command: "pnpm test guard" });
return "Frontier Fabric invocation completed";
```

`when` is an optional pure synchronous predicate evaluated inside the Fabric guest. It receives immutable `{ calls, count(ref?) }` facts for every successful resolved bridge call completed earlier in that `fabric_exec` program, including `pi.*`, `extensions.*`, `mcp.*`, external providers, and computed `tools.call()` refs. `count()` counts all calls; `count("pi.edit")` counts one ref; `count(["pi.edit", "schema.commit"])` counts a set. Generic calls are recorded under their resolved target rather than `fabric.$call`, and failed calls do not count. A false predicate starts no child and fails clearly; the function itself never crosses the host bridge. Omit `when` for unconditional scheduling.

Inside the guest, `agents.handoff()` resolves to `{ scheduled: true, status: "deferred", boundary: "fabric_exec_end" }`; child output cannot be consumed by later code in that same Fabric invocation. At the outer boundary, Main's tool result is replaced with the compact completion `{ handedOff, completed, status, agent, implementation, error? }`. `model` is required, the target runner is Pi, and `worktree` is intentionally unavailable because implementation must remain visible in the caller's workspace. Optional fields are `task`, `name`, `transport`, `thinking`, `tools`, `timeoutMs`, `extensions`, `recursive`, and `schema`. The source session is not switched or historically rewritten.

### Automatic Fabric-boundary prewalk

`/fabric prewalk` is Fabric's automatic, prompt-free adaptation of Can Bölük's [Prewalk research](https://stencil.so/blog/prewalk), whose public in-place implementation ships in [oh-my-pi's `AgentSession`](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/session/agent-session.ts). Stencil and OMP use a todo-gated first edit/write as the exact model-switch boundary. Fabric intentionally uses a coarser atomic unit: the first successful monitored mutation marks the current outer `fabric_exec` for handoff, but every remaining call in that Fabric program still runs before the executor starts. This preserves Fabric's programmable multi-call transaction at the cost of literal one-edit equivalence. The published Prewalk benchmark results therefore describe the original mechanism, not this adaptation.

```text
/fabric prewalk
/fabric prewalk Implement the token guard and run its tests
/fabric prewalk --status
/fabric prewalk --off
```

With a task, Fabric arms prewalk and submits that task to Main immediately. Without one, it captures the next user input as the task. The dedicated `prewalk.model` setting is the executor; set it under `/fabric settings` → **Prewalk**. When unset in an interactive session, Fabric asks the user to choose a Pi model while arming. Non-interactive sessions must configure `prewalk.model` first.

Prewalk adds no system-prompt instructions. The host watches resolved Fabric actions for at least one successful `pi.edit`, `pi.write`, or `schema.commit`. A match makes that outer invocation eligible, but it does not abort, serialize, or suppress any later nested call. The complete sequential or parallel program runs with ordinary Fabric semantics, and the handoff is claimed only after execution settles.

The host then issues a static handoff call without asking Main to invoke it:

1. Claims and disarms the one-shot prewalk after the Fabric program settles.
2. Lets Pi finalize all outer `tool_result` middleware.
3. Forks the native assistant `fabric_exec` call plus its exact native result.
4. Spawns the selected executor in the shared workspace and waits.
5. Replaces Main's visible tool result with the executor completion.

The outer tool is already marked `terminate: true` when the request is staged, so Main performs no automatic post-tool inference. A handoff failure is likewise terminal for that outer invocation and is returned as its failed result. If the captured task settles without a monitored trigger, prewalk disarms instead of leaking into the next task; an arm with no captured task keeps waiting for the next user input. An explicit successful `agents.handoff()` suppresses the automatic duplicate. Prewalk currently requires enabled subagents and full code mode, and is unavailable in Schema enforce mode.

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
| `herdr`     | One background Herdr tab per child                         | `herdr terminal attach …`    |
| `auto`      | Tries Herdr, LocalTerm, tmux, screen, then process         | transport-specific           |

Herdr uses its local socket API to create an argv-backed background tab atomically, without shell quoting or focus changes. Automatic selection is enabled only when the parent Pi process is already inside Herdr (`HERDR_ENV=1` with an injected workspace and socket); select `transport: "herdr"` under the same conditions. Each child can be opened directly with the attach command in its handle.

LocalTerm already exposes the needed tmux-parity primitives: detached creation, pinning, listing, capture, exec, attach, and kill. Pi Fabric therefore requires no LocalTerm patch. Start its daemon before selecting it:

```bash
localterm start
```

Use `/fabric agents` to list children and `/fabric attach <id>` to display the appropriate attach command. Abort signals propagate to the transport and selected child process. When a program uses orchestration entry points (`agent`/`workflow.agent`, `agents.run`/`agents.wait`/`agents.ask`, `council.run`, `rlm.query`)—including `agents.*` refs invoked through `tools.call()` and refs computed at runtime—Fabric raises the whole-program `executor.timeoutMs` to at least `subagents.timeoutMs`, so the parent deadline cannot stop children that are still within their own per-agent budget.

Set `worktree: true` to create a dedicated Git worktree and `pi-fabric/<name>-<id>` branch. Worktrees are retained for inspection until `agents.cleanup()` is called. Fabric passes the absolute project and mesh roots into every Pi child, so a recursive child in a worktree remains in the same participant directory instead of creating a second `.pi/fabric/mesh` under that worktree.

## Unified participants and steering

Fabric has one project participant directory. Every live entity has an intrinsic `kind` (`root`, `agent`, or `actor`), a `rootId`, an optional `parentId`, an `ownerHostId`, and an authenticated owner identity naming the process that controls its lifecycle. **Main** is the local user-facing view of one root; **Peers** are compatibility views of the other roots. They are not separate registries or control planes.

`agents.self()` returns the caller's participant record. `agents.members({ scope?, kinds?, includeStale? })` lists all kinds; `agents.list({ scope? })` lists agents and defaults to `scope: "local"`. Use `"lineage"` for descendants of the same root across recursive runtimes and `"project"` for every live project agent. `agents.main()` and `agents.peers()` remain convenient root projections. Normal discovery hides every participant whose execution-host lease expired. Shared summaries contain operational metadata but never agent prompts, results, or errors.

```ts
const main = await agents.main();
const project = await agents.members({ scope: "project" });
const peerRoot = project.find(
  (participant) => participant.kind === "root" && participant.id !== main.id,
);
if (peerRoot) {
  await agents.steer({ id: peerRoot.id, message: "Coordinate on the shared migration." });
}
await agents.followUp({ id: main.id, message: "After the audit, reconcile the findings." });

const lineage = await agents.list({ scope: "lineage" });
return { self: await agents.self(), lineage };
```

For Main and one-shot agents, `steer` is delivered after the current turn's tool calls and before the next model call; `followUp` waits for the current run to settle. For an actor, both enqueue its serial mailbox. `agents.status({ id })` accepts any participant id, returning full detail for a local run/actor and a bounded directory summary for a remote participant. `agents.setSteeringMode`/`setFollowUpMode` remain local one-shot controls.

Local routing returns `"main"` or `"local"`. Cross-process `steer`, `followUp`, and `stop` resolve the target's exact owner, send an owner-addressed control command, and wait for a version/target/owner-identity-matched acknowledgement. Success returns `routed: "mesh", acknowledged: true`; unknown ids, stale owners, rejection, and timeout throw rather than reporting an unverified queue. The dashboard's `s`, `u`, and `x` actions use this same path. Cross-process control requires `mesh.enabled`. See [`references/agents.md`](../skills/fabric-exec/references/agents.md).

### Participant lifecycle subscriptions

Use durable source-qualified subscriptions when one participant must react to another participant's Pi or run lifecycle. Unlike `agents.status()`, subscriptions are host-managed and survive turns without asking a model to poll.

```ts
const [peer] = await agents.peers();
if (peer) {
  await agents.subscribe({
    from: peer.id,
    events: ["pi.agent_settled"],
    to: "main",
    delivery: "followUp",
    triggerTurn: true,
    once: true,
  });
}
```

`agents.subscribe` takes an exact source participant id (or `"main"` for the caller's root), one or more lifecycle events, an optional target (default Main), a `steer`/`followUp` delivery mode, an explicit `triggerTurn` policy, and optional `once`. Use `agents.subscriptions()` and `agents.unsubscribe({ id })` to inspect and remove routes. Subscriptions begin at the current mesh sequence rather than replaying old events, and their delivery cursor is durable across host restarts. Delivery is at-least-once if a host crashes after inserting the target message but before persisting its cursor; consumers can deduplicate side effects with the lifecycle event `id`.

Pi-specific events are namespaced as `pi.input`, `pi.agent_start`, `pi.agent_end`, `pi.turn_end`, `pi.agent_settled`, `pi.tool_error`, and `pi.session_compact`. Runner-neutral terminal events are `run.completed`, `run.failed`, `run.stopped`, and `run.timed_out`. Lifecycle envelopes intentionally contain source identity and bounded operational metadata rather than session transcripts.

A detached local `agents.spawn()` also has a narrower convenience path: when `subagents.notifyOnComplete` is enabled, terminal completion sends Main a triggered follow-up automatically. Calling `agents.wait()` makes it foreground work and suppresses that detached notification.

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
  triggerTurn: false,
  tools: ["read", "grep", "find", "ls"],
});
```

Claude actors can retain context, inspect/edit with mapped Claude Code tools, consume host events and mesh messages delivered by Fabric, and return text or directives. They cannot themselves call `fabric_exec`, `agents.*`, or `mesh.*`; use a Pi actor when the actor must recursively coordinate through Fabric. If Claude's private session has been removed, the next activation fails clearly rather than silently discarding actor context. Recreate the actor to start a fresh Claude session.

This is the primitive behind emergent supervisors and advisors; neither requires another extension. Host events include a bounded recent-session snapshot. Actors process messages one at a time, coalesce repeated host events by default, and restore with the trusted project actor registry.

`validWhile` adds a programmatic freshness guard for persistent actors. Fabric serializes its pure synchronous function source, checks it before starting queued work and before delivering completed work, and persists it with project actors and global templates. The immutable `activation` fact is a `hostEvent`, `direct`, or `mesh` activation; `current` contains `latestActivationSequence`, `mainRevision`, `taskRevision`, `idle`, and `now`. Main revisions advance on completed tools and lifecycle events, so a tool-error review can become stale after Main recovers. Return `false` or `{ valid: false, reason? }` to suppress stale work. Invalidated fire-and-forget work is recorded as a silent stale outbox entry; an invalidated `agents.ask()` rejects. Predicates cannot be async, call tools, or depend on closures because their source must execute after restoration.

```ts
return agents.create({
  name: "fresh-reviewer",
  instructions: "Review only the latest useful parent-session event.",
  events: ["tool_error", "agent_settled"],
  responseMode: "directive",
  delivery: "steer",
  triggerTurn: false,
  validWhile: ({ activation, current }) => {
    if (activation.kind !== "hostEvent") return true;
    if (activation.sequence !== current.latestActivationSequence) {
      return { valid: false, reason: "a newer activation exists" };
    }
    if (activation.event === "tool_error") {
      const signal = JSON.stringify(activation.signal ?? {});
      const incidental = /ENOENT|no matches found|exit code 1/i.test(signal);
      if (incidental && activation.mainRevision !== current.mainRevision) return false;
    }
    return activation.taskRevision === current.taskRevision;
  },
});
```

Pi actors keep model context in their Fabric-owned Pi session file. Claude actors persist the session ID emitted by the official CLI, reapply tools/permissions/schema/system-prompt flags on every activation, and use `--resume <id>` after the first message; Fabric also keeps a runner-neutral stream transcript instead of reading Claude's private JSONL format. Each actor's reasoning effort is its `thinking` level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`), defaulting to `subagents.thinking` (`medium`); set it at creation or change it later with `e` from the dashboard. Its `tools` array is a persisted allowlist: set it at creation, replace it with `agents.setTools({ id, tools })`, or press `o` in the dashboard. An empty list disables optional tools; Pi actors retain the host-required `fabric_exec` capability for mailbox and mesh coordination unless created with `extensions: false`. Set `extensions: false` at creation to opt a Pi actor out of Fabric entirely — the activation runs without `fabric_exec`, `agents.*`, or `mesh.*`, while the host still manages its mailbox and delivery. This does not make the actor read-only by itself: `tools` still defaults to `subagents.defaultTools`. For a read-only persistent actor, also set `tools: ["read", "grep", "find", "ls"]`; use `tools: []` for an actor with no tools.

### Response modes and delivery

Two response modes are available:

- `text`: every non-empty response becomes an actor outbox message.
- `directive`: validated `{ action: "silent" | "message" | "stop", message?, data? }` output lets the actor decide whether intervention is useful.

Delivery can remain in `mailbox` or enter the main session as `steer`, `followUp`, or `nextTurn`. `steer` and `followUp` require an explicit `triggerTurn: true | false`: `true` starts Main when it is idle, while `false` is passive and is visibly labeled as not starting Main. `mailbox` and `nextTurn` never start Main and reject `triggerTurn: true`. This explicit policy prevents a delivered actor message from looking like a stalled continuation.

The actor cannot escalate delivery in its own response, but the owner can update a live actor or global template without losing history:

```ts
await agents.setDeliveryPolicy({
  id: actor.id,
  delivery: "steer",
  triggerTurn: true,
});
```

Pass `scope: "global"` to update a reusable template. In the dashboard, press `y` on an actor or template to choose among mailbox, passive/active steer, passive/active follow-up, and next-turn delivery. Use `agents.setModel({ id, model? })` and `agents.setThinking({ id, thinking? })` to migrate a persistent actor for its next activation without replacing its Pi/Claude runner session; omit the override to return to configured defaults. Use `agents.ask()` for a blocking exchange, `agents.tell()` for fire-and-forget mail, `agents.messages()` for history, and `agents.remove()` for cleanup.

## Paged agent logs

`agents.log()` reads JSONL logs in bounded pages instead of loading the complete file. The first call returns the newest entries. When `hasMore` (or `sessionHasMore` for an actor session) is true, pass the returned `before` (or `sessionBefore`) cursor to load the next older page:

```ts
const newest = await agents.log({ id, type: "run", lines: 100 });
if ("before" in newest && newest.hasMore) {
  const older = await agents.log({ id, type: "run", lines: 100, before: newest.before });
  return older;
}
return newest;
```

Log-line `offset` values and page cursors are byte offsets into the JSONL file.

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

// Refine a template's default instruction and continuation policy.
await agents.setInstructions({ id: template.id, instructions: "Be brief.", scope: "global" });
return agents.setDeliveryPolicy({
  id: template.id,
  delivery: "steer",
  triggerTurn: false,
  scope: "global",
});
```

`agents.setInstructions` also edits a live project actor (`scope: "project"`, the default); the new instruction takes effect on the actor's next queued message. History never crosses the project⇄global boundary — import and export move only the definition. Slash commands mirror the API: `/fabric global` lists templates, `/fabric import <name> [as <new>]` stamps one into the project, and `/fabric export <id> [--overwrite]` promotes a project actor. The dashboard lists global templates alongside live actors and lets you import, export, delete, edit instructions, and change delivery policy without writing code. Legacy persisted actors/templates still load as passive, but new active delivery definitions must state `triggerTurn` explicitly.

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

Topics provide durable channel and direct-message semantics with sequence cursors. `mesh.members({ scope?, kinds? })` returns the same unified root/agent/actor directory as `agents.members()`. Versioned `get`/`put`/`delete` operations provide compare-and-swap state for task claims, leases, reservations, and decisions. Together with persistent actors, these are sufficient to express messenger-style swarms in Fabric code without a daemon or fixed planner/worker roles. See [`/skill:fabric-swarm`](../skills/fabric-swarm/SKILL.md) for the pattern and [`references/mesh.md`](../skills/fabric-exec/references/mesh.md) for the full API.
