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
   agent run is fully settled, no automatic retry, compaction retry, or queued
   continuation remains. For a child, it is the child's *own* turn boundary —
   pi core applies the compaction between the child's turns, never mid-turn.

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
//   last?:   { at, requestedBy, status: "committed"|"failed"|"cancelled",
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
`[Compaction Request]`. On tree navigation, Pi's explicit
`replaceInstructions: true` mode is delegated to Pi/default summarization:
Fabric cannot execute an arbitrary replacement summarizer prompt and therefore
produces no typed Fabric branch details in that mode.

The prefix is reserved: malformed JSON/scalars, duplicate decoded protocol
keys (including escaped aliases), unknown fields or versions, invalid types,
unpaired UTF-16 surrogates, excessive structure, or exceeded limits return a
structured decode error and cancel instead of falling back to prose. A bounded
structural parser performs these checks before canonicalization; it does not
recover protocol data with regex. The rejected payload is never rendered. A
context with UI/RPC notification support receives a bounded error. The exact
`__pi_vcc__` value retains compaction-routing precedence and has no special
effect on the tree hook.

`compact.request` uses a bounded TypeBox schema before argument mapping.
Instructions are limited to 8192 characters and 8192 UTF-8 bytes; `preserve` to
16 items; each item to 2048 characters and 2048 UTF-8 bytes; and the complete
encoded prefix-plus-JSON request to 16 KiB. The decoder checks aggregate source
bytes before structural parsing, validates duplicate keys/scalars/surrogate
pairing while parsing, and checks preserve count before iterating or
canonicalizing items. Ordinary manual/Pi instructions remain bounded explicit
text rather than typed protocol input.

#### Commit semantics

- `maybeCommit(context)` is invoked from the host's `agent_settled` handler —
  never mid-turn, never while a turn is in flight.
- It is a no-op when nothing is pending or a commit is already in flight.
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

// Advisory: the child pi applies compaction between its own turns.
await agents.compact({ id: handle.id, instructions: "Keep the finding list." });

return await agents.wait({ id: handle.id });
```

- Appended to the same `<runDir>/steer.jsonl` channel as `agents.steer` — the
  orchestrator (or any peer via the mesh relay) can request a child compaction
  without stopping or respawning it, preserving the child's accumulated
  context.
- The worker tails `steer.jsonl` and forwards a single RPC frame to the child
  pi's stdin: `{"type":"compact","customInstructions":"..."}` (the
  `customInstructions` field is omitted when no instructions were given). See
  pi's [RPC `compact`](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/rpc.md).
- **Advisory semantics**: the child pi core applies the compaction safely
  between its *own* turns — never mid-turn. Fabric only forwards the intent;
  it does not wait for or observe the child's compaction.
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
  `kind: "committed" | "failed" | "cancelled"` when the host commits. Other
  Fabric participants (persistent actors, peer sessions) can subscribe to
  observe compaction transitions. Activity-only sessions (mesh disabled)
  silently skip this.
- **Status query**: `compact.status()` is the durable, context-independent
  record of the pending intent and the last commit. It survives compaction
  itself (it lives on the controller, not in the context).

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
| `src/worker.ts` | Maps a compact steer entry to a `{"type":"compact","customInstructions":...}` RPC frame on the child pi's stdin. |
| `src/providers/agents-provider.ts` | `agents.compact({id, instructions?})` action (risk: agent) with activity audit. |
