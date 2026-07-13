# pi-fabric

A programmable tool and agent runtime for [Pi](https://github.com/earendil-works/pi).

Pi Fabric gives the model one `fabric_exec` tool for type-checked TypeScript programs that can compose Pi's built-in tools, lazily invoked tools captured from other extensions, dynamically discovered MCP tools, one-shot child agents, persistent event-driven actors, durable mesh coordination, councils, and bounded recursive queries. Intermediate values stay inside a QuickJS sandbox; only the final result returns to the model context.

## Status

Pi Fabric is an early implementation. The core runtime, built-in tools, registered-extension tool capture, MCP provider, provider protocol, approval policies, guarded subagents, dynamic workflow helpers, persistent actors, durable mesh, general-purpose activity TUI, council helper, and recursive query helper are implemented. Review the security notes before enabling mutating tools or external providers.

## Install

From a checkout:

```bash
pnpm install
pnpm build
pi install /absolute/path/to/pi-fabric
```

For one development run:

```bash
pi -e /absolute/path/to/pi-fabric/dist/index.js
```

Once published:

```bash
pi install npm:pi-fabric
```

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

Children inherit the parent model unless `model` is specified. Their tool allowlist defaults to `subagents.defaultTools`.

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

Use `/fabric agents` to list children and `/fabric attach <id>` to display the appropriate attach command. Abort signals propagate to the transport and child Pi process.

Set `worktree: true` to create a dedicated Git worktree and `pi-fabric/<name>-<id>` branch. Worktrees are retained for inspection until `agents.cleanup()` is called.

### Persistent actors and ambient agents

`agents.create()` creates a named actor with a persistent Pi session, a serial mailbox, and optional subscriptions to parent-session events or durable mesh topics:

```ts
return agents.create({
  name: "auth-supervisor",
  instructions: `Watch the main session until the auth migration is complete and tested.
Prefer silence. Reply with a directive only for material drift, a blocker, or verified completion.`,
  events: ["agent_settled", "tool_error"],
  responseMode: "directive",
  delivery: "steer",
  triggerTurn: true,
  tools: ["read", "grep", "find", "ls"],
});
```

This is the primitive behind emergent supervisors and advisors; neither requires another extension. Host events include a bounded recent-session snapshot. Actors process messages one at a time, coalesce repeated host events by default, keep model context in their own session file, and resume when the same Pi session is reopened in a trusted project.

Two response modes are available:

- `text`: every non-empty response becomes an actor outbox message.
- `directive`: validated `{ action: "silent" | "message" | "stop", message?, data? }` output lets the actor decide whether intervention is useful.

Delivery can remain in `mailbox` or enter the main session as `steer`, `followUp`, or `nextTurn`. The creator fixes delivery policy; an actor cannot escalate it in a response. Use `agents.ask()` for a blocking exchange, `agents.tell()` for fire-and-forget mail, `agents.messages()` for history, and `agents.remove()` for cleanup.

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
  task: "Recursively decompose this repository and produce a compact architecture map.",
  transport: "process",
});
```

`rlm.query()` is `agents.run()` with Fabric enabled in the child. Recursion is rejected at `subagents.maxDepth`. Approval of the initial recursive call delegates only the `agent` risk capability to recursive children; network, execution, and write approvals are not inherited. Each Fabric process enforces its own configured concurrency and timeout limits; a cross-process global budget is planned but not yet implemented.

## Included skills

Pi discovers these package skills automatically:

| Command                            | Pattern                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------- |
| `/skill:fabric-supervisor <goal>`  | Persistent goal watcher driven by `agent_settled` and tool-error events |
| `/skill:fabric-advisor [focus]`    | Turn-by-turn peer reviewer that prefers silence                         |
| `/skill:fabric-ambient <role>`     | Meta-pattern for custom event-driven ambient actors                     |
| `/skill:fabric-workflow <task>`    | Code-held phases, fan-out, pipelines, structured output, and synthesis  |
| `/skill:fabric-swarm <objective>`  | Persistent actors, durable topics, and CAS-based shared tasks           |
| `/skill:fabric-council <decision>` | Bounded independent perspectives plus synthesis                         |

Supervisor and advisor are deliberately skills rather than hard-coded host services: the skill writes ordinary Fabric code over the same actor primitive available to every other pattern.

## Visual integration

`fabric_exec` uses the public `pi-code-previews` cooperative shell. It inherits the user's border/background mode, collapsed-result behavior, error styling, and tool-call timing without taking ownership of Pi's built-in tool renderers. Its renderer adds a numbered TypeScript preview, live phase/call activity, and compact phase/nested-call summaries. Nested `pi.read`/`pi.bash`/`pi.grep`/`pi.find`/`pi.ls`/`pi.write`/`pi.edit` calls render as structured previews (path/command headers, numbered content) instead of raw JSON. `pi.read` and `pi.write` content is syntax-highlighted with the same shiki theme configured for `pi-code-previews`, so colors match Pi's native tool previews; `pi.bash` commands are highlighted in the call title and `pi.edit` operations render as a `+`/`-` line diff (with shared context) using Pi core's diff colors. The highlighter initializes lazily and falls back to plain text until ready. Collapsed previews show the configured expand keybinding (e.g. `Ctrl-O`) to expand, matching Pi's built-in tool previews. Users do not need to install `pi-code-previews` separately.

Fabric also owns a general-purpose, theme-aware activity surface for any agent setup:

- A compact widget above the chat (like `pi-supervisor`) follows the current phase and shows active agents, actors, tools, custom items, shared tasks, token use, and elapsed time. It disappears after ordinary runs become quiet, while persistent actors remain visible as a compact ambient row.
- `/fabric dashboard` opens a responsive interactive overlay. Wide terminals use a Claude-workflow-style phase pane beside agents and work items; narrow terminals stack the same panels. Agent detail includes task, model, current tool, usage, result, worktree, and attach metadata. Actor mailboxes, mesh state, and recent mesh events use the same view rather than role-specific screens.
- `↑`/`↓` or `j`/`k` select, `←`/`→` or Tab switch panes, Enter drills into details, `f` cycles status filters, `[`/`]` switches retained runs, and Esc backs out or closes.

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
    "transport": "process",
    "maxConcurrent": 4,
    "maxPerExecution": 100,
    "maxDepth": 2,
    "timeoutMs": 600000,
    "extensions": true,
    "defaultTools": ["read", "bash", "edit", "write", "grep", "find", "ls"],
    "retainRuns": false,
    "notifyOnComplete": true
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
    "maxEventBytes": 262144,
    "maxReadEvents": 500,
    "actorPollMs": 250,
    "actorQueueLimit": 32,
    "eventContextChars": 40000
  }
}
```

