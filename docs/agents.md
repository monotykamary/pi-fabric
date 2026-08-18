# Agents, actors & mesh

Fabric exposes its multi-agent runtime through the model-facing APIs in [`skills/fabric-exec/references/agents.md`](../skills/fabric-exec/references/agents.md) and [`mesh.md`](../skills/fabric-exec/references/mesh.md). Reusable patterns are in the [skills](../skills/): `fabric-workflow`, `fabric-swarm`, `fabric-council`, `fabric-rlm`, `fabric-supervisor`, `fabric-advisor`, and `fabric-fusion`. For the `agents` and `mesh` settings, see [configuration](configuration.md).

## Workflows

Fabric programs keep orchestration and intermediate values in code. The workflow globals provide Claude Code-style names and progress phases without adding another JavaScript runtime.

Use these helpers:

- Use `workflow.agent(prompt, options)` or `agent(...)` to start one worker. Set `label` on each call.
- Use `workflow.parallel(thunks, { concurrency })` or `parallel(...)` for fan-out. Supply functions to these APIs.
- Use `workflow.pipeline(items, ...stages)` or `pipeline(...)` to run sequential stages for each item with concurrency across items.
- Use `workflow.configure({ name, description })` to name the activity surface.
- Use `workflow.phase(name, { id?, description?, total? })` or `phase(...)` to define progress groups.
- Use `workflow.item(...)` for non-agent work items that change status over time.
- Use `workflow.event(...)` to record important milestones in the dashboard feed.
- Use `workflow.log(...)` to add short progress notes.
- Read `workflow.budget` for token-budget observations.

You can give `fabric_exec` optional `agentBudget` and `tokenBudget` limits. Configuration sets a hard agent limit for each execution. Add a JSON Schema to an agent request to make the worker return validated structured data in `result.value`. Workflow helpers return this value directly. Without a schema value, they return the agent's final text. See [`/skill:fabric-workflow`](../skills/fabric-workflow/SKILL.md) for the complete pattern.

## Agents

```ts
const result = await agents.run({
  name: "security-review",
  task: "Review the current diff for concrete security defects. Do not edit files.",
  transport: "localterm",
  tools: ["read", "grep", "find", "ls"],
});
return result;
```

Create background handles explicitly:

```ts
const handle = await agents.spawn({
  task: "Map the persistence layer and identify its public entry points.",
  transport: "tmux",
});

// Continue with independent work here.

return await agents.wait({ id: handle.id });
```

Set `cwd` on `agents.run()` or `agents.spawn()` to choose the leaf child's filesystem execution directory. Absolute paths are accepted; relative paths resolve from the parent Fabric manager's cwd. Fabric canonicalizes the directory (including symlinks) before launch, and reports that effective path in the handle, status, participant snapshot, result, and log status. Invalid, missing, inaccessible, or non-directory paths fail without falling back to the parent. The option is also forwarded by workflow helpers and `council.run()`. It is not available on recursive `rlm.query()`, persistent actors, or trajectory handoff; recursive agents must omit `cwd`.

For Pi children, selecting `cwd` neither grants nor requires project trust. Fabric adds no trust gate and passes neither `--approve` nor `--no-approve`; Pi loads `AGENTS.override.md`, `AGENTS.md`, and `CLAUDE.md` under its normal context rules, while protected project resources remain governed by Pi's saved decisions and `defaultProjectTrust`. Each runner keeps its native startup behavior. A generated worktree is evaluated at its own canonical path.

### Durable participant residency

`agents.spawn()` and `agents.create()` accept `residency: "session" | "durable"`. The default is `session`. It keeps the usual lifecycle: the current Pi host owns the participant and stops or suspends it when the host shuts down. The model chooses `durable` during execution. Users do not configure it as a setting.

```ts
const audit = await agents.spawn({
  name: "integration-audit",
  task: "Run the integration audit and report concrete failures.",
  residency: "durable",
  tools: ["read", "grep", "find", "ls", "bash"],
});

const supervisor = await agents.create({
  name: "migration-supervisor",
  residency: "durable",
  instructions: "Process migration messages until verification succeeds.",
  topics: ["team.migration"],
  delivery: "followUp",
  triggerTurn: true,
});

await agents.tell({ id: supervisor.id, message: "Own the remaining migration." });
return { audit, supervisor };
```

The first durable request starts one hidden resident host for the current root when needed. Fabric transfers actor ownership to this host or starts the one-shot run there. It publishes the owner in the standard participant directory. Fabric routes `steer`, `followUp`, `tell`, blocking `ask`, and `stop` through the acknowledged mesh control plane. The process uses the captured agent, mesh, timeout, recursion, and cost-ceiling configuration. It also uses the runner, model, and tool capabilities that the originating call explicitly authorized. Users do not configure a daemon profile or workflow policy.

The original TUI can shut down after the transfer. Durable agents continue until they reach a terminal status. A resumed copy of the same root can call `agents.status`, `agents.wait`, `agents.log`, and `agents.cleanup`. The mesh stores terminal notifications and active actor deliveries until Main resumes. Durable actors keep their registry definition, mailbox history, runner session, mesh subscriptions, and replay cursor. Main relays session-bound host events while it is available. The cross-process relay can omit oversized raw image blocks. The relay keeps their redacted media descriptors.

