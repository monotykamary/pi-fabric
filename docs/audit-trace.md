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

The package exports `isFabricExecutionTraceV1`, `isFabricExecutionTraceOperationV1`, and `readFabricExecutionTraceV1`. The guards reject malformed envelopes, extra fields, oversized data, and unknown versions. Later consumers should treat `readFabricExecutionTraceV1(value) === undefined` as “no supported trace” and may then use a separate legacy compatibility path; they should not reinterpret unknown versions as V1.
