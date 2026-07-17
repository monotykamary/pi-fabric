<div align="center">

# 🧵 pi-fabric

**A programmable tool and agent runtime for [Pi](https://github.com/earendil-works/pi-coding-agent)**

_One type-checked program for tools, MCP, agents, workflows, actors, mesh, councils, and recursion._

<p>
  <img src="https://raw.githubusercontent.com/monotykamary/pi-fabric/main/media/cover.jpg" alt="Pi Fabric composing tools and agents in the Pi TUI" width="1100">
</p>

[![npm version](https://img.shields.io/npm/v/pi-fabric?style=for-the-badge&logo=npm&color=cb3837)](https://www.npmjs.com/package/pi-fabric)
[![checks](https://img.shields.io/github/actions/workflow/status/monotykamary/pi-fabric/test.yml?branch=main&style=for-the-badge&label=checks)](https://github.com/monotykamary/pi-fabric/actions/workflows/test.yml)
[![pi extension](https://img.shields.io/badge/pi-extension-8b5cf6?style=for-the-badge)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-f4c430?style=for-the-badge)](LICENSE)

</div>

---

Pi Fabric turns tool use into code. The model sees one `fabric_exec` tool and writes type-checked TypeScript that can compose Pi's core tools, lazily captured extension tools, MCP servers, child agents, persistent actors, and durable coordination. Intermediate values stay inside a QuickJS sandbox; only the final result returns to the model context.

## Why Fabric?

|     | Capability | What it unlocks |
| :-: | ---------- | --------------- |
| ⚡ | **Code mode** | One flat tool schema; branching, loops, fan-out, and data flow live in checked TypeScript. |
| 🧰 | **Capability routing** | Call Pi core tools, captured extension tools, MCP servers, or explicit Fabric providers through one runtime. |
| 🧑‍🤝‍🧑 | **Agent runtime** | Run one-shot workers, persistent event-driven actors, councils, and bounded recursive queries. |
| 🕸️ | **Workflows + mesh** | Track phases and progress while coordinating durable topics, shared tasks, and compare-and-swap state. |
| 🛡️ | **Guardrails** | Enforce approvals, isolation, timeouts, concurrency, recursion depth, and shared cost budgets at the host bridge. |
| 🎛️ | **Native TUI** | See structured nested previews, live activity, an interactive dashboard, and settings without leaving Pi. |

## Install

From npm:

```bash
pi install npm:pi-fabric
```

From GitHub:

```bash
pi install git:github.com/monotykamary/pi-fabric
```

From a local checkout:

```bash
pnpm install
pnpm build
pi install /absolute/path/to/pi-fabric
```

For one development run:

```bash
pi -e /absolute/path/to/pi-fabric
```

Requires Node.js 24 or newer and Pi 0.80.6 or newer.

## Quick start

Ask Fabric to compose multiple operations in one call:

```ts
const [manifest, sources] = await Promise.all([
  pi.read({ path: "package.json" }),
  pi.find({ pattern: "**/*.ts", path: "src" }),
]);

return {
  package: JSON.parse(manifest).name,
  sourceCount: sources.split("\n").filter(Boolean).length,
};
```

Only the returned value enters the parent model's context. Everything else stays inside the execution.

## Code API

With the default full code mode, `fabric_exec` exclusively owns Pi core tool execution. The parent model sees one programmable tool instead of direct `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls` schemas. Fabric programs use those capabilities through `pi.*`:

```ts
const files = await pi.find({ pattern: "**/*.ts", path: "src" });
const matches = await pi.grep({ pattern: "TODO", path: "src" });
return { files, matches };
```

Independent calls should be parallel:

```ts
const [packageJson, readme] = await Promise.all([
  pi.read({ path: "package.json" }),
  pi.read({ path: "README.md" }),
]);
return {
  package: JSON.parse(packageJson).name,
  readmeLines: readme.split("\n").length,
};
```

### Full code mode

`fullCodeMode: true` is the default. Fabric removes active Pi core tools from the parent model and exposes their implementations only inside `fabric_exec` through `pi.*`. Registered overrides such as security gates and code previews are captured too, so `pi.read()` continues to route through the override rather than bypassing it.

Fabric remembers which native core tools were active before taking ownership. Switching to orchestration-only mode or unloading Fabric restores that selection. Full-mode ownership is reasserted before user input and agent startup, so tools manually re-enabled during the session do not leak back into the parent schema.

### Orchestration-only mode

Users who want Fabric for MCP, agents, ambient actors, parallel workflows, councils, and recursive delegation—but want Pi's core tools to remain entirely native—can opt out of full code mode:

```json
{
  "fullCodeMode": false
}
```

In orchestration-only mode:

- Pi's `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls` tools stay on Pi's normal model-facing and execution paths.
- Registered extension tools also remain in Pi's native registry; Fabric does not hide, wrap, or expose them through `extensions.*`.
- `pi.*`, `extensions.*`, and equivalent `tools.call()` references are unavailable inside `fabric_exec`, including when TypeScript checks are bypassed.
- MCP providers, one-shot and recursive agents, persistent ambient actors, dynamic workflows, mesh coordination, councils, explicit Fabric providers, and the Fabric TUI remain available.
- Child agents continue using their allowed Pi tools directly, so parallel and ambient setups do not route their coding operations back through Fabric code mode.

The default is `true`. A project can set the flag in `.pi/fabric.json`, or a user can set it globally in `~/.pi/agent/fabric.json`.

### Discovery and generic calls

```ts
const providers = await tools.providers();
const candidates = await tools.search({ query: "GitHub issues" });
const schema = await tools.describe({ ref: candidates[0].ref });
const result = await tools.call({
  ref: schema.ref,
  args: { query: "is:open label:bug" },
});
return result;
```

### Captured extension tools

When `fullCodeMode` is enabled, Fabric intercepts Pi's `ExtensionRunner.getAllRegisteredTools()` registry chokepoint. This captures tools registered by other extensions at startup or later through `pi.registerTool()`, regardless of whether those extensions load before or after Fabric.

Captured custom tools are removed from Pi's model-facing registry by default, so their schemas, snippets, and guidelines do not consume the parent model context. The extension itself remains loaded: its commands, event handlers, state, and UI continue to work. Only tool discovery and invocation become lazy.

```ts
const matches = await tools.search({ query: "deployment status" });
const schema = await tools.describe({ ref: matches[0].ref });
const result = await tools.call({
  ref: schema.ref,
  args: { environment: "staging" },
});
return result;
```

For tool names valid as JavaScript properties, use the shorter proxy:

```ts
const result = await extensions.project_status({ verbose: true });
return result.text;
```

The result preserves `content`, text content as `text`, `details`, `isError`, `terminate`, and source provenance. Fabric runs the captured definition's `prepareArguments()` and original executor with its owning extension context. Pi's `tool_call`, `tool_result`, and `tool_execution_*` lifecycle handlers are also applied to nested captured calls.

Extension overrides of core tools are captured and hidden with their built-in counterparts in full code mode. Inside Fabric, `pi.read`, `pi.bash`, and the other built-ins automatically route through a captured override when one exists; `extensions.read` exposes the override's full native result shape. `capture.keepVisible` can retain non-core extension tools in Pi's direct registry, but core tool names are always excluded while full code mode owns them.

### MCP through mcporter

Pi Fabric uses the public [`mcporter`](https://github.com/openclaw/mcporter) runtime. It inherits mcporter's config discovery, imports, OAuth cache, and connection pooling.

```ts
const servers = await mcp.servers(); // names and transport metadata; credentials are never exposed
const result = await mcp.context7.resolve_library_id({
  libraryName: "react",
  query: "hooks documentation",
});
return result;
```

Use `await mcp.reload()` after changing mcporter configuration. `mcp.call({ server, tool, args })` is available when a server or tool name cannot be expressed conveniently as property access.

A program can register an ephemeral server directly in mcporter's pooled runtime after host approval:

```ts
await mcp.register({
  name: "project-docs",
  command: "npx",
  args: ["-y", "@example/docs-mcp"],
  cwd: ".",
});
return mcp.project_docs.search({ query: "authentication" });
```

HTTP servers use `baseUrl` instead of `command`. Dynamic definitions live until `mcp.reload()` or session shutdown; they are not written to config.

### Dynamic workflows

Fabric programs already keep orchestration and intermediate values in code. The workflow globals add Claude Code-style names and progress phases without introducing a second JavaScript runtime:

```ts
await workflow.configure({
  name: "Authentication audit",
  description: "Discover relevant files, audit them in parallel, then verify findings",
});

await phase("Discover", { total: 1 });
const inventory = await agent<{ files: string[] }>(
  "List source files relevant to authentication.",
  {
    label: "auth inventory",
    tools: ["read", "grep", "find", "ls"],
    schema: {
      type: "object",
      properties: { files: { type: "array", items: { type: "string" } } },
      required: ["files"],
      additionalProperties: false,
    },
  },
);

await phase("Audit", { total: inventory.files.length });
const findings = await parallel(
  inventory.files.map(
    (file) => () =>
      agent(`Audit ${file} for concrete auth defects.`, {
        label: `audit ${file}`,
        tools: ["read", "grep", "find", "ls"],
      }),
  ),
  { concurrency: 8 },
);

await phase("Verify", { total: 1 });
return agent(`Verify and synthesize these findings: ${JSON.stringify(findings)}`, {
  label: "verify findings",
  tools: ["read", "grep", "find", "ls"],
});
```

Available helpers are `workflow.agent()`, `workflow.parallel()`, `workflow.pipeline()`, `workflow.configure()`, `workflow.phase()`, `workflow.item()`, `workflow.event()`, `workflow.log()`, and `workflow.budget`. `configure()` names the activity surface; phase options accept `id`, `description`, and an expected `total`. `item()` lets arbitrary non-agent work report status, detail, and progress without requiring a bespoke renderer. `event()` adds a bounded milestone to the run feed. The shorter `agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`, and `budget` aliases are equivalent. `fabric_exec` accepts optional `agentBudget` and `tokenBudget` limits; configuration supplies a hard per-execution agent cap.

A JSON Schema on an agent request makes the worker return validated structured data through `result.value`. Workflow helpers return that value directly and otherwise return the agent's final text.

### Subagents

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

#### Claude Code runner

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

Supported transports:

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

### Steering running agents

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

`agents.steer({ id, message })` is delivered after the current turn's tool calls, before the next LLM call; `agents.followUp({ id, message })` is delivered after the agent finishes; `agents.setSteeringMode`/`setFollowUpMode` set `"all"` vs `"one-at-a-time"` delivery. Pi uses its RPC queue; Claude uses additional user records on the same `claude -p` stream so the session and context are preserved. `agents.status({ id }).pendingMessages` shows the live queue. For an id not local to this process, `agents.steer` publishes a `fabric.steer` mesh event the owning process relays — so an agent in one Pi process can steer an agent in another. See `skills/fabric-exec/references/agents.md`.

### Persistent actors and ambient agents

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

Two response modes are available:

- `text`: every non-empty response becomes an actor outbox message.
- `directive`: validated `{ action: "silent" | "message" | "stop", message?, data? }` output lets the actor decide whether intervention is useful.

Delivery can remain in `mailbox` or enter the main session as `steer`, `followUp`, or `nextTurn`. The creator fixes delivery policy; an actor cannot escalate it in a response. Use `agents.ask()` for a blocking exchange, `agents.tell()` for fire-and-forget mail, `agents.messages()` for history, and `agents.remove()` for cleanup.

### Global actor templates

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

### Durable mesh coordination

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

Topics provide durable channel and direct-message semantics with sequence cursors. `mesh.members()` discovers actor presence across live Fabric sessions. Versioned `get`/`put`/`delete` operations provide compare-and-swap state for task claims, leases, reservations, and decisions. Together with persistent actors, these are sufficient to express messenger-style swarms in Fabric code without a daemon or fixed planner/worker roles.

### Councils

```ts
return council.run({
  task: "Review the current implementation and recommend whether it is ready to merge.",
  roles: ["correctness reviewer", "security reviewer", "test reviewer"],
  transport: "localterm",
  synthesize: true,
});
```

Council members run concurrently under the global subagent semaphore. With `synthesize: true`, a final child agent reconciles their reports.

### Recursive queries

```ts
return rlm.query({
  runner: "pi",
  task: "Recursively decompose this repository and produce a compact architecture map.",
  transport: "process",
});
```

`rlm.query()` is `agents.run({ runner: "pi", recursive: true })` with Fabric enabled in the child. Claude runners are intentionally rejected for recursive Fabric. Recursion is rejected at `subagents.maxDepth`. Approval of the initial recursive call delegates only the `agent` risk capability to recursive children; network, execution, and write approvals are not inherited. Each Fabric process enforces its own configured concurrency and timeout limits. When `subagents.budgetUsd` is set, a shared append-only cost ledger bounds total spend across the whole recursion tree: every node records the cost of the children it spawns into one ledger file inherited via environment, and each node rejects a new child when the accumulated spend reaches the budget. The check is best-effort (concurrent children can each pass before any cost lands, so a tree may slightly overshoot); the race-free ceiling remains `subagents.maxPerExecution`. The result and live status of every recursive child carry a `budget` summary (`limit`, `spent`, `remaining`, `tokens`).

`subagents.maxTokensPerChild` (0 = disabled) bounds each child's cumulative token usage. The wall-clock `timeoutMs` and the cost `budgetUsd` bound time and money; this bounds a single runaway child's context before the host session compacts, terminating it with the same `timed_out` status and a `token limit` error.

## Included skills

Pi discovers these package skills automatically:

| Command                            | Pattern                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------- |
| `/skill:fabric-supervisor <goal>`  | Persistent goal watcher driven by `agent_settled` and tool-error events |
| `/skill:fabric-advisor [focus]`    | Decision-point peer reviewer (idle and tool errors) that prefers silence                         |
| `/skill:fabric-ambient <role>`     | Meta-pattern for custom event-driven ambient actors                     |
| `/skill:fabric-workflow <task>`    | Code-held phases, fan-out, pipelines, structured output, and synthesis  |
| `/skill:fabric-rlm <task>`        | Recursive self-delegation via `rlm.query()` for tasks too big for one context window |
| `/skill:fabric-swarm <objective>`  | Persistent actors, durable topics, and CAS-based shared tasks           |
| `/skill:fabric-council <decision>` | Bounded independent perspectives plus synthesis                         |
| `/skill:fabric-fusion <task>`      | Multi-model deliberation: parallel panel plus a compare-not-merge judge |

`fabric-exec` is the one discoverable reference skill: it holds the full `fabric_exec` API (core `pi.*` tools, `tools` discovery, `π` strings, error recovery) plus `references/` files for MCP, agents/rlm, and mesh loaded by relative path (not separate skills). It appears in `<available_skills>`; load it via `read` before your first `fabric_exec` call or when a call errors.

Supervisor and advisor are deliberately skills rather than hard-coded host services: the skill writes ordinary Fabric code over the same actor primitive available to every other pattern.

## Visual integration

`fabric_exec` uses the public `pi-code-previews` cooperative shell. It inherits the user's border/background mode, collapsed-result behavior, error styling, and tool-call timing without taking ownership of Pi's built-in tool renderers. Its renderer adds a numbered TypeScript preview, live phase/call activity, and compact phase/nested-call summaries. Nested `pi.read`/`pi.bash`/`pi.grep`/`pi.find`/`pi.ls`/`pi.write`/`pi.edit` calls render as structured previews (path/command headers, numbered content) instead of raw JSON. `pi.read` and `pi.write` content is syntax-highlighted with the same shiki theme configured for `pi-code-previews`, so colors match Pi's native tool previews; `pi.bash` commands are highlighted in the call title and `pi.edit` operations render as a `+`/`-` line diff (with shared context) using Pi core's diff colors. The highlighter initializes lazily and falls back to plain text until ready. Collapsed previews show the configured expand keybinding (e.g. `Ctrl-O`) to expand, matching Pi's built-in tool previews. Users do not need to install `pi-code-previews` separately.

Fabric also owns a general-purpose, theme-aware activity surface for any agent setup:

- A compact widget above the chat (like `pi-supervisor`) follows the current phase and shows active agents, actors, tools, custom items, shared tasks, token use, and elapsed time. It disappears after ordinary runs become quiet, while persistent actors remain visible as a compact ambient row.
- `/fabric dashboard` opens a responsive interactive overlay. Wide terminals use an activity-group pane beside agents and work items; narrow terminals stack the same panels. Explicit workflow phases remain distinct, while direct calls, items, and agents launched without a phase appear under **Run activity** instead of disappearing. Activity groups show agent count, token use, and elapsed time; agent rows prioritize attention and summarize current work, errors, or results. Agent detail includes task, model, current tool, usage, result, worktree, and attach metadata. Press Space on an agent for a live transcript peek, or press `t` in its detail to switch between summary and transcript. The bounded ring-buffer transcript renders Pi RPC and Claude stream-JSON assistant text with Pi's native Markdown treatment while keeping tool activity as compact one-line markers; common credential fields and token shapes are redacted from tool previews. Oldest activity rolls off the top, scrolling pauses follow mode, and `G` resumes it. One-shot agent model and thinking settings are fixed when spawned, but selected agents can be steered, given a queued follow-up, or safely stopped from the dashboard. Persistent actors are editable: select an actor to see the available shortcuts, then press `m` for its model, `e` for thinking (reasoning effort), `v` for host events, or `i` for its default instruction. Model/thinking changes persist to the actor registry and take effect on the actor's next run; the model picker uses Pi's registry for Pi actors and Claude's runtime catalog for Claude actors, and Inherit falls back to that runner's Fabric/runtime default. Actor mailboxes, mesh state, recent mesh events, and global actor templates use the same view rather than role-specific screens. Press `x` to export a project actor to the global library, `p` to import a global template as a fresh project actor, or `d` to delete a global template.
- `/fabric settings` opens an inline settings view that mirrors Pi core's `/settings` (top and bottom borders, fuzzy search, section submenus) and writes changes to `fabric.json`. Trusted projects write to `<project>/.pi/fabric.json`; untrusted sessions write to the global `~/.pi/agent/fabric.json`. Full code mode, capture, executor, approvals, and UI changes apply immediately; mesh, subagent, and MCP changes persist and take effect on the next `/fabric reload`. The Subagents section selects the default runner and keeps independent Pi and runtime-enumerated Claude model pickers. List editors for `subagents.defaultTools` and `capture.keepVisible` toggle known tools on and off; `keepVisible` candidates include `fabric_exec` plus every captured extension tool.
- `↑`/`↓` or `j`/`k` select, `←`/`→` or Tab switch panes, Enter drills into details, `f` cycles status filters, `[` selects an older retained run, `]` a newer one, and `?` opens contextual help. On one-shot agents, Space peeks at the live transcript, `t` toggles transcript/summary detail, `s` opens a steer editor, `u` queues a follow-up, and pressing `x` twice stops an active run. On actors, `m` changes the model, `e` thinking, `v` host events, and `i` instructions; `x` exports to global, `p` imports a global template, `d` deletes one, and Esc backs out or closes.

The surface is data-driven. Fabric automatically instruments nested provider calls, subagents, persistent actors, and task-shaped mesh entries. A workflow can add domain-specific labels and arbitrary progress without adding extension UI code:

```ts
await workflow.configure({ name: "Release train", description: "Build, verify, and publish" });
await phase("Build", { total: packages.length });
await workflow.item({
  id: "docs",
  label: "Documentation",
  status: "running",
  completed: 2,
  total: 5,
});
await workflow.event({ message: "Canary passed", level: "success" });
```

External Fabric providers can emit structured `context.activity()` updates for an entity, progress message, or metrics. This keeps the TUI generic while allowing a virtual provider to expose richer live state.

## Configuration

Pi Fabric reads:

1. `~/.pi/agent/fabric.json`
2. `<project>/.pi/fabric.json`, only for trusted projects

Project values override global values.

```json
{
  "fullCodeMode": true,
  "executor": {
    "timeoutMs": 120000,
    "memoryLimitBytes": 67108864,
    "maxOutputChars": 100000,
    "maxNestedResultChars": 2000000
  },
  "approvals": {
    "read": "allow",
    "write": "allow",
    "execute": "allow",
    "network": "allow",
    "agent": "allow"
  },
  "capture": {
    "enabled": true,
    "hideFromModel": true,
    "keepVisible": ["fabric_exec"],
    "defaultRisk": "execute",
    "risks": {
      "read": "read",
      "grep": "read",
      "find": "read",
      "ls": "read",
      "edit": "write",
      "write": "write",
      "bash": "execute"
    }
  },
  "mcp": {
    "enabled": true,
    "disableOAuth": true,
    "allowDynamicServers": true,
    "callTimeoutMs": 120000
  },
  "subagents": {
    "enabled": true,
    "runner": "pi",
    "transport": "process",
    "claude": {
      "binary": "claude"
    },
    "thinking": "medium",
    "maxConcurrent": 4,
    "maxPerExecution": 100,
    "maxDepth": 2,
    "timeoutMs": 3600000,
    "extensions": true,
    "defaultTools": ["read", "bash", "edit", "write", "grep", "find", "ls"],
    "retainRuns": false,
    "notifyOnComplete": true,
    "budgetUsd": 0,
    "maxTokensPerChild": 0
  },
  "ui": {
    "enabled": true,
    "widget": "auto",
    "maxRows": 6,
    "refreshMs": 500,
    "lingerMs": 10000,
    "eventHistory": 80
  },
  "mesh": {
    "enabled": true,
    "actorScope": "project",
    "maxEventBytes": 262144,
    "maxReadEvents": 500,
    "actorPollMs": 250,
    "actorQueueLimit": 32,
    "eventContextChars": 40000
  }
}
```

`subagents.runner` selects the default harness (`"pi"` or `"claude"`). `subagents.model` is the optional Pi `provider/id` override; `subagents.claude.model` is the optional canonical Claude runtime key. `subagents.claude.binary` defaults to `claude` and can be an absolute path or wrapper; `PI_FABRIC_CLAUDE_BINARY` overrides it for the current process. `/fabric settings` enumerates Claude models from that binary and stores the two runner defaults independently.

`fullCodeMode` defaults to `true`. Full mode deactivates native core tools in the parent session and makes `fabric_exec` their exclusive model-facing owner. When false, Fabric uses orchestration-only mode: native Pi and registered extension tools remain direct, capture is disabled, and Fabric's internal registry omits the `pi` and `extensions` providers.

Fabric risk classes are `read`, `write`, `execute`, `network`, and `agent`; approval policy values are `allow`, `ask`, or `deny`. Captured tools default to the conservative `execute` risk because Pi tool definitions do not declare effects. Add exact tool-name overrides under `capture.risks`. Set `capture.hideFromModel` to `false` to index non-core extension tools without hiding them. `capture.keepVisible` names stay in both Fabric and Pi's direct registry, except that Pi core names are always Fabric-owned in full code mode. An `ask` policy is fail-closed in headless modes without interactive UI. Approval is cached by risk class for one `fabric_exec` execution.

When `mcp.disableOAuth` is true, MCP calls may use cached credentials but cannot launch a new interactive OAuth flow.

The UI `widget` mode is `auto`, `always`, or `hidden`. `auto` shows active work, recent completion, and live persistent actors. The widget renders above the chat (like `pi-supervisor`); set `ui.enabled` to `false` to disable both the widget and dashboard controller.

Mesh data defaults to `<project>/.pi/fabric/mesh`. Set `mesh.root` to a relative or absolute path to relocate durable topics, shared state, and actor sessions. Add `.pi/fabric/mesh/` to the project's ignore file unless the coordination log is intentionally versioned. Set `mesh.enabled` to `false` to disable both mesh actions and ambient actor restoration.

`mesh.actorScope` controls where persistent actor definitions, mailboxes, and child sessions are stored and restored from. The default `"project"` keeps a single shared actor registry at `.pi/fabric/mesh/actors/`, so actors survive `/new` and carry over between Pi sessions in the same project without redefinition. Set it to `"session"` to isolate actors per Pi session (under `.pi/fabric/mesh/actors/<sessionId>/`), the previous default; use this when you run concurrent Pi sessions in one project and want each to own its own actors. With project scope, one Pi process should own the actor registry at a time — concurrent sessions sharing a registry may race on writes.

## External provider protocol

Normal `pi.registerTool()` tools are captured automatically. Extensions can still opt into the versioned provider protocol when they need to expose non-tool capabilities, richer risk declarations, or a large virtual action catalog without registering one Pi tool per action:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  FABRIC_PROVIDER_DISCOVER_EVENT,
  FABRIC_PROVIDER_REGISTER_EVENT,
  type FabricProvider,
  type FabricProviderDiscovery,
} from "pi-fabric/protocol";

export default function extension(pi: ExtensionAPI) {
  const provider: FabricProvider = {
    name: "example",
    description: "Example actions",
    async list() {
      return [];
    },
    async describe() {
      return undefined;
    },
    async invoke() {
      return null;
    },
  };

  pi.events.emit(FABRIC_PROVIDER_REGISTER_EVENT, {
    version: 1,
    provider,
    overwrite: true,
  });

  pi.events.on(FABRIC_PROVIDER_DISCOVER_EVENT, (event: FabricProviderDiscovery) => {
    event.register(provider, { overwrite: true });
  });
}
```

Providers own their schemas, state, and execution semantics. Pi Fabric validates arguments, enforces the declared risk policy, records nested-call audits, and propagates cancellation. A provider can enrich the generic activity surface without registering a TUI component:

```ts
async invoke(actionName, args, context) {
  context.activity?.({ type: "entity", id: job.id, kind: "custom", name: job.name });
  context.activity?.({ type: "progress", message: "Indexing package 3/12" });
  context.activity?.({ type: "metrics", tokens: 4200, toolCalls: 9 });
  return job.result;
}
```

## Commands

```text
/fabric status
/fabric dashboard
/fabric settings
/fabric reload
/fabric providers
/fabric captured [query]
/fabric agents
/fabric actors
/fabric messages <actor-id>
/fabric attach <subagent-id>
/fabric stop <actor-or-subagent-id>
```

## Headless focused agents

Pi already runs one-shot, non-interactive agents with `pi -p` (`--print`), and it reads piped stdin as part of the prompt — so a focused agent composes with pipes, cron, git hooks, and CI like a Unix program, with no wrapper needed:

```bash
git diff | pi -p --no-session -t read,grep "Review this diff for concrete defects."
pi -p --no-session --mode json -e <path-to-pi-fabric> "Map the persistence layer."
```

`--no-session` keeps the run ephemeral, `-t` restricts the tool allowlist, `--mode json` emits a structured event stream for scripting (`| jq`), and `-e <pi-fabric>` loads Fabric so the agent can use `fabric_exec`. The process exits non-zero on failure. See `pi --help` for the full flag list.

## Architecture

```text
fabric_exec
    │
    ▼
TypeScript checker → QuickJS sandbox
    │ JSON-only host bridge
    ▼
ActionRegistry
    ├── pi.*         built-in Pi tool definitions
    ├── extensions.* captured pi.registerTool definitions
    ├── mcp.*        pooled mcporter runtime
    ├── agents.*     one-shot workers + persistent mailbox actors
    ├── mesh.*       durable topics + compare-and-swap state
    └── external     explicit pi.events providers

ActivityStore → compact widget + footer status + interactive dashboard
```

Guest code has no `process`, `require`, filesystem, network, or subprocess globals. All effects cross the host bridge, where schemas, approvals, audit records, timeouts, and cancellation apply. Each execution receives a fresh QuickJS context. Named strings passed in the `strings` tool parameter are available as `π.key`; accessing a key that was not provided throws a clear, actionable error listing the provided keys rather than silently returning `undefined`.

## Tool-call robustness

The model-facing `fabric_exec` schema is intentionally flat — one large `code` string plus scalar/optional parameters — with no nested arrays-of-objects containing escaped content. Newer SOTA models are post-trained on one dominant harness's flat tool shapes and can invent trailing keys at the highest-entropy point of a nested escaped-JSON field (e.g. right after closing a long multiline string), which a strict schema rejects. The only nested field, `display`, ignores unknown keys: extras are accepted by the schema and filtered to `{ name, description }` before execution, mirroring the silent-filter behavior the dominant harness's client is trained against.

fabric's architecture is itself a mitigation for this class of bug. The model authors TypeScript that calls tools, so it never has to faithfully emit an alternative tool schema under sampling pressure; nested object construction happens in deterministic, type-checked code. The residual failure mode is incorrect TypeScript, caught by the QuickJS type-checker with an actionable, line-numbered error — the validate/report/retry loop at the code level rather than the JSON-schema level.

For sessions that also call pi tools directly (`read`/`write`/`edit`/`grep`/`find`/`ls`/`bash`), install [pi-tool-repair](https://github.com/monotykamary/pi-tool-repair) as a companion. It validates-then-repairs the finite set of tool-call mistakes those direct calls make — invented keys, wrong field names, stringified arrays, anchor bleed, and leaked tool-call grammars — before tools execute. It hooks `before_provider_request`/`message_end`/`tool_call`; fabric registers a tool, so the two do not conflict.

An external lever outside fabric's control is enabling Anthropic strict tool use at the provider, which prevents the server from sampling keys not in the schema. It is the strongest mitigation for schema drift but trades against Anthropic's complexity limits on strict tool definitions.

## Security and limitations

- Pi Fabric invokes separately constructed Pi built-in definitions when no captured override exists. Those unoverridden built-in calls do not pass through Pi's top-level `tool_call` and `tool_result` hooks. Captured overrides and other extension calls do run those hooks; Fabric's approval and audit layer remains authoritative around every nested call.
- Captured tools execute with the full privileges of their owning extension. Hiding a tool schema is context optimization, not sandboxing. Captured tools retain their definitions and native renderers, but nested calls render as part of the enclosing Fabric execution rather than as separate native tool rows.
- Registry interception composes through the public `ExtensionRunner.getAllRegisteredTools()` method. An extension that replaces that method without delegating to the previous implementation can prevent capture.
- MCP servers and external providers execute with their own host privileges. Review their configuration and code.
- Type checking improves reliability but is not a security boundary; QuickJS isolation and the host capability bridge are the boundaries.
- Child Pi processes load normal extensions by default so provider-backed models continue to work. Claude children use the official installed CLI and its existing authentication. Both runners restrict the active model-facing tools to `defaultTools`; Pi adds `fabric_exec` only for explicit recursion, while Claude rejects recursion and unmapped tools.
- Claude `extensions: true` preserves the user's normal Claude Code customizations, including applicable settings and hooks; those hooks execute with their usual host privileges. Use `extensions: false` for Claude safe mode. `Bash` remains unrestricted inside the child when allowed, just as Fabric's `bash` capability is.
- Claude model discovery uses a local initialization control request and does not invoke a model. Actual one-shot and actor activations use the account/API billing already configured in Claude Code; Fabric records the CLI's reported `total_cost_usd` in normal usage and budget ledgers.
- A Git worktree isolates files, not credentials, network access, processes, or external services.
- Agent transcripts are projected from local `events.jsonl` run logs. The dashboard redacts common credentials from compact tool previews, but the permission-restricted raw event log can contain assistant text, tool arguments/results, diagnostics, and extension protocol payloads; treat retained run directories as sensitive.
- Background one-shot children are stopped when the parent Pi session shuts down. A detached `agents.spawn()` sends a follow-up completion message unless the caller later waits for it or `notifyOnComplete` is disabled. Completed worktrees are intentionally retained.
- Persistent actors are suspended on shutdown and restored when project trust is active. Claude actor session IDs refer to Claude Code's own persisted session store; removing that private session makes resume fail, and removing a Fabric actor does not currently delete Claude Code's private transcript. By default (`mesh.actorScope: "project"`), their definitions, mailbox history, and child session files live under `.pi/fabric/mesh/actors/` and are shared across all Pi sessions in the project, so actors survive `/new`. Set `mesh.actorScope: "session"` to isolate actors per Pi session instead. Mesh topics and shared state are always project-scoped. Do not place secrets in actor prompts, messages, or mesh state.
- Approving `agents.create()` delegates future subscribed events to that actor until it is stopped. Each activation uses the actor's fixed runner/tool allowlist and its persisted model setting; review them before approving a persistent actor.
- Actor responses can enter the main context only through the delivery policy fixed at creation. Directive output is schema-validated, but it is still untrusted model output that the main agent should weigh.
- One Pi process should own the actor registry at a time. This is especially important with project scope, where concurrent Pi sessions in the same project share one registry and may race on writes. Mesh topics are append-only and are not compacted automatically; archive or remove an old mesh root when its history is no longer useful.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

The deterministic test suite covers configuration, schema validation, provider dispatch, registered-tool interception and execution, QuickJS isolation, Pi built-in invocation, direct-process subagents, fake Claude stream-JSON/model discovery, workflow helpers, durable mesh state, actor mailboxes, subscriptions, and Pi/Claude actor restoration. Claude fixtures never make a billable API request.

## License

MIT