A durable actor has one resident execution owner. Other trusted sessions in the project can call `ask`, `tell`, `steer`, `followUp`, and `stop`; Fabric routes each call to that owner. Direct messages carry the caller's model and thinking binding. Actor status, mailbox history, logs, and definition export are shared project views. Only the owner can clear the mailbox or change tools, events, instructions, delivery policy, and project defaults. Fabric sends durable actor removal to the resident owner. The hidden host exits after a short idle grace when it owns no live durable actor or running durable agent. Durable residency requires a trusted project and `mesh.enabled`. Schema enforce mode does not support it.

### Trajectory-preserving handoff

A handoff delegates work from Pi to Pi through a real fork of the caller's active session branch. It blocks while the delegated work runs. The worker receives more than a task string. One complete `fabric_exec` invocation forms the atomic frontier unit. An explicit `agents.handoff()` call records a deferred request in the guest. It does not create a child or stop the program at that line. Later sequential and parallel calls continue as usual.

Pi finalizes the native outer `fabric_exec` tool result after the complete Fabric program returns. At the `message_end` boundary, Fabric forks through the original assistant entry that contains the native `fabric_exec` call. It appends the exact finalized native `toolResult` to the child branch. Fabric then starts the selected executor in the same workspace and waits before Pi performs another Main inference. The child sees the outer call and frontier result exactly as finalized before handoff replacement. This context includes the Fabric source, output, and persisted trace. Fabric does not rewrite nested calls as synthetic assistant turns. It materializes an in-memory source in the same native Pi session format.

Fabric sets no special count or size limit for handoffs. The normal `fabric_exec` output and trace projection limits apply before the boundary. Handoff fails closed when Fabric cannot identify the active outer turn or when that turn belongs to an incomplete parallel top-level tool batch.

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

`when` is an optional pure synchronous predicate that runs inside the Fabric guest. It receives immutable `{ calls, count(ref?) }` facts for each successful resolved bridge call that finished earlier in the same `fabric_exec` program. These calls include `pi.*`, `extensions.*`, `mcp.*`, external providers, and computed `tools.call()` refs. `count()` counts all calls. `count("pi.edit")` counts one ref. `count(["pi.edit", "schema.commit"])` counts a set. Fabric records each generic call under its resolved target. Fabric excludes failed calls. A false predicate does not start a child and reports a clear failure. The function never crosses the host bridge. Omit `when` to schedule unconditionally.

In the guest, `agents.handoff()` resolves to `{ scheduled: true, status: "deferred", boundary: "fabric_exec_end" }`. Code later in the same Fabric invocation cannot consume the child output. At the outer boundary, Fabric replaces Main's tool result with the compact completion `{ handedOff, completed, status, agent, implementation, error? }`. The `model` field is required. The target runner is Pi. The `worktree` field is unavailable because the implementation must remain visible in the caller's workspace. You can also set `task`, `name`, `transport`, `thinking`, `tools`, `timeoutMs`, `extensions`, `recursive`, `schema`, and `compact`. Fabric does not switch or rewrite the history of the source session.

**Trajectory compaction.** Set `compact` to give the executor a compacted transcript in place of the full raw branch. A value of `true` applies the default summary. Use `{ instructions?, preserve? }` to add compaction instructions of up to 8K characters and as many as 16 explicit preserve facts of up to 2K characters each. These limits match `compact.request`. Fabric writes the child session with a deterministic Fabric compaction entry before the boundary result. The executor context starts with the projected summary. It then contains the retained tail from the calculated cut point and the outer `fabric_exec` result. The append-only child file keeps the complete raw branch below the compaction marker. Fabric records the outcome under `compaction` in the child's `pi-fabric-handoff` custom entry. The outcome contains `applied`, sections, tokens, and cut point. If Fabric skips compaction, it gives the skip reason. Omit `compact` to keep the fork verbatim.

### Automatic Fabric-boundary prewalk

`/fabric prewalk` adapts Can Bölük's [Prewalk research](https://stencil.so/blog/prewalk) for Fabric. OMP changes models inside one live agent loop at the first edit or write that a todo gates. Fabric uses a coarser atomic boundary. The first successful monitored mutation marks the current outer `fabric_exec`. All remaining nested calls settle before prewalk continues. This behavior preserves programmable sequential and parallel Fabric semantics.

```text
/fabric prewalk
/fabric prewalk Implement the token guard and run its tests
/fabric prewalk --status
/fabric prewalk --off
```

When you supply a task, Fabric arms prewalk and immediately submits the task to Main. Without a task, it captures the next user input. Select the executor in `/fabric settings` under **Prewalk**. **Always re-arm** uses `prewalk.model` to arm prewalk automatically at each session start without interaction. It also arms prewalk after each completed handoff. `/fabric prewalk --off` cancels it until the next session starts.

The default value of `prewalk.mode` is `"in-place"`:

