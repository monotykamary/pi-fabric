import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  FABRIC_EXECUTION_TRACE_MAX_BYTES,
  FabricExecutionTraceRecorder,
  isFabricExecutionTraceV1,
  readFabricExecutionTraceV1,
} from "../src/audit/trace.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { FabricExecutionService } from "../src/execution-service.js";
import type { FabricProvider } from "../src/protocol.js";

const descriptor = {
  name: "echo",
  description: "Echo a value",
  inputSchema: {
    type: "object",
    properties: { value: { type: "string" }, delay: { type: "number" } },
    required: ["value"],
    additionalProperties: true,
  },
  risk: "read" as const,
};

const demoProvider = (overrides: Partial<FabricProvider> = {}): FabricProvider => ({
  name: "demo",
  description: "Demo",
  async list() {
    return [descriptor];
  },
  async describe(name) {
    return name === "echo" ? descriptor : undefined;
  },
  async invoke(_name, args) {
    const delay = typeof args.delay === "number" ? args.delay : 0;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    return { value: args.value };
  },
  ...overrides,
});

const serviceFor = (
  provider: FabricProvider = demoProvider(),
): { service: FabricExecutionService; context: ExtensionContext } => {
  const registry = new ActionRegistry();
  registry.register(provider);
  const config = structuredClone(DEFAULT_FABRIC_CONFIG);
  config.fullCodeMode = false;
  config.approvals.read = "allow";
  return {
    service: new FabricExecutionService(registry, config),
    context: { cwd: process.cwd(), hasUI: false } as ExtensionContext,
  };
};

const execute = (
  service: FabricExecutionService,
  context: ExtensionContext,
  code: string,
  signal?: AbortSignal,
) =>
  service.execute({
    code,
    signal,
    parentToolCallId: "trace-test",
    context,
    onPartial() {},
  });

