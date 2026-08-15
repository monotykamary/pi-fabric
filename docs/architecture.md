# Architecture & security

## Architecture

```text
fabric_exec
    │
    ▼
TypeScript checker → QuickJS sandbox (default)
                   └→ disposable Node process (unsafe opt-in)
    │ JSON-only host bridge
    ▼
ActionRegistry ◀── staged commit ── ComponentSupervisor
    ├── pi.*                          ├── pinned first-party providers
    ├── extensions.*                  └── configured and discovered components
    ├── mcp.*
    ├── agents.* ──▶ actors + participant control
    ├── mesh.* ──▶ state.*
    ├── schema.*
    ├── memory.*
    ├── compact.*
    ├── components.* kernel diagnostics and reload
    └── external providers

ActivityStore → compact widget + footer status + interactive dashboard
```

In the default QuickJS runtime, guest code runs without `process`, `require`, filesystem, network, or subprocess globals. Every effect crosses the host bridge, and schemas, approvals, audit records, timeouts, and cancellation apply there. Each execution gets a fresh QuickJS context. Strings the caller names in the `strings` tool parameter appear as `π.key`. Reading a missing key throws a clear, actionable error that lists the provided keys.

The optional `node-process` executor runs the same type-checked guest API and host-call protocol inside a fresh child process with a configurable V8 heap. It serves workloads that exceed the WASM32 memory ceiling. This mode is not a security boundary, because Node's `vm` module cannot safely contain hostile code. Fabric restricts this mode to trusted configuration and describes it as unsafe in `/fabric settings`. Schema enforce mode disables it. Parent-side deadlines and cancellation terminate the whole child process.

## Component control plane

The [component plane](components.md) supervises provider registry changes under the lifecycle laws and author duties in the [component calculus](component-calculus.md). A [provider specialization](provider-component-calculus.md) applies those rules to first-party namespaces and rolling replacement.

Before activation, a definition declares its required actions and optional services while the loader resolves a capability view with versioned descriptor hashes. Mounted providers stay staged until their effects finish and the target passes a second check, which makes publication atomic.

Replacement retires the old generation, which makes dependents unload before its provider inverse runs. Retained views and active calls can use that generation until quiescence. Transition epochs prevent stale publication at yield boundaries, and disjoint provisions keep each namespace unique. Parent-owned child fibers unwind before the parent. Effect scopes apply their inverses in LIFO order and send cleanup failures to quarantine.

The dashboard renders the requirement graph as a component group. Participant ownership uses a separate topology. Enabled first-party providers mount through pinned components. `components.*` remains in the kernel and controls the graph. Runtime initialization completes each pinned mount before it creates the execution service.

The same committed-view protocol can close an actor child's Fabric surface around a portable descriptor digest. The child resolves that digest, then each nested call uses the pinned view. This behavior defines capability coherence. Host component code runs as trusted code outside the sandbox.

## Tool discovery and generic calls

Inside `fabric_exec`, the `tools` surface discovers and calls any provider generically. This helps when you do not know the exact ref ahead of time:

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

Known actions keep first-class proxies, and they still cross the same registry path: `mcp.<sanitized_server>.<sanitized_tool>(args)`, `memory.*`, `state.*`, `schema.*`, `components.*`, and `compact.*`. `mcp.fal_ai.get_model_schema(args)` resolves the mcporter names `fal-ai` and `get-model-schema`. Captured extension tools take the form `extensions.<tool>(args)` in full code mode. Reserve `tools.call()` for refs you discover or compute at runtime.

Refs are namespaced: `pi.grep`, `extensions.<tool>`, `mcp.<server>.<tool>`, `schema.<action>`. Calls with bare names are rejected. `tools.describe({ref})` falls back to a bare action name when exactly one provider exposes it, and ambiguous names return an error that lists the qualified refs. `tools.providers()` → `[{name,description}]`; `tools.catalog({provider?,limit?})` → the deterministic current provider/action head tree with descriptor hashes and explicit non-historical metadata; `tools.search({query,limit?})` → `FabricAction[]`; `tools.describe({ref})` → the full `FabricAction` (read its `inputSchema` first); `tools.call({ref,args?})`; `tools.list({provider?,namespace?,query?,limit?})`; `tools.models()` → Pi `[{provider,id,name,key}]`; `agents.models({runner:"claude"})` → Claude Code runtime models. For the exact signatures and the read → describe → retry error loop, see the model-facing `fabric-exec` skill.