1. Fabric detects a successful `pi.edit`, `pi.write`, or `schema.commit`, then lets the full outer program settle. A successful `pi.bash` can also trigger detection when no audited mutation occurred. In that case, a stat-baseline diff of the work tree identifies shell writes such as heredocs, `sed -i`, and formatter binaries as a filesystem trigger (`fs.drift`). Set `prewalk.detectShellWrites` to `false` to disable this behavior.
2. At the finalized outer result boundary, Fabric selects `prewalk.model` on Main.
3. Fabric queues a hidden follow-up. It tells Main to continue the current task, complete the remaining implementation, check related call sites, and run verification.
4. The terminating outer tool prevents an automatic turn on the old model. Pi drains the queued follow-up and continues the same Main session on the executor model.
5. After the continuation settles, Fabric compacts the session with the configured compaction engine. Set `prewalk.compactOnReturn` to `false` to skip this step. Fabric then restores the Main model captured at the boundary.

In-place mode uses Main directly and keeps one transcript. It works with `agents.enabled` set to `false`. Pi's public extension model switch also changes the default model setting, so restoring the captured Main model repairs that default. A switch can fail before continuation when the model is unavailable or unauthenticated. The outer result then reports the cause. Fabric queues a hidden follow-up that asks Main to report the failure and propose the next action.

Set `prewalk.mode` to `"trajectory"` to use child-based behavior. Fabric forks the exact finalized outer call and result into a Pi child. It starts the selected executor in the shared workspace and waits. When the child finishes, Fabric replaces the boundary result with the executor report and queues a hidden continuation. Main verifies the implementation with the applicable checks and provides a summary. It does not repeat completed executor work, and it relays links, PR numbers, and commit hashes verbatim. If the child fails, stops, or times out, Fabric queues a hidden follow-up that reports the result and proposes an action. Main always tells the user how execution ended and what the child completed. Every boundary reports a result. The executor uses `prewalk.thinking` for reasoning effort. When unset, it inherits `agents.thinking`. The parent Fabric card and activity UI display the synthetic `agents.handoff` call, child identity, live status or current tool, nested preview, metrics, and terminal result. Users can see progress during the wait. Trajectory mode requires enabled agents. Explicit `agents.handoff()` also uses this behavior.

**Thinking transfer across models.** Providers define the shape of stored thinking blocks. Codex uses encrypted reasoning items. Anthropic requires valid signatures. Replaying these blocks to another provider can place them in unusable request fields or cause failure. Fabric applies a family policy when it writes the trajectory child session. It uses `preserved` when the executor has the same provider and API family as the source model. For openai-completions reasoning targets, it uses `re-signed`. This policy keeps the thinking text and normalizes the signature to `reasoning_content`, which lets preserve-thinking servers receive earlier reasoning. For other targets, Fabric uses `stripped`. Fabric removes the thinking blocks and foreign thought signatures, then adds a bounded digest custom message with entry IDs for continuity. The digest covers deliberation only. Fabric records the policy and counts under `thinkingTransfer` in the child's `pi-fabric-handoff` custom entry. In-place prewalk cannot rewrite Pi's session log. When channels are incompatible, it sends the same digest in a hidden follow-up. Fabric never modifies the source session.

Prewalk does not add system-prompt instructions. It queues its hidden continuation only after a matching mutation boundary. The continuation is not an open-ended prompt on each turn. A turn that settles without a handoff leaves prewalk armed. A matching mutation consumes the arm through an in-place switch or trajectory spawn. A completed explicit `agents.handoff()` also consumes it, as does `/fabric prewalk --off`. Fabric drops the settled turn's captured task text so that it captures the next prompt as new input. Both modes require full code mode. Schema enforce mode does not support them.

The filesystem fallback compares each file's size and mtime with a baseline captured when prewalk was armed. Fabric refreshes the baseline after every considered boundary and settle. In Git work trees, it lists files through the index, so ignored build output does not register. In trees without Git, it walks the files and skips only `.git` and `node_modules`. Artifact writes then count as drift. The diff cannot identify who made a change. An external editor save during a bash-running window also counts. The fallback scans only programs that ran `pi.bash`, so read-only turns have no scan cost and cannot trigger it. Stat drift can occur without a content change, for example from rare `touch` churn. This drift triggers prewalk. The report lists affected files in `trigger.files`.

### Claude Code runner

Install and authenticate the official Claude Code CLI (`claude`) through its normal process. Fabric calls this binary directly. Select it for one call or for all calls:

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

`agents.models({ runner: "claude" })` requests the initialization model catalog from the installed CLI. The catalog includes aliases, resolved IDs, descriptions, and supported effort levels. Fabric does not hard-code this list. The handshake sends no user prompt or model inference request, so discovery has no model charge. The call starts the configured local binary. Starting the local binary gives model-authored `agents.models` calls Fabric's `execute` risk. Fabric caches the catalog for 60 seconds. Claude model keys have the form `claude/<runtime-value>`, such as `claude/default`, `claude/sonnet`, and `claude/haiku`. Fabric removes this namespace before passing the value to `--model`.

Claude runs call `claude -p` with stream-JSON input and output, partial messages, `--permission-mode dontAsk`, `--tools`, and `--allowedTools`. Fabric converts its portable core allowlist as shown below:

