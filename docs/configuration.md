# Configuration

Pi Fabric reads configuration from two JSON files. Project values override global values.

1. `~/.pi/agent/fabric.json` — global defaults.
2. `<project>/.pi/fabric.json` — project overrides, only for **trusted** projects.

`/fabric settings` defaults to project scope in trusted projects and global scope in untrusted sessions. In a trusted project, press **Ctrl+G** anywhere in the settings view to switch both the displayed values and save destination between `<project>/.pi/fabric.json` and the global `~/.pi/agent/fabric.json`. The global view shows global defaults even when a project override remains effective in the current session; the scope banner calls out that precedence. Untrusted sessions remain global-only.

Configuration documents are versioned with `configVersion`. Fabric migrates each applicable file independently before applying global/project precedence, then atomically rewrites migrated files. Version 0—the historical unversioned format—renames `subagents` to `agents`; when both sections exist, `agents` wins conflicts while non-conflicting values are preserved. Trusted project files are migrated, while untrusted project files are neither read nor rewritten. Future schema changes should be added as sequential migrations rather than runtime aliases.

`executor.runtime` selects `"quickjs"` (the default isolated WASM runtime) or `"node-process"` (a disposable native V8 process). QuickJS memory limits are capped at `4294967295` bytes because its WASM32 `size_t` cannot represent 4 GiB; larger values are rejected rather than wrapped. Node process limits may be set as high as detected physical memory and are passed to V8 as `--max-old-space-size`.

`node-process` is an explicit trusted-code escape hatch, not a security sandbox. It preserves Fabric's IPC host bridge, approvals, audit records, timeout, and cancellation, but Node's `vm` API is not a security boundary. Enable it only for workloads and projects whose generated code you are willing to run with the local user account's authority. Each invocation receives a fresh child process and is forcibly terminated when it settles, times out, or is cancelled. Schema enforce mode always forces `quickjs`. Large limits in either runtime can exhaust system memory or destabilize the machine.

## Full reference

