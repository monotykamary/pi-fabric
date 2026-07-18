# Programmatic compaction

Programmatic compaction lets the model (or a skill, or a peer) **ask** the host
to compact its own context — or a running subagent's context — at a safe
boundary, instead of compaction being only a token-threshold reflex. It is the
distillation of two proven ideas into first-principles primitives native to
pi-fabric:

- **Harness enforcement** motivates a single gated channel from thought to
  action, with the host — not the model — deciding when it is safe to act.
- **Deterministic compaction** avoids adding another model call to a context
  transition and makes repeated results testable.

Both point at the same primitive: compaction should be a **deliberate,
labeled transition** of the agent's own context, requested by the model
(**advisory**) and committed by the host only at a safe boundary
(**committed**).

## Why advisory-then-committed

The model runs inside the context it would compact. If it could compact the
running context directly, it would race with its own in-flight turn: tool calls
mid-execution, partial plans, and unresolved steering. Pi Fabric avoids that
race with a typed, validated write path and an open status path.

Pi Fabric therefore exposes compaction as **two separable acts**:

1. **Advisory** — `compact.request` (host) or `agents.compact` (child) only
   *records an intent*. It never touches the context. It is a write-risk,
   schema-validated declaration: "I think this context should be
   compacted, with these instructions, for this reason."

2. **Committed** — the host, at a boundary it knows to be safe, forwards the
   intent to `ExtensionContext.compact()` (host) or to the child pi's `compact`
   RPC frame (child). For the host, that boundary is `agent_settled`: the
   handler awaits Pi's callback completion or error before Pi publishes its
   public settled event. For a child, the worker waits for the child's own
   `agent_settled`, then sends a correlated compact request and keeps the RPC
   channel open until it observes both the response and `compaction_end`. It
   never sends compact while the child turn is active.

There is exactly one write path from intent to action. The model cannot
compact the running context directly; it can only ask. The ask is a single
replaceable slot — a new request replaces the pending one, keeping the latest
instructions.

## First principles, mapped

| Principle | How programmatic compaction realizes it |
| --- | --- |
| The context is a cache, not the store. | Compaction is an explicit, labeled transition of the cache, not a silent eviction. The intent and the last commit are recorded outside the context (`status()`) and survive it. |
| Derived views are pure functions of the log. | `CompactStatus` is a pure snapshot of the controller's recorded intents and commits — never of the compacted context itself. |
| Enforcement in the harness beats discipline in the prompt. | The model only *requests*; the host *commits* at `agent_settled`. The gate is in the harness (`maybeCommit` + the `agent_settled` handler), not in the prompt. |
| Compaction is a deliberate, advisory-then-committed act at a model-chosen task boundary. | The model chooses *when to ask* and *with what instructions*; the host chooses *when to commit* (a safe boundary). A token-threshold reflex still exists in pi core; this adds a deliberate path on top of it. |

## API surface

### Host session — the `compact` provider

Always available (no config guard). Exposed through `fabric_exec` as
`compact.request`, `compact.status`, `compact.cancel`.

```ts
// Record an advisory intent. Replaces any pending one. Returns immediately;
// the host commits it at the next agent_settled boundary.
await compact.request({
  reason: "the file map and the failing test are the only live state",
  instructions: "Keep the failing test name and the file map; drop the rest.",
  preserve: ["Auth regression is still open", "tests/auth.test.ts"], // optional
  requestedBy: "model", // optional; default "model"
});

// Read the pending intent and the last committed/failed compaction info.
const status = await compact.status();
// { pending?: { reason?, instructions?, preserve?, requestedBy, requestedAt },
//   last?:   { at, requestedBy, status: "committed"|"failed",
//             summary?, tokensBefore?, estimatedTokensAfter?, error? } }

// Clear a pending intent before the host commits it.
await compact.cancel();
```

Risk classes: `request` is `write` (it mutates host session state); `status`
and `cancel` are `read`.

`instructions` alone is forwarded as ordinary Pi `customInstructions`, so manual
`/compact` text and programmatic requests have the same Fabric rendering. When
`preserve` is present, the controller encodes `{version: 1, instructions?,
preserve}` behind an exact versioned prefix plus JSON. The compaction and branch
hooks strictly decode that shape and render valid bounded values under
`[Compaction Request]`.

The prefix is reserved: malformed JSON, unknown fields or versions, invalid
types, or exceeded limits return a structured decode error and cancel instead
of falling back to prose. The rejected payload is never rendered. A context
with UI/RPC notification support receives a bounded error. The exact
`__pi_vcc__` value retains compaction-routing precedence and has no special
effect on the tree hook.

`compact.request` uses a bounded TypeBox schema before argument mapping.
Instructions are limited to 8192 characters and 8192 UTF-8 bytes; `preserve` to
16 items; each item to 2048 characters and 2048 UTF-8 bytes; and the complete
encoded prefix-plus-JSON request to 16 KiB. The decoder checks aggregate source
bytes before parsing JSON and preserve count before iterating or canonicalizing
items.

#### Commit semantics