| Fabric tool  | Mapped Claude Code tool |
| ------------ | ----------------------- |
| `read`       | `Read`                  |
| `grep`       | `Grep`                  |
| `find`, `ls` | `Glob`                  |
| `bash`       | `Bash`                  |
| `edit`       | `Edit`                  |
| `write`      | `Write`                 |

Unknown tools cause failure before launch. Set `extensions: false` to start Claude in safe mode. The default value, `true`, keeps the user's standard Claude Code customizations. The explicit tool list continues to control the tools that the model can use. JSON schemas use Claude's native `--json-schema`. Fabric normalizes usage, cost, turns, tool activity, errors, and Claude's session ID into the standard Fabric result and dashboard transcript. It adds `--no-session-persistence` to one-shot runs.

Claude-backed children have no recursive Fabric capabilities. Fabric rejects `recursive: true`, `fabric_exec`, and direct `mesh.*` access. Choose `runner: "pi"` for RLM or recursive Fabric. For host-managed mailbox and event coordination, use a persistent actor backed by Claude.

### Veda runner

The `veda` runner starts the [Veda CLI](https://github.com/kennyfrc/veda) as a one-shot headless child. Install and authenticate the configured backend CLI with its normal procedure. Veda can use `agy`, `codex`, `claude-code`, `droid`, `pi`, and any backend that the installed Veda build registers. Fabric invokes `agents.veda.binary` with `-b <backend> -p <persona> --json`. It sends the task through stdin:

```ts
return agents.run({
  runner: "veda",
  persona: "frontend", // select a built-in or custom Veda persona
  model: "agy/gemini-3.1-pro-high", // send this value to the configured backend
  task: "Review the current implementation for architectural risks. Do not edit files.",
  tools: ["read", "grep", "find", "ls"],
});
```

Fabric forwards Veda model values unchanged to the selected backend. Use `agents.veda.model` to set a backend-specific default. An explicit `agents.run({ model })` value has priority. If you omit both values, Veda selects its own backend default. Personas do not depend on models. Add custom personas at `~/.config/veda/personas/<name>/AGENTS.md`. Set the global default with `agents.veda.persona`, or select a persona for one run with `agents.run({ persona })`. `agents.models({ runner: "veda" })` currently returns an empty advisory list. Fabric normalizes usage (`inputTokens`/`outputTokens`/`cachedTokens`), backend conversation ID, turns, and errors from the Veda `--json` envelope. The data appears in the standard Fabric result, dashboard, lifecycle events, and budget ledger.

For each run, Fabric passes `--tools <allowlist>`. It passes `--no-tools` for an empty allowlist. This setting has priority over tool frontmatter in the persona. The built-in read-only personas specify `tools: none`. The `worker` persona specifies `tools: all` with `sandbox: workspace-write`. Fabric does not pass `--sandbox`, so persona frontmatter defines the sandbox, and `worker` agents can change files. The `navigator-plan` persona also requires a `<program>` design block, and `worker` requires a `<worker_report>`. A failure in either protocol appears as a run error, so `navigator-chat` is the default for free-form tasks.

Each run gets an isolated `fabric-<run-id>` Veda session through `-S` and `--no-sel`. Parallel children cannot share selection or conversation state. Veda stores these sessions under `.veda/sessions/` at the project root. Outside a Git repository, it uses `~/.config/veda`. This repository includes `.veda/` in `.gitignore`.

Veda children do not have recursive Fabric capabilities. Fabric rejects `recursive: true`. Veda does not support steering, so steer and follow-up calls throw when called. It also cannot run persistent actors because each invocation executes one headless prompt. Use `runner: "pi"` when you need recursive Fabric or persistent coordination.

### Transports

| Transport   | Operation                                                     | Command to attach            |
| ----------- | ------------------------------------------------------------- | ---------------------------- |
| `process`   | Runs a detached local worker process with the lowest overhead. This is the default transport | none |
| `tmux`      | Creates one detached tmux session for each child              | `tmux attach-session -t …`   |
| `screen`    | Creates one detached GNU Screen session for each child        | `screen -r …`                |
| `localterm` | Creates one pinned LocalTerm PTY for each child               | `localterm session attach …` |
| `herdr`     | Creates one background Herdr tab for each child               | `herdr terminal attach …`    |
| `auto`      | Tries Herdr, LocalTerm, tmux, screen, and then process         | Depends on the transport     |

Herdr uses its local socket API to create an argv-backed background tab as one atomic operation. It does not change focus or require shell quoting. Automatic selection works only when the parent Pi process already runs in Herdr. This requires `HERDR_ENV=1` with an injected workspace and socket. Select `transport: "herdr"` under the same conditions. Use the attach command in the handle to open a child directly.

LocalTerm provides the required primitives that match tmux: detached creation, pinning, listing, capture, exec, attach, and kill. Pi Fabric requires no LocalTerm patch. Start the daemon before you select this transport:

```bash
localterm start
```

`/fabric agents` lists the children. Run `/fabric attach <id>` to show the correct attach command. Abort signals propagate to the transport and the selected child process. When a program uses orchestration entry points such as `agent`/`workflow.agent`, `agents.run`/`agents.wait`/`agents.ask`, `council.run`, or `rlm.query`, Fabric increases the whole-program `executor.timeoutMs` to at least `agents.timeoutMs`. The same increase applies to `agents.*` refs called through `tools.call()` and to refs calculated at runtime. The parent deadline then cannot stop a child that remains within its own agent budget.

Set `worktree: true` to create a dedicated Git worktree and a `pi-fabric/<name>-<id>` branch from the repository containing the selected `cwd`. Fabric retains worktrees for inspection until you call `agents.cleanup()`. When the selected cwd is a repository subdirectory, Fabric uses the matching subdirectory in the generated worktree when it exists; otherwise it uses the worktree root. The reported effective cwd is the generated worktree path, and Pi evaluates that generated path as its own canonical cwd. The caller's project and mesh roots remain unchanged, so a child targeting another repository still belongs to the orchestrating Fabric topology. A recursive child in a worktree stays in the same participant directory and does not create another `.pi/fabric/mesh` inside that worktree.

[Model-guidance components](components.md#model-facing-guidance-components) can target participants by canonical provider/model. Direct agents and actors retain their role prompt and receive matching append guidance after it. Recursive Pi children load the project components and resolve their own replaceable Fabric execution slot, so the parent does not duplicate guidance. Durable owners use the latest atomically committed guidance snapshot for each launch. Guidance changes prompts only; it cannot widen tools, approvals, or committed capabilities. Task text, message envelopes, run IDs, and timestamps stay out of the guidance system prompt, so repeated runs with the same role, model, and component projection retain a byte-stable prefix.

## Unified participants and steering

Fabric uses one participant directory for each project. Every live entity has a fixed `kind` of `root`, `agent`, or `actor`. It also has a `rootId`, an optional `parentId`, an `ownerHostId`, and an authenticated owner identity for the process that controls its lifecycle. **Main** is the local user-facing view of one root. **Peers** provide compatibility views of the other roots. These views do not use separate registries or control planes. **Fabric reserves Peer for another root Pi session. The term never means a child agent.** When asked about a peer, call `agents.peers()` first. `agents.list()` reports only child agents, so it cannot determine whether a peer root has settled.

`agents.self()` returns the participant record for the caller. Call `agents.members({ scope?, kinds?, includeStale? })` to list all kinds. `agents.list({ scope? })` lists agents and uses `scope: "local"` by default. Set the scope to `"lineage"` for descendants of the same root across recursive runtimes. Use `"project"` for all live project agents. `agents.main()` and `agents.peers()` provide convenient root projections. Standard discovery hides participants with expired execution-host leases. Shared summaries include operational metadata. They exclude agent prompts, results, and errors.

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

For Main and one-shot agents, `steer` arrives after the tool calls in the current turn and before the next model call. `followUp` waits until the current run settles. For actors, both operations add a message to the serial mailbox. `agents.status({ id })` accepts any participant ID. It returns complete details for a local run or actor and a bounded directory summary for a remote participant. `agents.setSteeringMode` and `setFollowUpMode` continue to control local one-shot runs.

Local routing returns `"main"` or `"local"`. For cross-process `steer`, `followUp`, and `stop`, Fabric resolves the exact owner of the target. It sends a control command addressed to that owner and waits for an acknowledgement that matches the version, target, and owner identity. Success returns `routed: "mesh", acknowledged: true` after this verified acknowledgement. Unknown IDs, stale owners, rejection, and timeout throw an error. The dashboard actions `s`, `u`, and `x` use the same route. Set `mesh.enabled` to use cross-process control. See [`references/agents.md`](../skills/fabric-exec/references/agents.md).

### Participant lifecycle subscriptions

Use durable, source-qualified subscriptions when one participant must respond to the Pi or run lifecycle of another participant. Subscriptions differ from `agents.status()` because the host manages them across turns. The model does not need to poll.

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

`agents.subscribe` accepts an exact source participant ID. You can use `"main"` for the caller's root. Supply one or more lifecycle events and an optional target, which defaults to Main. Set a `steer` or `followUp` delivery mode, an explicit `triggerTurn` policy, and the optional `once` flag. Inspect routes with `agents.subscriptions()`, and remove one with `agents.unsubscribe({ id })`. A subscription starts at the current mesh sequence and does not replay earlier events. Its delivery cursor remains durable across host restarts. Delivery is at least once when a host crashes between inserting the target message and saving the cursor. Consumers can use the lifecycle event `id` to deduplicate side effects.

Pi events use these names: `pi.input`, `pi.agent_start`, `pi.agent_end`, `pi.turn_end`, `pi.agent_settled`, `pi.tool_error`, and `pi.session_compact`. Runner-neutral terminal events use `run.completed`, `run.failed`, `run.stopped`, and `run.timed_out`. The `tokens.usage` event provides bounded usage. The `component.state` event reports supervised component transitions. Lifecycle envelopes contain source identity and bounded operational metadata. They do not contain session transcripts.

A detached local `agents.spawn()` has a smaller convenience route. When `agents.notifyOnComplete` is enabled, terminal completion automatically sends Main a triggered follow-up. A call to `agents.wait()` makes the run foreground work and disables that detached notification.

## Persistent actors

`agents.create()` makes a named actor. The actor has a fixed runner, persistent runner session, serial mailbox, and optional subscriptions to parent-session events or durable mesh topics:

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
  requires: ["memory.recall", { ref: "mcp.github.search", optional: true }],
});
```

A host-managed Claude actor uses the same mailbox and event interface. It keeps Claude Code context between activations:

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

Claude actors can keep context and use mapped Claude Code tools to inspect or edit. They consume host events and mesh messages that Fabric delivers, then return text or directives. They cannot directly call `fabric_exec`, `agents.*`, or `mesh.*`. Use a Pi actor when the actor must coordinate recursively through Fabric.

### Shared actors and session bindings

`mesh.actorScope: "project"` stores one actor definition for the project. Fabric keeps three pieces of state:

- **Project definition.** The shared registry stores the actor ID, instructions, runner, subscriptions, tools, and project model and thinking defaults.
- **Session binding.** A mode-`0600` file stores only `model` and `thinking` for one Pi session ID. It survives a resume of that session and does not rewrite `actors.json`.
- **Runtime.** One owner keeps the stable actor identity, serial mailbox, and runner session. Other sessions send direct work to that owner.

Fabric resolves each activation in this order:

```text
call override → session binding → project default → Fabric or runner default
```

```ts
// Change only this Pi session.
await agents.setModel({ id: actor.id, model: "anthropic/claude-sonnet-4-6" });
await agents.setThinking({ id: actor.id, thinking: "low" });