```json
{
  "configVersion": 1,
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
      "bash": "execute",
      "fovea_sketch": "read",
      "fovea_focus": "read",
      "fovea_dwell": "read",
      "fovea_impact": "read"
    }
  },
  "mcp": {
    "enabled": true,
    "disableOAuth": true,
    "allowDynamicServers": true,
    "callTimeoutMs": 120000
  },
  "prewalk": {
    "mode": "in-place",
    "alwaysRearm": false
  },
  "agents": {
    "enabled": true,
    "runner": "pi",
    "transport": "process",
    "claude": {
      "binary": "claude"
    },
    "veda": {
      "binary": "veda",
      "backend": "agy",
      "persona": "navigator-chat"
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
    "showAgentToolPreview": true,
    "updateDebounceMs": 100
  },
  "compaction": {
    "engine": "fabric"
  },
  "retention": {
    "orphanedTempRunMs": 21600000,
    "oneShotRunMs": 86400000,
    "actorRunArchiveMs": 604800000
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

`prewalk.model` is the optional Pi `provider/model` selected by `/fabric prewalk`. `prewalk.mode` chooses how execution continues:

- `"in-place"` (default) switches Main to the executor model, queues a hidden follow-up in the same session, and restores Main's boundary model when the continuation settles.
- `"trajectory"` forks the finalized outer Fabric call/result to a visible Pi child and waits; when the child finishes, a hidden continuation turn has Main verify the work and summarize instead of going idle.

```json
{
  "prewalk": {
    "mode": "in-place",
    "model": "anthropic/claude-haiku-4-5",
    "thinking": "high",
    "alwaysRearm": true,
    "compactOnReturn": true
  }
}
```

`prewalk.thinking` is the optional reasoning effort (`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`) for the trajectory child executor, clamped to each model's supported levels. When unset, the executor inherits `agents.thinking`; in-place mode keeps Main's session level.

`prewalk.alwaysRearm` defaults to `false`. When enabled, prewalk returns to an armed, taskless state after each continuation or settled task. The settings UI labels an unset model **Ask each time**; non-interactive sessions must configure a model. In-place mode does not require child agents. Trajectory mode requires `agents.enabled` and exposes child spawn, progress, nested tools, metrics, and completion in Main's Fabric activity UI.

`prewalk.compactOnReturn` defaults to `true`. When an in-place continuation settles, Fabric requests a compaction with the configured `compaction.engine` and commits it while the executor is still the active model, so Main's restored model re-ingests the compacted transcript rather than the executor's full scratch work. Set to `false` to keep the complete transcript on Main's return.

Each in-place handoff captures Main's active model at the boundary and restores it when the continuation settles; because Pi's public `setModel` extension API also updates Pi's default model setting, the restore returns the configured default to Main's model as well. A session that ends mid-continuation leaves the executor selection persisted until the next settle.

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

Pi core calls reject when the native tool reports an error; the `{ ok: true, output, details }` shape describes successful `bash`, `edit`, and `write` calls. Catch a rejection when recovery is local. `bash` rejects on an ordinary nonzero exit; pass `settle: true` (for example `pi.bash({ command, settle: true })`) to get `{ ok: false, output, details: null, exitCode, error }` instead of a rejection. Timeout, cancellation, approval, security, and spawn failures still reject.

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

- Pi's `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls` tools stay on Pi's normal model-facing and execution paths. Fabric applies the configured risk approval policy through Pi's native `tool_call` preflight without replacing their execution or rendering.
- Registered extension tools also remain in Pi's native registry; Fabric does not hide, wrap, or expose them through `extensions.*`. Model-requested direct calls use exact `capture.risks` overrides or the conservative `capture.defaultRisk` approval class.
- `pi.*`, `extensions.*`, and equivalent `tools.call()` references are unavailable inside `fabric_exec`, including when TypeScript checks are bypassed.
- MCP and stable Fabric providers remain available through `mcp.*`, `memory.*`, `state.*`, `schema.*`, and `compact.*`; generic discovery and computed refs remain available through `tools.*`. One-shot and recursive agents, persistent ambient actors, dynamic workflows, mesh coordination, councils, explicit Fabric providers, and the Fabric TUI also remain available.
- Child agents continue using their allowed Pi tools directly, so parallel and ambient setups do not route their coding operations back through Fabric code mode.

### Where to set it

`fullCodeMode` defaults to `true`. A project can set the flag in `.pi/fabric.json`, or a user can set it globally in `~/.pi/agent/fabric.json`. `/fabric settings` toggles it too.

## Captured extension tools

When `fullCodeMode` is enabled, Fabric intercepts Pi's `ExtensionRunner.getAllRegisteredTools()` registry chokepoint. This captures tools registered by other extensions at startup or later through `pi.registerTool()`, regardless of whether those extensions load before or after Fabric.

Captured custom tools drop out of the model's active tool set by default, so their schemas, snippets, and guidelines do not consume the parent model context and the model can only reach them through `fabric_exec`. The tools stay **registered** in Pi's runtime — `pi.getAllTools()` keeps listing them — so host extensions that gate or audit tool calls by name (for example `@gotgenes/pi-permission-system`, which blocks names missing from that list before its own rules run) still see them as registered and evaluate nested captured calls through their normal policy and prompts. The extension itself remains loaded: its commands, event handlers, state, and UI continue to work. Only model-facing exposure and invocation become lazy.

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

Extension overrides of core tools are captured and hidden with their built-in counterparts in full code mode. Inside Fabric, `pi.read`, `pi.bash`, and the other built-ins automatically route through a captured override when one exists; `extensions.read` exposes the override's full native result shape. `capture.keepVisible` can re-activate non-core extension tools so the model may also call them directly on Pi's native path, but core tool names are always excluded while full code mode owns them.

## Approvals and risk

Fabric risk classes are `read`, `write`, `execute`, `network`, and `agent`; approval policy values are `allow`, `ask`, `auto`, or `deny`. Policies apply both to actions invoked inside `fabric_exec` and to top-level model-requested tools left on Pi's native path. Native calls keep Pi's original implementation, result shape, and renderer; only the supported pre-execution interception hook is added.

- Captured and directly registered tools default to the conservative `execute` risk because Pi tool definitions do not declare effects. Add exact tool-name overrides under `capture.risks`. Fovea's verified graph-navigation tools (`fovea_sketch`, `fovea_focus`, `fovea_dwell`, and `fovea_impact`) are read-only exceptions and default to `read`.
- Set `capture.hideFromModel` to `false` to index non-core extension tools without hiding them from the model's active set.
- `capture.keepVisible` names stay in both Fabric and Pi's model-facing active set, except that Pi core names are always Fabric-owned in full code mode.
- `capture.advisory` injects a capability hint at `before_agent_start` when the prompt's terms match a captured source's tf-idf fingerprint (names + descriptions grouped by source namespace, no manifest declarations needed). `mode: "enabled"` (default) renders the hint in the transcript, `"hidden"` delivers it to the model only, and `"disabled"` turns it off. Each capability fires at most once per session — ash is derived from the session transcript itself (a fired hint is its own custom-message entry; organic use is its own tool call), so reloads and `/tree` branch rewinds replay ashes exactly up to the current point, and a brand-new session starts with a clean urn; `maxPerSession` (default 3) caps hints within a session, `threshold` (default 0.9) tunes sensitivity, and `budget` (default 512, clamped 128–8192 — same range as [pi-fovea](https://github.com/monotykamary/pi-fovea)'s `sync.budget`) caps the advisory text in tokens (estimated as chars/4; rendering walks a degradation ladder — one ▪ bullet per tool with descriptions → names-only bullets → one bullet per source → `header + steer` — until a rung fits; the ladder keeps leftover tools addressable in a `~ +N more in <source>` counter). The matcher follows a combustion model: 1/df-weighted term scoring, strong matches fire instantly, weak matches accumulate warmth ($W \leftarrow \frac{1}{2}W + \frac{1}{2}s$; ignites at $W \geq$ threshold), each namespace's fire-set is durable *ash* (`fired` or `organic` — organic covers tools you used without a hint) derived from the session transcript itself, and ignored fires push smoke streaks that raise the weak-band ignition point by $\theta/\tau^2$ per streak ($0.25\theta$ at the internal memory scale $\tau = 2$ — every internal constant projects from $\tau$ and the score quantum $q = 1$). See [docs/capability-combustion.md](docs/capability-combustion.md) for the full math. Skill markup pi expands into the prompt (`<available_skills>`/`<skill>` blocks) is stripped before matching so a loaded skill cannot trigger its own hint. The hint follows fovea's icon/indent shape: a compact headline naming the matched sources, ▪ bullet rows for the refs, a `Next:` schema/action line for the top ref, and a `Steer:` directive.
- An `ask` policy emits a warning notification and opens an explicit **Allow once** / **Allow for this session** / **Deny** permission prompt, matching Claude-style approval scopes. **Allow once** authorizes only the requested action. **Allow for this session** authorizes that risk class until the current Pi session ends. The TUI uses an inline wizard; RPC clients receive the equivalent `select` dialog.
- Concurrent requests are serialized so a one-time approval never silently widens to sibling calls. Session-wide grants are shared between native calls and `fabric_exec`. Escape, dismissal, unavailable interactive UI, and session restart all fail closed.

### Auto approval mode

An `auto` policy routes each validated call and its prepared arguments through a separate Pi model before invocation. Configure **Auto model** under `/fabric settings` → **Approvals**, or set the optional canonical `provider/model` key in `fabric.json`:

```json
{
  "approvals": {
    "model": "anthropic/claude-opus-4-6",
    "write": "auto",
    "execute": "auto",
    "network": "auto",
    "agent": "auto"
  }
}
```

Choosing **Inherit** in the model picker omits `approvals.model` and uses the active Pi session model. Built-in and custom models dispatch through Pi's effective provider runtime, including providers with custom API identifiers; older supported Pi versions fall back to their compatibility provider registry. Read access remains independently configurable and is normally left as `allow`.

The classifier receives the exact action, bounded prepared arguments, cwd, user-message text, and assistant tool calls. Assistant prose and tool outputs are excluded so model-authored reasoning and retrieved hostile content cannot directly instruct the classifier. It has no executable tools and must return a structured `allow` or `escalate` verdict. `allow` applies only to that call. `escalate`, malformed output, missing authentication, timeout, cancellation, or any classifier error falls back to the explicit **Allow once** / **Allow for this session** / **Deny** prompt; headless runs fail closed when that prompt cannot be shown. Classifier token usage and cost are attached to the resulting `fabric_exec` or native tool result, and Fabric execution traces record each nested verdict as `fabric.approval.auto`.

`deny` remains deterministic and is evaluated before the classifier. Schema enforcement, project trust, budgets, and other host gates also remain authoritative. Auto mode is a model-based policy advisor, not a stronger sandbox boundary. Its initial conservative policy escalates destructive or irreversible actions, shared/external/production changes, credential or sensitive-data exposure, safety bypasses, actions beyond explicit user intent, and actions whose safety is uncertain. This follows the architecture described in Claude Code’s [permission modes](https://code.claude.com/docs/en/permission-modes), [auto-mode configuration](https://code.claude.com/docs/en/auto-mode-config), and Anthropic’s [auto-mode engineering write-up](https://www.anthropic.com/engineering/claude-code-auto-mode), adapted to Pi’s model registry and Fabric’s existing per-risk policy gate.

## Temporal retention

Fabric clears inactive run artifacts by age rather than truncating active JSONL files. The defaults are:

- `retention.orphanedTempRunMs` — remove a temporary run root six hours after its owner process dies. Active roots carry a heartbeat marker and are never removed.
- `retention.oneShotRunMs` — retain terminal one-shot agent run artifacts for 24 hours. Explicit `agents.cleanup()` may remove them sooner; otherwise graceful shutdown marks their temporary root closed for temporal cleanup.
- `retention.actorRunArchiveMs` — retain terminal actor run archives for seven days. The latest run for each actor is always preserved.

Cleanup runs during active Fabric sessions and when a new top-level run manager starts. It never truncates active run logs or actor `session.jsonl` files. `/fabric settings` exposes all three values under **Retention**; changing them requires `/fabric reload`.

## Agents

`agents.runner` selects the default harness (`"pi"`, `"claude"`, or `"veda"`). `agents.model` is the optional Pi `provider/id` override; `agents.claude.model` is the optional canonical Claude runtime key. `agents.claude.binary` defaults to `claude` and can be an absolute path or wrapper; `PI_FABRIC_CLAUDE_BINARY` overrides it for the current process. `/fabric settings` enumerates Claude models from that binary in the background and stores the two runner defaults independently.

The `veda` runner drives the [Veda CLI](https://github.com/kennyfrc/veda) as the child harness. `agents.veda.binary` defaults to `veda` (an absolute path or wrapper works, and `PI_FABRIC_VEDA_BINARY` overrides it for the current process). `agents.veda.backend` selects which backend Veda wraps — `agy` (Antigravity CLI, the default), `codex`, `claude-code`, `droid`, `pi`, or another backend registered by the installed Veda build. Fabric passes this value through unchanged and does not hardcode AGY. `agents.veda.model` is an optional backend-specific model or Veda alias; if omitted, Veda selects its own backend default. `agents.veda.persona` picks the global Veda persona: `navigator-plan`, `navigator-chat` (default), `reviewer`, `worker`, or a custom persona under `~/.config/veda/personas/<name>/AGENTS.md`. Per-run selection overrides it via `agents.run({ persona })`. The Veda backend, persona, and model are also editable from the Fabric settings panel under Agents. Each child runs one headless `veda --json` prompt with an isolated `fabric-<run-id>` session, so parallel children never share Veda selection or conversation state. Veda sessions are not persistent and steering is unsupported; Veda children are **not** recursively Fabric-equipped (`recursive: true` is rejected) and cannot back persistent actors.

Fabric worker processes are JavaScript modules launched by a JS runtime. When Pi runs as a generic Node.js or Bun runtime (`process.execPath` is `node`/`bun`), that runtime is reused. When Pi ships as a Bun-compiled single-file binary (`process.execPath` is the `pi` executable, not node/bun), Fabric resolves a runtime from `PI_FABRIC_NODE_BINARY`, otherwise from the first `node` or `bun` on `PATH`, and only the resolved runtime launches workers — never the bundled binary itself. `PI_FABRIC_NODE_BINARY` overrides this for the current process. The Node-process executor (`executor.runtime: "node-process"`) always requires Node.js specifically, since its `--eval`/`--input-type=module` flags are Node-only.

Other agent settings:

- `thinking` — default reasoning effort (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`), default `medium`.
- `maxConcurrent` — global child concurrency semaphore.
- `maxPerExecution` — hard cap on children per `fabric_exec` invocation.
- `maxDepth` — nesting bound for child agent calls, including `rlm.query()`. Accepts any non-negative safe integer; `0` disables child spawning. `/fabric settings` provides free-form numeric entry.
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
- `ui.showAgentToolPreview` defaults to `true` and controls child-agent/actor tool rows in both the parent `fabric_exec` card and widget. Recursive agents render their full descendant tree (bounded by the preview depth/node budget); renamed from `ui.showNestedToolCalls` by the version 2 config migration.
- `ui.updateDebounceMs` defaults to `100` and applies one execution-wide coalescing interval to every live `fabric_exec` card update — nested calls, progress text, and agent tool previews. Continuous streams emit at most once per interval instead of postponing every render until completion. Set it to `0` to emit every update; accepted values are clamped to `0..2000`. Renamed from `ui.nestedToolDebounceMs` by the version 3 config migration.
- The widget renders above the chat (like `pi-supervisor`); set `ui.enabled` to `false` to disable both the widget and dashboard controller.

