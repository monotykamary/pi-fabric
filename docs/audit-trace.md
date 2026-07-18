# Fabric execution trace V1

`fabric_exec` result details include a durable `trace` alongside the existing UI-oriented `audits` and `phases`. Consumers should use the trace structurally and must not recover calls by parsing program source, rendered output, or audit prose.

## Envelope

```ts
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

The serialized UTF-8 envelope is at most 512 KiB. It contains no run or call timestamps, elapsed durations, random call IDs, source code, or media payloads.

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

`sequence` is assigned when the host bridge receives a call. Parallel completion updates that record without changing operation order. An attempt is issued before reference resolution and all preparation, schema validation, approval, and execution guards, so failures in those stages remain visible. Cancellation and deadline handling seal any unfinished operation.

Arguments and results are deterministic JSON-safe snapshots. Object keys are sorted. Sensitive key names are replaced with `[REDACTED]`; media and base64 payloads are omitted; circular references, bigint, non-finite numbers, functions, symbols, and `undefined` cannot break serialization. Per-value limits and the envelope limit update the explicit counts.

V1 records nested provider calls and the existing ordered workflow phase names. Workflow configure/item/event activity remains a display surface and is not a V1 trace operation.

## Reading traces

The package exports `isFabricExecutionTraceV1`, `isFabricExecutionTraceOperationV1`, and `readFabricExecutionTraceV1`. The guards reject malformed envelopes, extra fields, oversized data, and unknown versions.

Compaction and memory read only `toolResult.details.trace` through this guard. Compaction emits phases and operations in sequence order with stable `entryId/subordinal` addresses, and memory emits one normalized child per operation with address `<outer-entry-id>/<sequence>`. Neither consumer parses `fabric_exec` source, outer output, operation results, or rendered audit prose to recover calls, files, or failures.

A present but invalid/unknown `trace` blocks legacy reinterpretation. Only when the `trace` field is absent may compaction use its separate strict `details.audits` adapter; that adapter accepts typed `ref`, JSON `args`, boolean `success`, and optional string `error` fields and ignores audit `result`/rendering. Memory indexes trace operations only.

Trace outcomes and `operation.error` are authoritative for nested failures. A later success resolves compaction state only for the exact same action/path, action/command, or generic ref/arguments identity. Write activity is labelled Written unless a typed result explicitly proves creation.

Valid trace-derived facts may also be persisted in bounded Fabric branch-summary V1 details. Later compaction guards and consumes those typed details from the active branch path; branch-summary prose and sibling branch entries are never semantic input.