// Override one call without changing the session binding.
await agents.ask({
  id: actor.id,
  message: "Review the release diff.",
  model: "anthropic/claude-opus-4-6",
  thinking: "high",
});

// Change the shared project default. This requires the runtime owner.
await agents.setModel({
  id: actor.id,
  model: "anthropic/claude-sonnet-4-6",
  scope: "project",
});
```

Omit `model` or `thinking` to clear the selected layer. A cleared session binding inherits the project default. A cleared project default inherits Fabric or runner configuration.

`FabricActorInfo.model` and `thinking` show the effective values for the caller. `binding` shows the session layer. `projectDefaults` shows the shared definition layer.

Fabric stores the resolved binding on each mailbox item before it queues. Later binding changes cannot alter a running activation or an older queued item. `ask` waits for the owner to return a result. `tell`, `steer`, and `followUp` enqueue through the same owner. Pi and Claude actors both support these direct-call bindings.

The mailbox, history, and runner session remain shared. Host events and mesh subscriptions run once on the owner and use the owner's session binding. Opening another Pi session does not start another copy of the actor.

Use `mesh.actorScope: "session"` when each Pi session needs its own definitions, mailbox, history, and runtime. Under project scope, every trusted session can read shared actor definitions, mailbox history, and logs. Do not store secrets in them.

Use `requires` to declare exact `provider.action` capabilities for every activation. An entry can use `{ ref, optional: true }`. Before launch, the host resolves and keeps one view identified by its descriptor hash. Pi children separately resolve the portable semantic digest. They run with a closed-world Fabric surface, so a live provider addition cannot expand the actor during a run. When required refs are missing, mailbox work stays queued. `missingCapabilities` reports which capabilities are available, separately from `idle | queued | running | stopped`. Changes to providers or catalogs retry dispatch. Actor status and run metadata include the normalized requirements and last committed digest. Claude actors receive the host availability commitment. They have no child Fabric surface to limit. If the private Claude session was removed, the next activation reports a clear failure and preserves actor context. Recreate the actor when you need a new Claude session.

This primitive supports emergent supervisors and advisors without another extension. Actors can observe all session-bound public Pi extension events. These include resource discovery; session start, info, switch, fork, compaction, tree, and shutdown events; input and before-agent-start; agent, turn, and message lifecycle; context and provider request or response lifecycle; tool call, result, and execution lifecycle; model and thinking changes; and user bash. Event names match the Pi extension names, such as `input`, `before_agent_start`, `tool_call`, and `tool_result`. Fabric also adds the synthetic `tool_error`. The only exception is `project_trust`, which fires before Fabric can read the trusted project actor registry. Actors only observe intercepting Pi hooks. An actor runs asynchronously and cannot block a tool, rewrite context, change provider headers, or return another extension hook result. Shutdown observations and observations during immediate session replacement are best effort because the owner runtime is shutting down.

Fabric sanitizes host-event JSON before placing it in the mailbox. The JSON includes a bounded snapshot of the recent session. Fabric redacts fields that resemble credentials and encoded blobs. Pi `ImageContent` blocks follow another path. Fabric replaces every persisted block with an indexed descriptor. It sends the raw image outside the mailbox with the transient activation and automatically submits it to the selected Pi or Claude actor model. There is no media opt-in flag because the explicit event subscription defines the trust boundary. Raw image bytes never enter `actors.json` or the actor mailbox record. The selected runner's persistent model session can retain images through its standard session behavior. Use `activation.signal.media` to read descriptor metadata for freshness predicates and correlation.

Actors handle one message at a time. By default, they coalesce repeated host events, which is useful for `message_update` and `tool_execution_update`. They restore from the trusted project actor registry.

### Native asynchronous vision handoff

A vision handoff does not require a separate extension that watches events. Create one persistent actor, select a multimodal model, and subscribe to `input`. Fabric automatically detects and attaches images from the prompt. Passive `steer` sends the description to Main without starting an unrelated idle turn. Set `coalesce: false` to preserve separate image prompts while the vision actor is busy:

```ts
return agents.create({
  name: "vision-handoff",
  instructions: `Inspect every attached image from the parent prompt.
Return { action: "silent" } when no image is attached.
Otherwise return { action: "message", message } with a precise, compact visual description
that Main can use without seeing the image. Do not answer the user's broader coding task.`,
  events: ["input"],
  runner: "pi",
  model: "provider/multimodal-model", // use a key from tools.models()
  responseMode: "directive",
  delivery: "steer",
  triggerTurn: false,
  coalesce: false,
  validWhile: ({ activation }) =>
    activation.kind !== "hostEvent" || (activation.signal?.media?.length ?? 0) > 0,
  tools: [],
  extensions: false,
});
```

`validWhile` removes input activations without images before a model run. Ordinary text prompts use no vision-agent inference. The actor persists. Dispatch stays asynchronous. Main never waits for the visual description during its current inference. Subscribe to `before_agent_start` when the actor needs Pi's expanded prompt or system context. A subscription to both events creates two activations for one user prompt.

`validWhile` supplies a programmable freshness guard for persistent actors. Fabric serializes the source of its pure synchronous function. It checks the function before starting queued work and before delivering completed work. Fabric also stores it with project actors and global templates. The immutable `activation` fact describes a `hostEvent`, `direct`, or `mesh` activation. The `current` object contains `latestActivationSequence`, `mainRevision`, `taskRevision`, `idle`, and `now`. Main revisions increase after completed tools and lifecycle events. A tool-error review can become stale after Main recovers. Return `false` or `{ valid: false, reason? }` to discard stale work. Fabric records invalidated fire-and-forget work as a silent stale outbox entry. An invalidated `agents.ask()` rejects. Predicates must be synchronous. They cannot call tools or use closures because their source must run after restoration.

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

Pi actors keep model context in a Fabric-owned Pi session file. Claude actors keep the session ID returned by the official CLI and use `--resume <id>` after the first message. Every activation reapplies tools, permissions, schema, and system-prompt flags. Fabric also stores a runner-neutral stream transcript. `thinking` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` and uses the precedence described above. In the dashboard, `e` changes this session and `E` changes the project default. The persisted `tools` array is an allowlist. Set it during creation, replace it with `agents.setTools({ id, tools })`, or press `o` in the dashboard. An empty array disables optional tools. Pi actors keep the host-required `fabric_exec` capability for mailbox and mesh coordination unless you create them with `extensions: false`. This setting removes Fabric from a Pi actor. Its activation then runs without `fabric_exec`, `agents.*`, or `mesh.*`. The host continues to manage its mailbox and delivery. The setting alone does not make the actor read-only because `tools` still defaults to `agents.defaultTools`. Also set `tools: ["read", "grep", "find", "ls"]` for a read-only persistent actor. Use `tools: []` for an actor without tools.