- `maybeCommit(context)` is awaited from the host's `agent_settled` handler —
  never mid-turn, never while a turn is in flight. The returned Promise settles
  on `onComplete`, `onError`, a synchronous startup throw, or a pre-start abort.
- It is a no-op when nothing is pending. Reentrant calls share the in-flight
  Promise rather than starting a second compaction.
- A new `request()` while a commit is in flight is allowed: it replaces the
  pending intent. The in-flight commit proceeds with the intent it captured; on
  completion it clears *that* intent (by identity), leaving any newer intent for
  the next settled boundary.
- On pi's `onComplete`: the intent is cleared and `last` records
  `status: "committed"` with the summary and token counts.
- On pi's `onError` with `"Compaction cancelled"` or `"Already compacted"`:
  the intent is cleared **quietly** — nothing to compact, no failure recorded.
- On any other error: the intent is cleared and `last` records
  `status: "failed"` with the message. If `compact()` itself throws
  synchronously, the same failure path applies.

### Subagent compaction — `agents.compact`

```ts
const handle = await agents.spawn({
  task: "Audit auth flows.",
  tools: ["read", "grep", "find", "ls"],
});

// Advisory: the worker queues this until the child is fully settled.
await agents.compact({ id: handle.id, instructions: "Keep the finding list." });

return await agents.wait({ id: handle.id });
```

- Appended to the same `<runDir>/steer.jsonl` channel as `agents.steer` — the
  orchestrator (or any peer via the mesh relay) can request a child compaction
  without stopping or respawning it, preserving the child's accumulated
  context.
- The worker tails `steer.jsonl` but does not forward compact during an active
  child turn. It waits for `agent_settled`, then sends
  `{"id":"...","type":"compact","customInstructions":"..."}` (the
  instructions field is omitted when absent). See pi's [RPC `compact`](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/rpc.md).
- The worker correlates the compact response by `id`, observes the matching
  compaction lifecycle through `compaction_end`, records queued/in-flight/
  completed/failed status, and only then closes stdin for one-shot shutdown.
  A rejected response, aborted compaction, or `compaction_end.errorMessage` is
  recorded as failed without aborting the child turn.
- Multiple requests waiting before the boundary coalesce to one request with
  the latest instructions. Requests arriving during an in-flight compaction
  coalesce into one deterministic follow-on request before shutdown.
- **Claude-runner children are rejected** with a clear error: the official
  Claude Code CLI exposes no compact RPC, so a fresh run is the only way to
  reset a Claude child's context. Compaction is a Pi-runner primitive.
- Risk class: `agent`.

## Audit and observability

- **Activity surface**: `compact.request` and `agents.compact` emit
  `context.activity` updates (entity + progress) inside the `fabric_exec` call
  that issued them, following the existing provider pattern. Host commits and
  child enqueues are therefore visible in the dashboard and widget.
- **Mesh**: when the mesh is enabled, the host controller publishes best-effort
  events to the durable `fabric.compact` topic on each transition:
  `kind: "requested"` when an intent is recorded, and
  `kind: "committed" | "failed"` when the host commits. Pi's benign
  `"Compaction cancelled"` / `"Already compacted"` outcomes clear quietly and
  do not publish a commit event. Other
  Fabric participants (persistent actors, peer sessions) can subscribe to
  observe compaction transitions. Activity-only sessions (mesh disabled)
  silently skip this.
- **Status query**: `compact.status()` is the context-independent, in-memory
  record of the pending intent and the last commit for the current initialized
  extension session. It survives compaction itself, but not extension reload,
  session replacement, process restart, or shutdown.

## Configuration

None required. Programmatic compaction is a first-principles primitive and is
always available. There is intentionally no `compact` config block: the model
decides when and how to ask; the host decides when to commit; neither needs
configuration to be safe.

## Files

| File | Role |
| --- | --- |
| `src/core/compact-controller.ts` | Pending-intent controller: `request`, `cancel`, `status`, `maybeCommit`. Single replaceable slot; typed preserve encoding; in-flight guard; quiet-clear on cancelled/already-compacted. |
| `src/providers/compact-provider.ts` | Fabric provider exposing bounded TypeBox-validated `request` (write, including optional `preserve: string[]`), `status` (read), `cancel` (read). Always registered; activity audit. |
| `src/fabric-state.ts` | Constructs the controller with mesh-publish hooks; registers the provider; resets on re-init/shutdown. |
| `src/index.ts` | Invokes `state.compact.maybeCommit(context)` in the existing `agent_settled` handler. |
| `src/subagents/types.ts` | `SubagentSteerEntry["type"]` extended with `"compact"`; optional `instructions` field. |
| `src/subagents/manager.ts` | `compact(id, instructions?)` appends a compact entry through the steer channel; rejects Claude-runner children. |
| `src/worker.ts` | Feeds compact controls into the child boundary coordinator and observes Pi RPC lifecycle events. |
| `src/subagents/compact-control.ts` | Coalesces child requests, waits for `agent_settled`, correlates compact response + `compaction_end`, records outcome, and gates one-shot stdin close. |
| `src/providers/agents-provider.ts` | `agents.compact({id, instructions?})` action (risk: agent) with activity audit. |
