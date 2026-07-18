# Architecture & security

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

## Tool discovery and generic calls

Inside `fabric_exec`, the `tools` surface discovers and calls any provider generically — useful when you don't know the exact ref ahead of time:

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

Known actions have first-class proxies and still cross the same registry path: `mcp.<sanitized_server>.<sanitized_tool>(args)`, `memory.*`, `state.*`, `schema.*`, and `compact.*`. For example, `mcp.fal_ai.get_model_schema(args)` resolves the mcporter names `fal-ai` and `get-model-schema`. Captured extension tools use `extensions.<tool>(args)` in full code mode. Keep `tools.call()` for refs discovered or computed at runtime.

Refs are namespaced: `pi.grep`, `extensions.<tool>`, `mcp.<server>.<tool>`, `schema.<action>`; bare names are rejected. `tools.providers()` → `[{name,description}]`; `tools.search({query,limit?})` → `FabricAction[]`; `tools.describe({ref})` → the full `FabricAction` (read its `inputSchema` first); `tools.call({ref,args?})`; `tools.list({provider?,namespace?,query?,limit?})`; `tools.models()` → Pi `[{provider,id,name,key}]`; `agents.models({runner:"claude"})` → Claude Code runtime models. The model-facing `fabric-exec` skill holds the exact signatures and the read → describe → retry error loop.

## Tool-call robustness

The model-facing `fabric_exec` schema is intentionally flat — one large `code` string plus scalar/optional parameters — with no nested arrays-of-objects containing escaped content. Newer SOTA models are post-trained on one dominant harness's flat tool shapes and can invent trailing keys at the highest-entropy point of a nested escaped-JSON field (e.g. right after closing a long multiline string), which a strict schema rejects. The only nested field, `display`, ignores unknown keys: extras are accepted by the schema and filtered to `{ name, description }` before execution, mirroring the silent-filter behavior the dominant harness's client is trained against.

Fabric's architecture is itself a mitigation for this class of bug. The model authors TypeScript that calls tools, so it never has to faithfully emit an alternative tool schema under sampling pressure; nested object construction happens in deterministic, type-checked code. The residual failure mode is incorrect TypeScript, caught by the QuickJS type-checker with an actionable, line-numbered error — the validate/report/retry loop at the code level rather than the JSON-schema level.

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
- Agent transcripts are projected from local `events.jsonl` run logs. The dashboard redacts common credentials from compact tool previews, but the permission-restricted raw event log can contain assistant text, tool arguments/results, diagnostics, and extension protocol payloads. Persisted `fabric_exec` traces also retain projected bash command text for command previews; treat retained session and run data as sensitive.
- Background one-shot children are stopped when the parent Pi session shuts down. A detached `agents.spawn()` sends a follow-up completion message unless the caller later waits for it or `notifyOnComplete` is disabled. Completed worktrees are intentionally retained.
- Persistent actors are suspended on shutdown and restored when project trust is active. Claude actor session IDs refer to Claude Code's own persisted session store; removing that private session makes resume fail, and removing a Fabric actor does not currently delete Claude Code's private transcript. By default (`mesh.actorScope: "project"`), their definitions, mailbox history, and child session files live under `.pi/fabric/mesh/actors/` and are shared across all Pi sessions in the project, so actors survive `/new`. Set `mesh.actorScope: "session"` to isolate actors per Pi session instead. Mesh topics and shared state are always project-scoped. Do not place secrets in actor prompts, messages, or mesh state.
- Approving `agents.create()` delegates future subscribed events to that actor until it is stopped. Each activation uses the actor's fixed runner/tool allowlist and its persisted model setting; review them before approving a persistent actor.
- Actor responses can enter the main context only through the delivery policy fixed at creation. Directive output is schema-validated, but it is still untrusted model output that the main agent should weigh.
- One Pi process should own the actor registry at a time. This is especially important with project scope, where concurrent Pi sessions in the same project share one registry and may race on writes. Mesh topics are append-only and are not compacted automatically; archive or remove an old mesh root when its history is no longer useful.
