# Configuration

Pi Fabric reads configuration from two JSON files. Project values override global values.

1. `~/.pi/agent/fabric.json` — global defaults.
2. `<project>/.pi/fabric.json` — project overrides, only for **trusted** projects.

`/fabric settings` writes changes to the same files: trusted projects write to `<project>/.pi/fabric.json`; untrusted sessions write to the global `~/.pi/agent/fabric.json`.

`executor.runtime` selects `"quickjs"` (the default isolated WASM runtime) or `"node-process"` (a disposable native V8 process). QuickJS memory limits are capped at `4294967295` bytes because its WASM32 `size_t` cannot represent 4 GiB; larger values are rejected rather than wrapped. Node process limits may be set as high as detected physical memory and are passed to V8 as `--max-old-space-size`.

`node-process` is an explicit trusted-code escape hatch, not a security sandbox. It preserves Fabric's IPC host bridge, approvals, audit records, timeout, and cancellation, but Node's `vm` API is not a security boundary. Enable it only for workloads and projects whose generated code you are willing to run with the local user account's authority. Each invocation receives a fresh child process and is forcibly terminated when it settles, times out, or is cancelled. Schema enforce mode always forces `quickjs`. Large limits in either runtime can exhaust system memory or destabilize the machine.

## Full reference

```json
{
  "fullCodeMode": true,
  "executor": {
    "runtime": "quickjs",
    "timeoutMs": 120000,
    "memoryLimitBytes": 67108864,
    "maxOutputChars": 100000,
    "maxNestedResultChars": 2000000,
    "resultFormat": "auto"
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
  "prewalk": {
    "alwaysRearm": false
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
    "eventHistory": 80,
    "haltOnEscape": true,
    "showNestedToolCalls": true,
    "nestedToolDebounceMs": 100
  },
  "compaction": {
    "engine": "fabric"
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

## Prewalk executor

`prewalk.model` is the optional Pi `provider/model` used by `/fabric prewalk`. Set it under `/fabric settings` → **Prewalk** or in JSON:

```json
{
  "prewalk": {
    "model": "anthropic/claude-haiku-4-5",
    "alwaysRearm": true
  }
}
```

`prewalk.alwaysRearm` defaults to `false`. When enabled, an armed prewalk returns to an armed, taskless state after each handoff or settled task, capturing the next user input until `/fabric prewalk --off` is used.

The settings UI labels the unset model state **Ask each time**. In that state, interactive sessions choose a model while arming prewalk; non-interactive sessions reject the command. This setting is independent of `subagents.model` so ordinary children and the automatic handoff executor can use different models.

## Result formatting

`executor.resultFormat` sets the default for `fabric_exec` return values and is available under `/fabric settings` → **Executor**. `"auto"` keeps strings as text and renders structured values as syntax-highlighted YAML. `"yaml"`, `"json"`, and `"text"` force the corresponding behavior. A call-level `resultFormat` parameter overrides the configured default.

The compaction engine is available under `/fabric settings` → **Compaction**. Select `"fabric"` for deterministic compaction or `"pi"` to delegate to Pi core.

## Code modes

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

### Full code mode (default)

`fullCodeMode: true` is the default. Fabric removes active Pi core tools from the parent model and exposes their implementations only inside `fabric_exec` through `pi.*`. Registered overrides such as security gates and code previews are captured too, so `pi.read()` continues to route through the override rather than bypassing it.

Fabric remembers which native core tools were active before taking ownership. Switching to orchestration-only mode or unloading Fabric restores that selection. Full-mode ownership is applied only when the session initializes or the mode changes. Fabric does not reset an explicitly selected active tool set from input, agent-start, turn-end, or settled lifecycle hooks; the system prompt carries the full-mode execution rule.

Pi core normally includes its model-visible skill catalog only while the native `read` tool is active. Full code mode restores the same catalog from Pi's structured skill registry and adapts only its loader instruction to use `pi.read` inside `fabric_exec`; native core tools remain hidden. Packaged skills mark cross-document paths with `<skill-dir>`; Fabric replaces that marker inline from Pi's expanded skill `location` or the actual `SKILL.md` read path, without matching skill names or enumerating directories. Ordinary document reads are unchanged. When an expanded skill invokes another installed skill, Fabric also adds an exact name-to-path resolution hint for that turn so the delegated `SKILL.md` is loaded before task work.

### Orchestration-only mode

Users who want Fabric for MCP, agents, ambient actors, parallel workflows, councils, and recursive delegation — but want Pi's core tools to remain entirely native — can opt out of full code mode:

```json
{
  "fullCodeMode": false
}
```

In orchestration-only mode:

- Pi's `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls` tools stay on Pi's normal model-facing and execution paths.
- Registered extension tools also remain in Pi's native registry; Fabric does not hide, wrap, or expose them through `extensions.*`.
- `pi.*`, `extensions.*`, and equivalent `tools.call()` references are unavailable inside `fabric_exec`, including when TypeScript checks are bypassed.
- MCP and stable Fabric providers remain available through `mcp.*`, `memory.*`, `state.*`, `schema.*`, and `compact.*`; generic discovery and computed refs remain available through `tools.*`. One-shot and recursive agents, persistent ambient actors, dynamic workflows, mesh coordination, councils, explicit Fabric providers, and the Fabric TUI also remain available.
- Child agents continue using their allowed Pi tools directly, so parallel and ambient setups do not route their coding operations back through Fabric code mode.

### Where to set it

`fullCodeMode` defaults to `true`. A project can set the flag in `.pi/fabric.json`, or a user can set it globally in `~/.pi/agent/fabric.json`. `/fabric settings` toggles it too.

## Captured extension tools

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

## Approvals and risk

Fabric risk classes are `read`, `write`, `execute`, `network`, and `agent`; approval policy values are `allow`, `ask`, or `deny`.

- Captured tools default to the conservative `execute` risk because Pi tool definitions do not declare effects. Add exact tool-name overrides under `capture.risks`.
- Set `capture.hideFromModel` to `false` to index non-core extension tools without hiding them.
- `capture.keepVisible` names stay in both Fabric and Pi's direct registry, except that Pi core names are always Fabric-owned in full code mode.
- An `ask` policy is fail-closed in headless modes without interactive UI.
- Approval is cached by risk class for one `fabric_exec` execution.

## Subagents

`subagents.runner` selects the default harness (`"pi"` or `"claude"`). `subagents.model` is the optional Pi `provider/id` override; `subagents.claude.model` is the optional canonical Claude runtime key. `subagents.claude.binary` defaults to `claude` and can be an absolute path or wrapper; `PI_FABRIC_CLAUDE_BINARY` overrides it for the current process. `/fabric settings` enumerates Claude models from that binary in the background and stores the two runner defaults independently.

Other subagent settings:

- `thinking` — default reasoning effort (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`), default `medium`.
- `maxConcurrent` — global child concurrency semaphore.
- `maxPerExecution` — hard cap on children per `fabric_exec` invocation.
- `maxDepth` — recursion depth bound for `rlm.query()`.
- `timeoutMs` — default per-child wall-clock budget and floor for per-call overrides (60 minutes by default). Lower per-call values are ignored; callers should only set `timeoutMs` to request a longer run.
- `extensions` — whether Claude children keep their normal Claude Code customizations.
- `defaultTools` — the default tool allowlist for children.
- `budgetUsd` — shared append-only cost ledger across a recursion tree (0 disables).
- `maxTokensPerChild` — per-child cumulative token bound (0 disables).
- `notifyOnComplete` — send a follow-up completion message for a detached `agents.spawn()`.