### Response modes and delivery

Choose one of these response modes:

- With `text`, each non-empty response becomes an actor outbox message.
- With `directive`, validated output in the form `{ action: "silent" | "message" | "stop", message?, data? }` lets the actor choose whether to intervene.

Delivery can stay in `mailbox` or enter the main session through `steer`, `followUp`, or `nextTurn`. For `steer` and `followUp`, explicitly set `triggerTurn: true | false`. A value of `true` starts Main when it is idle. A value of `false` is passive, and Fabric labels it as unable to start Main. The `mailbox` and `nextTurn` modes never start Main, so they reject `triggerTurn: true`. This policy keeps a delivered actor message from looking like a stalled continuation. Fabric applies no extra 8,000-character truncation to local actor or agent messages sent to Main. Standard limits for model context, providers, and cross-mesh event size still apply.

The actor cannot change delivery from its response. The owner can update a live actor or global template and keep its history:

```ts
await agents.setDeliveryPolicy({
  id: actor.id,
  delivery: "steer",
  triggerTurn: true,
});
```

Set `scope: "global"` to update a reusable template. In the dashboard, press `y` on an actor or template, then choose mailbox, steer, follow-up, or next-turn delivery. Lowercase `m` and `e` change this Pi session. Uppercase `M` and `E` change the owner-gated project defaults. These changes keep the Pi or Claude runner session. Use `agents.ask()` for a blocking exchange and `agents.tell()` for fire-and-forget mail. Both accept one-activation `model` and `thinking` overrides. Read shared history with `agents.messages()`. `agents.remove()` is local-owner-only for session actors and routes durable actors to the resident owner.

