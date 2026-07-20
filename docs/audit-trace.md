# Fabric execution trace V1

Final `fabric_exec` result details are a bounded durable envelope containing only `success` and `trace`. Rich `audits`, logs, values, type errors, elapsed time, media, and raw runtime/provider errors remain in memory only and are not copied into final session JSONL details. Live partial updates may still carry richer audits for the active UI.

The complete serialized final details object is at most 512 KiB. Consumers use current traces structurally. The chat renderer has one compatibility exception: it may match a pre-change bash digest against string literals or named strings already visible in the outer `fabric_exec` arguments so old previews can show the original command.

## Envelope

```ts
interface FabricPersistedExecutionDetailsV1 {
  success: boolean;
  trace: FabricExecutionTraceV1;
}

interface FabricExecutionTraceV1 {
  kind: "pi-fabric.execution";
  version: 1;
  outcome: "succeeded" | "failed" | "aborted" | "timed_out";
  phases: string[];
  operations: FabricExecutionTraceOperationV1[];
  counts: {
    droppedValues: number;
    truncatedValues: number;
    redactedValues: number;
    droppedOperations: number;
  };
  error?: string;
}
```

The trace contains no run or call timestamps, elapsed durations, random call IDs, source code, media payloads, or arbitrary argument/result content. Runtime and call errors are fixed stage/outcome messages rather than provider, validator, approval, or guest exception prose.

`phases` is occurrence-ordered. Repeated transitions are retained, so `A → B → A` is represented as `["A", "B", "A"]`.

## Call operation

```ts
interface FabricExecutionTraceOperationV1 {
  type: "call";
  sequence: number;
  ref: string;
  provider?: string;
  action?: string;
  args: Record<string, JsonValue>;
  outcome: "succeeded" | "failed" | "aborted" | "timed_out";
  failureStage?: "resolve" | "prepare" | "validate" | "approve" | "invoke" | "guard";
  error?: string;
  result?: JsonValue;
}
```

`sequence` is assigned when the host bridge receives any durable operation. Parallel completion updates that record without changing operation order. Action attempts are issued before reference resolution, preparation, schema validation, approval, and execution guards. Discovery and workflow attempts are likewise issued before their guards, lookups, validation, or activity mutation. Failures in those stages therefore remain visible. The configured executor returns a typed termination reason; trace sealing uses that reason for deadline and cancellation outcomes and never classifies exception text.

V1 retains `type: "call"` for wire compatibility. Exact internal refs distinguish discovery, lifecycle, and combinator operations from provider action calls. V1 also keeps `result` optional, but all discovery, workflow lifecycle, and combinator results are omitted. The generic recorder omits provider results except for the exact `{ created: true }` creation outcome from `pi.write`; no output or provider details accompany it. It projects arguments by exact reference:

- `pi.read`: local `path`, numeric `offset`, numeric `limit`
- `pi.grep`: local `path`, numeric `context`, numeric `limit`; pattern/query omitted
- `pi.find`, `pi.ls`: local `path`, numeric `limit`; pattern/query omitted
- `pi.edit`, `pi.write`: local `path` only; edit replacements and write content omitted; `pi.write` may retain `{ created: true }`
- `pi.bash`: bounded command text
- selected `agents.*` lifecycle calls: `id` only; task, message, instructions, names, model options, and outputs omitted
- `mesh.publish`/`read`: topic/address and numeric cursor/limit; payload text/data omitted
- `mesh.get`/`put`/`delete`/`list`: key or prefix and limit; values omitted
- memory, state, schema, compact, MCP, extension, unknown, and external calls: no arguments or results

### Discovery operations

Read-only discovery continues to bypass mutation authorization and approval budgets, but every attempt is durable in the same `sequence` space as actions and workflow activity:

- `fabric.discovery.providers`: no arguments or results
- `fabric.discovery.models`: no arguments or results
- `fabric.discovery.list`: identifier-shaped `provider` and `namespace`, plus numeric `limit`; free-form `query` and results omitted
- `fabric.discovery.search`: numeric `limit`; free-form `query` and results omitted
- `fabric.discovery.describe`: identifier-shaped action `ref`; results omitted