`fullCodeMode` defaults to `true`. Full mode deactivates native core tools in the parent session and makes `fabric_exec` their exclusive model-facing owner. When false, Fabric uses orchestration-only mode: native Pi and registered extension tools remain direct, capture is disabled, and Fabric's internal registry omits the `pi` and `extensions` providers.

Fabric risk classes are `read`, `write`, `execute`, `network`, and `agent`; approval policy values are `allow`, `ask`, or `deny`. Captured tools default to the conservative `execute` risk because Pi tool definitions do not declare effects. Add exact tool-name overrides under `capture.risks`. Set `capture.hideFromModel` to `false` to index non-core extension tools without hiding them. `capture.keepVisible` names stay in both Fabric and Pi's direct registry, except that Pi core names are always Fabric-owned in full code mode. An `ask` policy is fail-closed in headless modes without interactive UI. Approval is cached by risk class for one `fabric_exec` execution.

When `mcp.disableOAuth` is true, MCP calls may use cached credentials but cannot launch a new interactive OAuth flow.

The UI `widget` mode is `auto`, `always`, or `hidden`. `auto` shows active work, recent completion, and live persistent actors. The widget renders above the chat (like `pi-supervisor`); set `ui.enabled` to `false` to disable both the widget and dashboard controller.

Mesh data defaults to `<project>/.pi/fabric/mesh`. Set `mesh.root` to a relative or absolute path to relocate durable topics, shared state, and actor sessions. Add `.pi/fabric/mesh/` to the project's ignore file unless the coordination log is intentionally versioned. Set `mesh.enabled` to `false` to disable both mesh actions and ambient actor restoration.

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
/fabric reload
/fabric providers
/fabric captured [query]
/fabric agents
/fabric actors
/fabric messages <actor-id>
/fabric attach <subagent-id>
/fabric stop <actor-or-subagent-id>
```

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
- Child Pi processes load normal extensions by default so provider-backed models continue to work. Their active tool list is restricted by `defaultTools`; `fabric_exec` is excluded unless recursion is explicitly requested.
- A Git worktree isolates files, not credentials, network access, processes, or external services.
- Background one-shot children are stopped when the parent Pi session shuts down. A detached `agents.spawn()` sends a follow-up completion message unless the caller later waits for it or `notifyOnComplete` is disabled. Completed worktrees are intentionally retained.
- Persistent actors are suspended on shutdown and restored for the same Pi session only when project trust is active. Their definitions, mailbox history, and child session files live under `.pi/fabric/mesh/actors/`; mesh topics and shared state are project-scoped. Do not place secrets in actor prompts, messages, or mesh state.
- Approving `agents.create()` delegates future subscribed events to that actor until it is stopped. Each activation uses the actor's fixed tool allowlist and model settings; review those settings before approving a persistent actor.
- Actor responses can enter the main context only through the delivery policy fixed at creation. Directive output is schema-validated, but it is still untrusted model output that the main agent should weigh.
- One Pi process should own a given session's restored actors at a time. Mesh topics are append-only and are not compacted automatically; archive or remove an old mesh root when its history is no longer useful.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

The deterministic test suite covers configuration, schema validation, provider dispatch, registered-tool interception and execution, QuickJS isolation, Pi built-in invocation, direct-process subagents, workflow helpers, durable mesh state, actor mailboxes, subscriptions, and actor restoration.

## License

MIT