See the [interface reference](interface.md).

## Mesh

Mesh data defaults to `<project>/.pi/fabric/mesh`. Set `mesh.root` to a relative or absolute path to relocate durable topics, shared state, and actor sessions. Add `.pi/fabric/mesh/` to the project's ignore file unless the coordination log is intentionally versioned. Set `mesh.enabled` to `false` to disable both mesh actions and ambient actor restoration.

`mesh.actorScope` controls where persistent actor definitions, mailboxes, and child sessions are stored and restored from:

- `"project"` (default) keeps a shared actor registry at `.pi/fabric/mesh/actors/`, so actors survive `/new`. The participant directory chooses each live execution owner; other sessions keep passive views and reload on takeover. Registry writes are lock-serialized and merge only locally owned actor records.
- `"session"` isolates actors per Pi session (under `.pi/fabric/mesh/actors/<sessionId>/`). Use this when you run concurrent Pi sessions in one project and want each to own its own actors.

`mesh.eventContextChars` bounds the sanitized JSON context attached to each host-event activation. Images are extracted before this bound, represented by redacted descriptors in actor mailboxes and the registry, and forwarded out of band to the actor runner automatically; the configured character bound does not truncate their base64.

With project scope, each actor has one lifecycle owner and shared registry updates are ownership-aware and lock-serialized. Mesh topics, shared state, and the participant directory are always project-scoped. Every Fabric runtime publishes one short-lived host lease plus canonical records for the roots, agents, and actors it owns. `agents.members()` and `mesh.members()` read that directory; `agents.main()` and `agents.peers()` are root projections. If a host lease expires, all of its participant records disappear from normal discovery together. `mesh.actorPollMs` controls the fallback interval for actor events and owner-addressed control commands when filesystem notifications are unavailable.

## Compaction

The deterministic, LLM-free compaction engine is default-on. It keeps Pi's bounded `keepRecentTokens` continuity tail; `compaction.targetContextRatio` is a hard occupancy ceiling rather than a fill target. Set `compaction.engine` to `"pi"` to restore pi-core compaction. When pi-vcc is also installed, Fabric takes precedence for automatic compaction, while an explicit `/pi-vcc` command always uses pi-vcc's engine. See [compaction](compaction.md) for invariants, loss guarantees, sections, and limits.