Discovery operations record `succeeded`, `failed`, `aborted`, or `timed_out` with the applicable `guard`, `resolve`, or `invoke` stage. Model-registry enumeration keeps its existing best-effort empty-list behavior when enumeration throws, while the corresponding operation is marked failed.

### Workflow lifecycle operations

Declarative workflow calls remain transient activity updates for the live UI and are also durable occurrence records:

- `fabric.workflow.configure`: `name`; description omitted
- `fabric.workflow.phase`: `name`, identifier-shaped `id`, numeric `total`; description omitted
- `fabric.workflow.item`: identifier-shaped `id`, `status`, `phase`, and `kind`, plus numeric `total` and `completed`; label, detail, current value, and data omitted
- `fabric.workflow.event`: identifier-shaped `level`; message and data omitted
- `fabric.workflow.progress`: no arguments; message omitted

These operations preserve bridge issue order alongside actions and discovery. The separate `phases` compatibility field remains occurrence-ordered and still retains repeated transitions.

### Workflow combinator spans

Calls to `workflow.parallel` and `workflow.pipeline` are instrumented in the shared guest implementation and recorded as `fabric.workflow.parallel` and `fabric.workflow.pipeline`. Start creates one operation; end updates that same operation. Persisted metadata is limited to `kind`, numeric `itemCount`, numeric `stageCount` for pipelines, and effective bounded `concurrency` for parallel calls. Empty combinators are represented. Pipeline execution naturally nests its parallel fan-out, so the pipeline operation is issued before the nested parallel operation and both precede stage actions.

Guest span IDs are deterministic execution-local bridge correlation values. They are never persisted, and the internal start/end bridge is closure-private rather than part of the guest API. Internal span calls do not enter provider resolution, authorization, approval, or agent-budget accounting. A thrown stage closes active spans as failed; runtime failure, deadline, or cancellation seals any still-open operation with the typed final execution outcome.

Only plain local paths are retained. URL paths are omitted, including credentials and query/fragment data. Plain path query/fragment suffixes are removed. Sensitive-key normalization, media/base64 rejection, JSON safety, depth/node limits, and UTF-8 truncation remain defense in depth after projection; they are not the primary secrecy mechanism.

Identifiers (`ref`, `provider`, `action`), outcomes, failure stage, operation sequence, and occurrence-ordered phase labels remain durable. These fields, retained local paths/mesh addresses, and bash command text are not secret containers; callers must not intentionally place credentials in identifiers, local filenames, topics, keys, phase names, or commands.

## Reading and rendering traces

The package exports `isFabricExecutionTraceV1`, `isFabricExecutionTraceOperationV1`, `readFabricExecutionTraceV1`, `createFabricPersistedExecutionDetails`, and `readFabricExecutionRenderDetails`. Guards reject malformed envelopes, extra fields, oversized data, and unknown versions.

Current trace-only sessions reconstruct compact nested-call rows from operation metadata, including bash command text. Old sessions containing `details.audits` and `details.phases` continue to render through the legacy adapter. For old digest-only bash traces, the renderer matches the digest against literal and named strings in the already-visible outer `fabric_exec` arguments; if no exact command can be recovered, it omits the digest instead of displaying a hash. New final details never write `audits`.

Compaction and memory read only `toolResult.details.trace` through the trace guard. Compaction emits phases and operations in sequence order with stable `entryId/subordinal` addresses, and memory emits one normalized child per operation with address `<outer-entry-id>/<sequence>`. Neither consumer parses `fabric_exec` source, outer output, operation results, or rendered audit prose to recover calls, files, or failures.

A present but invalid or unknown trace blocks semantic legacy reinterpretation. Only when the trace field is absent may compaction use its separate strict old-session `details.audits` adapter. Memory indexes trace operations only.

## Limitations

Safe projections intentionally reduce durable reconstruction. Final rendering cannot show read bodies, edit diffs, write bodies, agent tasks, discovery queries/results, workflow descriptions/labels/messages/data, external/MCP arguments, or provider results. Bash command text is retained. Combinator traces show structure and typed outcome, not item values, stage functions, stage results, parent IDs, or timing. Generic failure resolution has ref identity only when arguments are omitted. Rich action audits and workflow activity content remain available only while the live execution result or activity store is in memory.