## Paged agent logs

`agents.log()` reads bounded pages from JSONL logs. It does not load the full file. The first call returns the newest entries. If `hasMore` is true, pass the returned `before` cursor to load the next older page. For an actor session, use `sessionHasMore` and `sessionBefore`:

```ts
const newest = await agents.log({ id, type: "run", lines: 100 });
if ("before" in newest && newest.hasMore) {
  const older = await agents.log({ id, type: "run", lines: 100, before: newest.before });
  return older;
}
return newest;
```

The `offset` values on log lines and all page cursors are byte offsets in the JSONL file.

## Global actor templates

Persistent actors belong to a project mesh. If you want to reuse a persona in several projects, store it in the project-independent **template library**. This library is in your agent directory at `~/.pi/agent/fabric/actors/`. A template contains only an actor definition, including its name, instructions, subscriptions, and run settings. It contains no mailbox, session transcript, run logs, or other history. Templates are inactive. Import one into a project to run it.

```ts
// Store a reusable persona in the global registry. This does not create a live actor.
return agents.create({
  name: "security-reviewer",
  instructions: "Review changes for security defects. Reply with a directive only for material drift.",
  events: ["agent_settled"],
  responseMode: "directive",
  scope: "global",
});

// List the templates. Then create a new actor from one in the current project.
const [template] = agents.actors({ scope: "global" });
return agents.import({ name: template.name });                       // create it without inherited history
return agents.import({ name: "security-reviewer", as: "security-reviewer-2" }); // rename it if the name exists

// Copy a tuned project actor to the global library without its history.
return agents.export({ id: actorId, overwrite: true });

// Change the default instruction and continuation policy of a template.
await agents.setInstructions({ id: template.id, instructions: "Be brief.", scope: "global" });
return agents.setDeliveryPolicy({
  id: template.id,
  delivery: "steer",
  triggerTurn: false,
  scope: "global",
});
```