See [agents, actors & mesh](agents.md) for the runner and transport details.

## MCP

- `mcp.disableOAuth` — when true, MCP calls may use cached credentials but cannot launch a new interactive OAuth flow.
- `mcp.callTimeoutMs` — per-call timeout bound.
- `mcp.allowDynamicServers` — permit `mcp.register()` of ephemeral servers.
- `mcp.enabled` — set to `false` to disable the MCP surface.

See the [`mcp` reference](../skills/fabric-exec/references/mcp.md) for the call surface.

## UI

- `ui.widget` is `auto`, `always`, or `hidden`. `auto` shows active or retained Fabric runs and worker activity. Active one-shot agents and actor workers occupy rows; their recent nested tools appear beneath them when enabled.
- `ui.showNestedToolCalls` defaults to `true` and controls child-agent/actor tool rows in both the parent `fabric_exec` card and widget.
- `ui.nestedToolDebounceMs` defaults to `100` and applies one coalescing timer across all regular nested calls in a `fabric_exec` execution. Set it to `0` to emit every update; accepted values are clamped to `0..2000`.
- The widget renders above the chat (like `pi-supervisor`); set `ui.enabled` to `false` to disable both the widget and dashboard controller.

See the [interface reference](interface.md).

## Mesh

Mesh data defaults to `<project>/.pi/fabric/mesh`. Set `mesh.root` to a relative or absolute path to relocate durable topics, shared state, and actor sessions. Add `.pi/fabric/mesh/` to the project's ignore file unless the coordination log is intentionally versioned. Set `mesh.enabled` to `false` to disable both mesh actions and ambient actor restoration.

`mesh.actorScope` controls where persistent actor definitions, mailboxes, and child sessions are stored and restored from:

- `"project"` (default) keeps a shared actor registry at `.pi/fabric/mesh/actors/`, so actors survive `/new`. The participant directory chooses each live execution owner; other sessions keep passive views and reload on takeover. Registry writes are lock-serialized and merge only locally owned actor records.
- `"session"` isolates actors per Pi session (under `.pi/fabric/mesh/actors/<sessionId>/`). Use this when you run concurrent Pi sessions in one project and want each to own its own actors.

With project scope, each actor has one lifecycle owner and shared registry updates are ownership-aware and lock-serialized. Mesh topics, shared state, and the participant directory are always project-scoped. Every Fabric runtime publishes one short-lived host lease plus canonical records for the roots, agents, and actors it owns. `agents.members()` and `mesh.members()` read that directory; `agents.main()` and `agents.peers()` are root projections. If a host lease expires, all of its participant records disappear from normal discovery together. `mesh.actorPollMs` controls the fallback interval for actor events and owner-addressed control commands when filesystem notifications are unavailable.

## Compaction

The deterministic, LLM-free compaction engine is default-on. Set `compaction.engine` to `"pi"` to restore pi-core compaction. When pi-vcc is also installed, Fabric takes precedence for automatic compaction, while an explicit `/pi-vcc` command always uses pi-vcc's engine. See [compaction](compaction.md) for invariants, sections, and limits.