describe("Fabric execution trace V1", () => {
  it("records successful calls with the stable V1 envelope and preserves legacy audits", async () => {
    const { service, context } = serviceFor();
    const result = await execute(
      service,
      context,
      'await phase("Inspect"); return tools.call({ ref: "demo.echo", args: { value: "ok" } });',
    );

    expect(result.trace).toEqual({
      kind: "pi-fabric.execution",
      version: 1,
      outcome: "succeeded",
      phases: ["Inspect"],
      operations: [
        {
          type: "call",
          sequence: 0,
          ref: "demo.echo",
          provider: "demo",
          action: "echo",
          args: { value: "ok" },
          outcome: "succeeded",
          result: { value: "ok" },
        },
      ],
      counts: {
        droppedValues: 0,
        truncatedValues: 0,
        redactedValues: 0,
        droppedOperations: 0,
      },
    });
    expect(result.audits).toMatchObject([
      { ref: "demo.echo", provider: "demo", tool: "echo", success: true },
    ]);
    expect(isFabricExecutionTraceV1(result.trace)).toBe(true);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it.each([
    {
      name: "unknown action",
      provider: demoProvider(),
      code: 'return tools.call({ ref: "demo.missing", args: {} });',
      stage: "resolve",
    },
    {
      name: "argument preparation",
      provider: demoProvider({
        async prepareArguments() {
          throw new Error("prepare exploded");
        },
      }),
      code: 'return tools.call({ ref: "demo.echo", args: { value: "x" } });',
      stage: "prepare",
    },
    {
      name: "schema validation",
      provider: demoProvider(),
      code: 'return tools.call({ ref: "demo.echo", args: { value: 42 } });',
      stage: "validate",
    },
    {
      name: "provider invocation",
      provider: demoProvider({
        async invoke() {
          throw new Error("provider exploded");
        },
      }),
      code: 'return tools.call({ ref: "demo.echo", args: { value: "x" } });',
      stage: "invoke",
    },
  ])("captures $name failures before legacy audits necessarily begin", async ({ provider, code, stage }) => {
    const { service, context } = serviceFor(provider);
    const result = await execute(service, context, code);

    expect(result.success).toBe(false);
    expect(result.trace.outcome).toBe("failed");
    expect(result.trace.operations).toHaveLength(1);
    expect(result.trace.operations[0]).toMatchObject({
      sequence: 0,
      outcome: "failed",
      failureStage: stage,
    });
  });

  it("records execution guard failures", async () => {
    const { service, context } = serviceFor();
    const result = await execute(
      service,
      context,
      'return tools.call({ ref: "pi.read", args: { path: "secret.txt" } });',
    );

    expect(result.trace.operations[0]).toMatchObject({
      ref: "pi.read",
      outcome: "failed",
      failureStage: "guard",
      args: { path: "secret.txt" },
    });
    expect(result.audits).toEqual([]);
  });

  it("records approval denial at the approval stage", async () => {
    const provider = demoProvider({
      async list() {
        return [{ ...descriptor, risk: "execute" }];
      },
      async describe(name) {
        return name === "echo" ? { ...descriptor, risk: "execute" } : undefined;
      },
    });
    const { service, context } = serviceFor(provider);
    service.config.approvals.execute = "deny";
    const result = await execute(
      service,
      context,
      'return tools.call({ ref: "demo.echo", args: { value: "x" } });',
    );

    expect(result.trace.operations[0]).toMatchObject({
      outcome: "failed",
      failureStage: "approve",
    });
    expect(result.audits).toEqual([]);
  });

  it("keeps issue order when parallel calls complete out of order", async () => {
    const { service, context } = serviceFor();
    const result = await execute(
      service,
      context,
      `return Promise.all([
        tools.call({ ref: "demo.echo", args: { value: "first", delay: 80 } }),
        tools.call({ ref: "demo.echo", args: { value: "second", delay: 5 } }),
      ]);`,
    );

    expect(result.trace.operations.map((operation) => ({
      sequence: operation.sequence,
      value: operation.args.value,
      result: operation.result,
    }))).toEqual([
      { sequence: 0, value: "first", result: { value: "first" } },
      { sequence: 1, value: "second", result: { value: "second" } },
    ]);
  });

  it("seals unfinished calls as timed out and cancelled", async () => {
    const waitingProvider = demoProvider({
      async invoke() {
        return new Promise(() => undefined);
      },
    });

    const timed = serviceFor(waitingProvider);
    timed.service.config.executor.timeoutMs = 50;
    const timedResult = await execute(
      timed.service,
      timed.context,
      'return tools.call({ ref: "demo.echo", args: { value: "slow" } });',
    );
    expect(timedResult.trace.outcome).toBe("timed_out");
    expect(timedResult.trace.operations[0]).toMatchObject({ outcome: "timed_out" });

    const cancelled = serviceFor(waitingProvider);
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("stop requested")), 30);
    const cancelledResult = await execute(
      cancelled.service,
      cancelled.context,
      'return tools.call({ ref: "demo.echo", args: { value: "slow" } });',
      controller.signal,
    );
    expect(cancelledResult.trace.outcome).toBe("aborted");
    expect(cancelledResult.trace.operations[0]).toMatchObject({ outcome: "aborted" });
  });

  it("returns a failed zero-call trace for type-check failure", async () => {
    const { service, context } = serviceFor();
    const result = await execute(service, context, "return missingIdentifier;");

    expect(result.typeErrors?.length).toBeGreaterThan(0);
    expect(result.trace).toMatchObject({ outcome: "failed", operations: [], phases: [] });
  });

  it("redacts secrets, safely snapshots unusual JSON, and excludes media/base64", () => {
    const recorder = new FabricExecutionTraceRecorder();
    const circular: Record<string, unknown> = { bigint: 42n, infinite: Infinity };
    circular.self = circular;
    const operation = recorder.issueCall("pi.bash", {
      command: "printf usable",
      path: "/tmp/usable",
      apiToken: "do-not-persist",
      omitted: undefined,
      callback() {},
      circular,
    });
    operation.succeed({
      text: "kept",
      media: [{ type: "image", mimeType: "image/png", data: "A".repeat(4_096) }],
      payload: "A".repeat(4_096),
    });
    const trace = recorder.seal("succeeded", []);
    const serialized = JSON.stringify(trace);

    expect(trace.operations[0]?.args).toMatchObject({
      command: "printf usable",
      path: "/tmp/usable",
      apiToken: "[REDACTED]",
      circular: { bigint: "42n", infinite: "[non-finite:Infinity]", self: "[CIRCULAR]" },
    });
    expect(serialized).not.toContain("do-not-persist");
    expect(serialized).not.toContain("image/png");
    expect(serialized).not.toContain("A".repeat(1_024));
    expect(trace.counts.redactedValues).toBeGreaterThan(0);
    expect(trace.counts.droppedValues).toBeGreaterThan(0);
    expect(() => JSON.stringify(trace)).not.toThrow();
  });

  it("enforces the total UTF-8 envelope bound with explicit drops", () => {
    const recorder = new FabricExecutionTraceRecorder();
    for (let index = 0; index < 96; index++) {
      const operation = recorder.issueCall(`demo.action${index}`, { value: "x".repeat(16_000) });
      operation.succeed({ value: "y".repeat(16_000) });
    }
    const trace = recorder.seal("succeeded", []);

    expect(Buffer.byteLength(JSON.stringify(trace), "utf8")).toBeLessThanOrEqual(
      FABRIC_EXECUTION_TRACE_MAX_BYTES,
    );
    expect(trace.counts.droppedValues + trace.counts.droppedOperations).toBeGreaterThan(0);
    expect(isFabricExecutionTraceV1(trace)).toBe(true);
  });

  it("is byte-stable when legacy random IDs and timings differ", async () => {
    const first = serviceFor();
    const second = serviceFor();
    const code = 'return tools.call({ ref: "demo.echo", args: { value: "stable" } });';
    const firstResult = await execute(first.service, first.context, code);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const secondResult = await execute(second.service, second.context, code);

    expect(firstResult.audits[0]?.nestedToolCallId).not.toBe(secondResult.audits[0]?.nestedToolCallId);
    expect(firstResult.audits[0]?.startedAt).not.toBe(secondResult.audits[0]?.startedAt);
    expect(JSON.stringify(firstResult.trace)).toBe(JSON.stringify(secondResult.trace));
  });

  it("strictly ignores malformed and unknown trace versions", () => {
    const recorder = new FabricExecutionTraceRecorder();
    const trace = recorder.seal("succeeded", []);

    expect(readFabricExecutionTraceV1(trace)).toBe(trace);
    expect(readFabricExecutionTraceV1({ ...trace, version: 2 })).toBeUndefined();
    expect(readFabricExecutionTraceV1({ ...trace, unexpected: true })).toBeUndefined();
    expect(readFabricExecutionTraceV1({ kind: "pi-fabric.execution", version: 1 })).toBeUndefined();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(readFabricExecutionTraceV1(circular)).toBeUndefined();
    const hostile = new Proxy({}, { ownKeys() { throw new Error("hostile input"); } });
    expect(readFabricExecutionTraceV1(hostile)).toBeUndefined();
  });
});