`agents.setInstructions` can also change a live project actor. Its default scope is `"project"`. The new instruction applies to the next queued actor message. Only definitions cross the project⇄global boundary. Import and export never move history. Slash commands provide the same operations. `/fabric global` lists templates. `/fabric import <name> [as <new>]` creates one in the project. `/fabric export <id> [--overwrite]` promotes a project actor. The dashboard shows global templates with live actors. From there, you can import, export, delete, edit instructions, and change delivery policy without code. Existing persisted actors and templates continue to load as passive. New active delivery definitions must explicitly set `triggerTurn`.

## Councils

```ts
return council.run({
  task: "Review the current implementation and recommend whether it is ready to merge.",
  roles: ["correctness reviewer", "security reviewer", "test reviewer"],
  transport: "localterm",
  synthesize: true,
});
```

Council members run at the same time under the global agent semaphore. When `synthesize: true`, a final child agent combines their reports. See [`/skill:fabric-council`](../skills/fabric-council/SKILL.md).

## Recursive queries

```ts
return rlm.query({
  runner: "pi",
  task: "Recursively decompose this repository and produce a compact architecture map.",
  transport: "process",
});
```

`rlm.query()` calls `agents.run({ runner: "pi", recursive: true })` with Fabric enabled in the child; it does not accept `cwd`. Recursive spawning means Fabric agent composition, not recursive filesystem traversal. Fabric rejects Claude runners for recursive use. It also rejects recursion at `agents.maxDepth`. This setting accepts any non-negative safe integer, and `0` disables child spawning. Approval for the initial recursive call delegates only the `agent` risk capability to recursive children. It does not delegate approvals for network access, execution, or writes. Each Fabric process applies its own configured concurrency and timeout limits. When `agents.budgetUsd` is set, a shared append-only cost ledger limits total spending across the recursion tree. Each node writes the cost of its children to one ledger file that it receives through the environment. A node rejects a new child when accumulated spending reaches the budget. This check is best effort. Concurrent children can pass the check before another child records cost, so the tree can exceed the limit slightly. Use `agents.maxPerExecution` as the race-free ceiling. Results and live status for each recursive child include a `budget` summary with `limit`, `spent`, `remaining`, and `tokens`. Fabric keeps the latest bounded nested-agent status tree in memory. Completed recursive leaves remain visible in **Topology · Run** after the child process deletes its temporary nested run directories. Fabric releases the snapshot when the parent run is cleaned up or the Fabric session shuts down.

`agents.maxTokensPerChild` limits cumulative token use for each child. Its default value, `0`, disables the limit. The wall-clock `timeoutMs` limits time, and `budgetUsd` limits cost. This limit caps the context of one runaway child before the host session compacts. Fabric stops the child with the same `timed_out` status and a `token limit` error. See [`/skill:fabric-rlm`](../skills/fabric-rlm/SKILL.md).

## Durable mesh coordination

The `mesh` API provides project-scoped, event-sourced coordination:

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

Topics provide durable channels and direct messages with sequence cursors. `mesh.members({ scope?, kinds? })` returns the same combined directory of roots, agents, and actors as `agents.members()`. Versioned `get`, `put`, and `delete` operations provide compare-and-swap state for task claims, leases, reservations, and decisions. You can combine these operations with persistent actors to implement messenger-style swarms in Fabric code. Messenger-style swarms need no fixed planner and worker roles or user-managed daemon. When guest code requests durable residency, Fabric starts the hidden resident host described earlier. See [`/skill:fabric-swarm`](../skills/fabric-swarm/SKILL.md) for the pattern and [`references/mesh.md`](../skills/fabric-exec/references/mesh.md) for the complete API.