## Tool-call robustness

The model-facing `fabric_exec` schema is flat. It carries one large `code` string plus scalar/optional parameters, and it contains no nested arrays-of-objects holding escaped content. Newer SOTA models are post-trained on one dominant harness's flat tool shapes. Such models can invent trailing keys at the highest-entropy point of a nested escaped-JSON field, for example right after closing a long multiline string, and a strict schema rejects those keys. The only nested field, `display`, ignores unknown keys. The schema accepts extras and filters them to `{ name, description }` before execution, which mirrors the silent-filter behavior the dominant harness's client is trained against.

The model writes TypeScript that calls tools. Deterministic, type-checked code builds each nested object. Fabric's TypeScript checker catches incorrect code and returns an actionable error with line numbers.

Pi Fabric applies a narrow compatibility layer at each boundary before authoritative validation runs. The outer `fabric_exec.prepareArguments` hook wraps a root code string, joins all-string code arrays, omits null optional metadata, and canonicalizes `display`. Inside the guest, `pi.*` calls normalize positional forms, observed field aliases, numeric strings, and known optional nulls. The registry then validates against the native Pi schema. Required nulls, mixed arrays, unknown keys, and otherwise ambiguous shapes still fail normally.

For provider-level corruption, or for sessions that expose Pi tools directly, install [pi-tool-repair](https://github.com/monotykamary/pi-tool-repair) as a companion. Pi 0.84 validates before `tool_call`. The companion repairs the finalized assistant `toolCall` arguments at `message_end` against each active tool's live schema, and it revalidates them before committing. In full code mode it can repair the outer `fabric_exec` call, leaked tool-call grammars, anchor bleed, and phantom tool-use responses. Fabric stays responsible for nested `pi.*` calls that the TypeScript guest creates later. The packages register no competing tool wrappers.

The provider owns the Anthropic strict tool use setting. When enabled, strict mode stops the server from sampling keys that are absent from the schema. Anthropic limits the complexity of strict tool definitions.

## Model-context economy

Fabric caps final `fabric_exec` output at 50,000 characters by default, which matches Pi's built-in 50KB tool ceiling. Failed executions get a tighter 20,000-character visible ceiling, and the complete output stays in the same private artifact. An oversized structured return shares that budget across every multiline section and preserves both ends with explicit omission markers. Unstructured output keeps its global beginning and end. Fabric writes the complete output to a mode-`0600` temporary artifact and includes the artifact path inside the visible ceiling. The model can then retrieve a targeted range without carrying the entire result. Type-check diagnostics use the same ceiling. Models should still filter noisy commands and return only useful evidence, because source-side projection preserves more relevant information than post-format truncation. When a later nested call fails after earlier calls completed, the error adds a bounded list of completed refs and paths. The model can inspect that list before repeating side effects. Nested outputs the guest did not return are never exposed.

## Federated participant topology

Fabric separates **identity** from **execution ownership**. Each root, one-shot or recursive agent, and actor carries a single intrinsic participant record with `rootId`, optional `parentId`, `ownerHostId`, `residency`, and the owner's authenticated wire identity. Main and Peer are projections of root records. Every process publishes one leased host record plus the participants it manages directly. An ancestor never re-advertises recursively discovered UI descendants. Readers treat every record behind an expired host as stale. Crash cleanup then covers the whole host. Shared summaries contain operational metadata only. Agent prompts, results, and errors stay local. Local run/actor managers overlay richer private detail only when the directory marks that participant local.

Cross-process control targets one resolved owner. To send a command, the sender resolves a participant, addresses a versioned command to its owner host, and accepts an acknowledgement only when the target and sender identity match that owner. At startup, owners replay the bounded retained log. They CAS-claim command IDs in reserved state and persist acceptance before acknowledging. After a restart, they acknowledge recorded commands again. Each accepted command executes at most once. A crash between the claim and durable acceptance returns an explicit indeterminate rejection on replay. This preserves at-most-once execution. Before accepting, the owner re-resolves against its local managers. Unknown, stale, rejected, spoofed, replayed, and timed-out commands fail closed. Control topics and topology/legacy state prefixes are reserved from guest mesh writes. The old `fabric.steer` event relay plus dual-written root/actor presence remain a mixed-version compatibility path. Pi children inherit absolute project and mesh roots, including worktree and recursive launches, so descendants join the same topology.

## Security and limitations

- When no captured override exists, Pi Fabric invokes separately constructed Pi built-in definitions. With Pi's extension runner available, Fabric replays their native `tool_call`, `tool_result`, and `tool_execution_*` lifecycle. Captured overrides and extension tools use that same lifecycle. Fabric's approval and audit layer stays authoritative around every nested call.
- A captured exact-name core override contributes only a bounded, execution-local object overload and authored guidance to its existing `pi.<name>` slot. Built-in shorthand and normalized result contracts remain unchanged; the live registry schema remains the argument validator.
- Non-Pi provider results emit a transient namespaced `tool_result` proxy before the QuickJS result bound. The proxy's details envelope exposes the exact host-side result to trusted user extensions. Those extensions can inspect or externalize sensitive provider data. The proxy does not create a separate persisted tool-result message.
- Captured tools execute with the full privileges of their owning extension. Hiding a tool schema optimizes context. It does not sandbox anything. Captured tools keep their definitions and native renderers. Nested calls still render inside the enclosing Fabric execution, so they do not appear as separate native tool rows.
- Registry interception composes through the public `ExtensionRunner.getAllRegisteredTools()` method. If an extension replaces that method and fails to delegate to the previous implementation, it can prevent capture.
- MCP servers, external providers, and component definitions execute with their own host privileges. Review their configuration and code before you enable them. Component effect scopes can unwind registered effects only. Ambient side effects hidden from the supervisor are outside their reach.
- Type checking improves reliability. It is not a security boundary. In the default runtime, QuickJS isolation and the host capability bridge form the boundaries. The optional Node process runs as trusted native execution outside the QuickJS boundary.
- Child Pi processes load normal extensions by default, so provider-backed models keep working. Claude children use the official installed CLI with its existing authentication. Both runners restrict the active model-facing tools to `defaultTools`. Pi adds `fabric_exec` only for explicit recursion. Claude rejects recursion and unmapped tools.
- `agents.handoff` schedules an explicit `agent`-risk delegation at the complete outer `fabric_exec` boundary. The guest call returns a deferred marker, and the rest of the Fabric program continues. Once every nested call and the outer result middleware finish, Fabric forks through the native assistant `fabric_exec` entry, appends its exact finalized native `toolResult`, and starts the target from that branch. Fabric does not create synthetic nested assistant turns or a custom context dump. The mode-`0600` child session lives inside the managed run directory. The source session and its history stay unchanged. Normal outer output and trace limits apply before the fork. The target model can see the Fabric source and result, so do not hand off a trajectory that contains secrets to a provider that should not receive them.
- `/fabric prewalk` pre-authorizes the same one-shot delegation through `prewalk.model` or an interactively selected Pi executor. The command adapts [Stencil's Prewalk](https://stencil.so/blog/prewalk) and [oh-my-pi's in-place implementation](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/session/agent-session.ts) into a prompt-free form. It uses a coarser atomic boundary. The first monitored mutation marks the outer Fabric invocation, every remaining nested call still runs, and the executor starts only from the complete native `fabric_exec` call/result pair.
- Claude `extensions: true` preserves the user's normal Claude Code customizations, including applicable settings and hooks. Those hooks execute with their usual host privileges. Set `extensions: false` for Claude safe mode. When allowed, `Bash` stays unrestricted inside the child, in the same way as Fabric's `bash` capability.
- Claude model discovery sends a local initialization control request and never invokes a model. One-shot and actor activations use the account or API billing already configured in Claude Code. Fabric records the CLI's reported `total_cost_usd` in its normal usage and budget ledgers.
- A Git worktree isolates files. It does not isolate credentials, network access, processes, or external services.
- Fabric projects agent transcripts from local `events.jsonl` run logs. The dashboard redacts common credentials from compact tool previews. The permission-restricted raw event log can still contain assistant text, tool arguments and results, diagnostics, and extension protocol payloads. Persisted `fabric_exec` traces also retain projected bash command text for command previews. Treat retained session and run data as sensitive.
- Fabric stops session-resident background children when the parent Pi session shuts down. A hidden per-root resident host launches `agents.spawn({ residency: "durable" })`, and that child continues after the TUI exits. A detached spawn sends a follow-up completion message unless the caller later waits for it or `notifyOnComplete` is disabled. Resident completion messages queue in mesh state until Main resumes. Durable participant lifecycle subscriptions deliver source-qualified Pi and run notifications across roots, agents, and actors with no transcript disclosure. Completed worktrees are retained on purpose.
- Fabric suspends session-resident persistent actors on shutdown and restores them when project trust is active. `agents.create({ residency: "durable" })` cedes the actor to the hidden resident host before returning. Its mailbox, mesh subscriptions, relayed Main events, and runner session stay active after Main shuts down. Claude actor session IDs refer to Claude Code's own persisted session store. Removing that private session makes resume fail. Fabric does not currently delete Claude Code's private transcript when you remove a Fabric actor. By default (`mesh.actorScope: "project"`), actor definitions, mailbox history, and child session files live under `.pi/fabric/mesh/actors/` and are shared across all Pi sessions in the project, so actors survive `/new`. Set `mesh.actorScope: "session"` to isolate actors per Pi session. Mesh topics and shared state are always project-scoped. Do not place secrets in actor prompts, messages, or mesh state.
- Approving `agents.create()` delegates future subscribed events to that actor until someone stops it. With durable residency, that delegation outlives the approving TUI process. Each activation uses the actor's fixed runner plus its persisted tool allowlist and model setting. Review those settings before you approve a persistent actor. Tool changes apply only to later activations.
- Only an approved durable `agents.spawn` or `agents.create` action in a trusted mesh-enabled project starts the hidden resident host. Its mode-`0600` config, command spool, run metadata, and PID lock live below the root's mesh residency directory. This IPC is crash-conservative: an interrupted claimed request reports an indeterminate outcome, and the request is not replayed. The IPC is not a boundary against arbitrary host filesystem access. Trusted code with direct access to `.pi/fabric` can corrupt residency state in the same way it can corrupt the mesh. Empty resident hosts exit after a short grace period.
- Actor responses enter the main context only through the delivery policy fixed at creation. Directive output passes schema validation. It is still untrusted model output, and the main agent should weigh it.
- Project-scoped actor execution is ownership-gated. Passive sessions do not consume events, run mailboxes, expose private actor data, mutate settings, or persist shutdown state. They reload the registry after acquiring ownership. A persisted actor may have no live owner advertised, through an expired or missing host lease, while its lineage root is also absent from the live participant directory. In that case, a later residency-matched host may adopt the actor and rebind its `rootId`. Adoption is a fenced registry write: ownership is granted only after the rebound `rootId` and an `adoptedAt` fencing timestamp persist under the registry lock. Simultaneous starters converge on exactly one adopter. A lineage adopted within the 30s grace window stays with its adopter. The adopter can remain absent from the participant directory during that window. Shared `actors.json` updates use a stale-safe lock plus an ownership-aware read, merge, and write cycle, so one actor owner cannot overwrite another owner's newer records. Use session scope when roots should define fully independent actor sets. Mesh events are append-only until bounded log compaction retains the newest tail. Archive or remove an old mesh root when even that retained history stops being useful.
