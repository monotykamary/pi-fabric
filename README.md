# pi-fabric

A programmable tool and agent runtime for [Pi](https://github.com/earendil-works/pi).

Pi Fabric gives the model one `fabric_exec` tool for type-checked TypeScript programs that can compose Pi's built-in tools, dynamically discovered MCP tools, child Pi agents, councils, and bounded recursive queries. Intermediate values stay inside a QuickJS sandbox; only the final result returns to the model context.

## Status

Pi Fabric is an early implementation. The core runtime, built-in tools, MCP provider, provider protocol, approval policies, guarded subagents, council helper, and recursive query helper are implemented. Review the security notes before enabling mutating tools or external providers.

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

The tool accepts a TypeScript function body with top-level `await` and `return`:

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

| Transport | Behavior | Attach command |
| --- | --- | --- |
| `process` | Detached local worker process; default and lowest overhead | none |
| `tmux` | One detached tmux session per child | `tmux attach-session -t …` |
| `screen` | One detached GNU Screen session per child | `screen -r …` |
| `localterm` | One pinned LocalTerm PTY per child | `localterm session attach …` |
| `auto` | Tries LocalTerm, tmux, screen, then process | transport-specific |

LocalTerm already exposes the needed tmux-parity primitives: detached creation, pinning, listing, capture, exec, attach, and kill. Pi Fabric therefore requires no LocalTerm patch. Start its daemon before selecting it:

```bash
localterm start
```

Use `/fabric agents` to list children and `/fabric attach <id>` to display the appropriate attach command. Abort signals propagate to the transport and child Pi process.

Set `worktree: true` to create a dedicated Git worktree and `pi-fabric/<name>-<id>` branch. Worktrees are retained for inspection until `agents.cleanup()` is called.

### Supervisors

Extensions can expose persistent host-side supervisors through the provider protocol. [`pi-supervisor`](https://github.com/monotykamary/pi-supervisor) registers `supervisor.start` and `supervisor.status` when both packages are loaded:

```ts
await tools.call({
  ref: "supervisor.start",
  args: { outcome: "Complete the auth migration with passing tests" },
});
return tools.call({ ref: "supervisor.status" });
```

Supervisor lifecycle hooks remain outside the guest VM. The model cannot stop or replace active supervision; those controls remain user-only.

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

## Configuration

Pi Fabric reads:

1. `~/.pi/agent/fabric.json`
2. `<project>/.pi/fabric.json`, only for trusted projects

Project values override global values.

```json
{
  "executor": {
    "timeoutMs": 120000,
    "memoryLimitBytes": 67108864,
    "maxOutputChars": 100000,
    "maxNestedResultChars": 2000000
  },
  "approvals": {
    "read": "allow",
    "write": "ask",
    "execute": "ask",
    "network": "ask",
    "agent": "ask"
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
    "maxDepth": 2,
    "timeoutMs": 600000,
    "extensions": true,
    "defaultTools": ["read", "bash", "edit", "write", "grep", "find", "ls"],
    "retainRuns": false,
    "notifyOnComplete": true
  }
}
```

Approval values are `allow`, `ask`, or `deny`. An `ask` policy is fail-closed in headless modes without interactive UI. Approval is cached by risk class for one `fabric_exec` execution.

When `mcp.disableOAuth` is true, MCP calls may use cached credentials but cannot launch a new interactive OAuth flow.

## External provider protocol

Pi does not expose other extensions' tool executors. Fabric providers must opt in through the versioned event protocol:

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
    async list() { return []; },
    async describe() { return undefined; },
    async invoke() { return null; },
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

Providers own their schemas, state, and execution semantics. Pi Fabric validates arguments, enforces the declared risk policy, records nested-call audits, and propagates cancellation.

## Commands

```text
/fabric status
/fabric reload
/fabric providers
/fabric agents
/fabric attach <id>
/fabric stop <id>
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
    ├── pi.*       built-in Pi tool definitions
    ├── mcp.*      pooled mcporter runtime
    ├── agents.*   process/tmux/screen/LocalTerm workers
    └── external   explicit pi.events providers
```

Guest code has no `process`, `require`, filesystem, network, or subprocess globals. All effects cross the host bridge, where schemas, approvals, audit records, timeouts, and cancellation apply. Each execution receives a fresh QuickJS context. Named strings passed in the `strings` tool parameter are available as `π.key`.

## Security and limitations

- Pi Fabric invokes separately constructed Pi built-in tool definitions. Nested calls do not pass through Pi's top-level `tool_call` and `tool_result` extension hooks. Fabric's own approval and audit layer is therefore authoritative for nested calls.
- MCP servers and external providers execute with their own host privileges. Review their configuration and code.
- Type checking improves reliability but is not a security boundary; QuickJS isolation and the host capability bridge are the boundaries.
- Child Pi processes load normal extensions by default so provider-backed models continue to work. Their active tool list is restricted by `defaultTools`; `fabric_exec` is excluded unless recursion is explicitly requested.
- A Git worktree isolates files, not credentials, network access, processes, or external services.
- Background children are stopped when the parent Pi session shuts down. A detached `agents.spawn()` sends a follow-up completion message unless the caller later waits for it or `notifyOnComplete` is disabled. Completed worktrees are intentionally retained.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

The deterministic test suite covers configuration, schema validation, provider dispatch, QuickJS isolation, Pi built-in invocation, and direct-process subagents.

## License

MIT
