import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  FABRIC_EXECUTION_DETAILS_MAX_BYTES,
  createFabricPersistedExecutionDetails,
  readFabricExecutionRenderDetails,
} from "../src/audit/details.js";
import {
  FABRIC_EXECUTION_TRACE_MAX_BYTES,
  FabricExecutionTraceRecorder,
  executionOutcomeFromError,
  isFabricExecutionTraceV1,
  readFabricExecutionTraceV1,
} from "../src/audit/trace.js";
import { FabricActivityStore } from "../src/activity/store.js";
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

const serviceForRegistry = (
  registry: ActionRegistry,
  context: ExtensionContext = { cwd: process.cwd(), hasUI: false } as ExtensionContext,
): { service: FabricExecutionService; context: ExtensionContext } => {
  const config = structuredClone(DEFAULT_FABRIC_CONFIG);
  config.fullCodeMode = false;
  config.approvals.read = "allow";
  return { service: new FabricExecutionService(registry, config), context };
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
          ref: "fabric.workflow.phase",
          provider: "fabric",
          action: "workflow.phase",
          args: { name: "Inspect" },
          outcome: "succeeded",
        },
        {
          type: "call",
          sequence: 1,
          ref: "demo.echo",
          provider: "demo",
          action: "echo",
          args: {},
          outcome: "succeeded",
        },
      ],
      counts: {
        droppedValues: 2,
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

  it("records all discovery paths in issue order without queries or results", async () => {
    const registry = new ActionRegistry();
    registry.register(demoProvider({
      description: "provider-result-secret",
      async list() {
        return [{ ...descriptor, description: "descriptor-result-secret", namespace: "public" }];
      },
    }));
    const context = {
      cwd: process.cwd(),
      hasUI: false,
      modelRegistry: {
        getAvailable() {
          return [{ provider: "model-provider-secret", id: "model-id-secret", name: "model-name-secret" }];
        },
      },
    } as unknown as ExtensionContext;
    const { service } = serviceForRegistry(registry, context);
    const result = await execute(
      service,
      context,
      `
await tools.providers();
await tools.models();
await tools.list({ provider: "demo", namespace: "public", query: "list-query-secret", limit: 7 });
await tools.search({ query: "search-query-secret", limit: 3 });
await tools.describe({ ref: "demo.echo" });
return true;
`,
    );

    expect(result.success).toBe(true);
    expect(result.trace.operations.map(({ sequence, ref, args, outcome, result: operationResult }) => ({
      sequence,
      ref,
      args,
      outcome,
      result: operationResult,
    }))).toEqual([
      { sequence: 0, ref: "fabric.discovery.providers", args: {}, outcome: "succeeded", result: undefined },
      { sequence: 1, ref: "fabric.discovery.models", args: {}, outcome: "succeeded", result: undefined },
      {
        sequence: 2,
        ref: "fabric.discovery.list",
        args: { limit: 7, namespace: "public", provider: "demo" },
        outcome: "succeeded",
        result: undefined,
      },
      { sequence: 3, ref: "fabric.discovery.search", args: { limit: 3 }, outcome: "succeeded", result: undefined },
      { sequence: 4, ref: "fabric.discovery.describe", args: { ref: "demo.echo" }, outcome: "succeeded", result: undefined },
    ]);
    const serialized = JSON.stringify(createFabricPersistedExecutionDetails(result));
    for (const secret of [
      "provider-result-secret",
      "descriptor-result-secret",
      "model-provider-secret",
      "model-id-secret",
      "model-name-secret",
      "list-query-secret",
      "search-query-secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("records a typed failure for every discovery operation", async () => {
    const providersRegistry = new ActionRegistry();
    Object.defineProperty(providersRegistry, "providers", {
      value() {
        throw new Error("providers-failure-secret");
      },
    });
    const providers = serviceForRegistry(providersRegistry);
    const providersResult = await execute(providers.service, providers.context, "return tools.providers();");

    const modelsRegistry = new ActionRegistry();
    const modelsContext = {
      cwd: process.cwd(),
      hasUI: false,
      modelRegistry: {
        getAvailable() {
          throw new Error("models-failure-secret");
        },
      },
    } as unknown as ExtensionContext;
    const models = serviceForRegistry(modelsRegistry, modelsContext);
    const modelsResult = await execute(models.service, models.context, "return tools.models();");

    const failingProvider = demoProvider({
      async list() {
        throw new Error("list-search-failure-secret");
      },
      async describe() {
        throw new Error("describe-failure-secret");
      },
    });
    const list = serviceFor(failingProvider);
    const listResult = await execute(list.service, list.context, 'return tools.list({ provider: "demo" });');
    const search = serviceFor(failingProvider);
    const searchResult = await execute(search.service, search.context, 'return tools.search({ query: "failure-query-secret" });');
    const describeResult = await execute(
      search.service,
      search.context,
      'return tools.describe({ ref: "demo.echo" });',
    );

    expect(providersResult.trace.operations[0]).toMatchObject({
      ref: "fabric.discovery.providers",
      outcome: "failed",
      failureStage: "invoke",
    });
    expect(modelsResult.success).toBe(true);
    expect(modelsResult.value).toEqual([]);
    expect(modelsResult.trace.operations[0]).toMatchObject({
      ref: "fabric.discovery.models",
      outcome: "failed",
      failureStage: "invoke",
    });
    expect(listResult.trace.operations[0]).toMatchObject({
      ref: "fabric.discovery.list",
      outcome: "failed",
      failureStage: "invoke",
    });
    expect(searchResult.trace.operations[0]).toMatchObject({
      ref: "fabric.discovery.search",
      outcome: "failed",
      failureStage: "invoke",
      args: {},
    });
    expect(describeResult.trace.operations[0]).toMatchObject({
      ref: "fabric.discovery.describe",
      outcome: "failed",
      failureStage: "resolve",
      args: { ref: "demo.echo" },
    });
    const serialized = JSON.stringify([
      createFabricPersistedExecutionDetails(providersResult),
      createFabricPersistedExecutionDetails(modelsResult),
      createFabricPersistedExecutionDetails(listResult),
      createFabricPersistedExecutionDetails(searchResult),
      createFabricPersistedExecutionDetails(describeResult),
    ]);
    expect(serialized).not.toContain("failure-secret");
    expect(serialized).not.toContain("failure-query-secret");
  });

  it("records discovery guard, timeout, and abort outcomes", async () => {
    const guarded = serviceFor();
    const guardedResult = await execute(
      guarded.service,
      guarded.context,
      'return tools.describe({ ref: "pi.read" });',
    );
    expect(guardedResult.trace.operations[0]).toMatchObject({
      ref: "fabric.discovery.describe",
      outcome: "failed",
      failureStage: "guard",
    });

    const waitingProvider = demoProvider({
      async list() {
        return new Promise(() => undefined);
      },
    });
    const timed = serviceFor(waitingProvider);
    timed.service.config.executor.timeoutMs = 40;
    const timedResult = await execute(
      timed.service,
      timed.context,
      'return tools.list({ provider: "demo" });',
    );
    expect(timedResult.trace.operations[0]).toMatchObject({
      ref: "fabric.discovery.list",
      outcome: "timed_out",
      failureStage: "invoke",
    });

    const aborted = serviceFor(waitingProvider);
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("cancel-secret")), 30);
    const abortedResult = await execute(
      aborted.service,
      aborted.context,
      'return tools.list({ provider: "demo" });',
      controller.signal,
    );
    expect(abortedResult.trace.operations[0]).toMatchObject({
      ref: "fabric.discovery.list",
      outcome: "aborted",
      failureStage: "invoke",
    });
  });

  it("records workflow lifecycle operations with structural projections and live activity", async () => {
    const registry = new ActionRegistry();
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = false;
    const activity = new FabricActivityStore();
    const service = new FabricExecutionService(registry, config, activity);
    const context = { cwd: process.cwd(), hasUI: false } as ExtensionContext;
    const partials: Array<{ progress?: string | undefined }> = [];
    const result = await service.execute({
      code: `
await workflow.configure({ name: "Lifecycle", description: "configure-description-secret" });
await workflow.phase("Inspect", { id: "inspect", description: "phase-description-secret", total: 4 });
await workflow.item({
  id: "item-1",
  label: "item-label-secret",
  status: "completed",
  phase: "inspect",
  kind: "task",
  detail: "item-detail-secret",
  current: "item-current-secret",
  total: 4,
  completed: 2,
  data: { value: "item-data-secret" },
});
await workflow.event({ message: "event-message-secret", level: "success", data: { value: "event-data-secret" } });
await tools.progress({ message: "progress-message-secret" });
return true;
`,
      signal: undefined,
      parentToolCallId: "workflow-lifecycle",
      context,
      onPartial(snapshot) {
        partials.push(snapshot);
      },
    });

    expect(result.trace.operations.map((operation) => ({ ref: operation.ref, args: operation.args }))).toEqual([
      { ref: "fabric.workflow.configure", args: { name: "Lifecycle" } },
      { ref: "fabric.workflow.phase", args: { id: "inspect", name: "Inspect", total: 4 } },
      {
        ref: "fabric.workflow.item",
        args: { completed: 2, id: "item-1", kind: "task", phase: "inspect", status: "completed", total: 4 },
      },
      { ref: "fabric.workflow.event", args: { level: "success" } },
      { ref: "fabric.workflow.progress", args: {} },
    ]);
    expect(result.trace.operations.every((operation) => operation.outcome === "succeeded")).toBe(true);
    expect(result.trace.phases).toEqual(["Inspect"]);
    expect(activity.get("workflow-lifecycle")).toMatchObject({
      name: "Lifecycle",
      description: "configure-description-secret",
      phases: [{ id: "inspect", name: "Inspect", description: "phase-description-secret" }],
      items: [{ id: "item-1", label: "item-label-secret", detail: "item-detail-secret" }],
      events: [{ message: "event-message-secret", level: "success" }],
    });
    expect(partials.some((partial) => partial.progress === "progress-message-secret")).toBe(true);
    const serialized = JSON.stringify(createFabricPersistedExecutionDetails(result));
    for (const secret of [
      "configure-description-secret",
      "phase-description-secret",
      "item-label-secret",
      "item-detail-secret",
      "item-current-secret",
      "item-data-secret",
      "event-message-secret",
      "event-data-secret",
      "progress-message-secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(FABRIC_EXECUTION_DETAILS_MAX_BYTES);
  });

  it("records workflow validation failures before activity mutation", async () => {
    const { service, context } = serviceFor();
    const result = await execute(service, context, 'return workflow.phase("   ");');

    expect(result.trace.operations[0]).toMatchObject({
      ref: "fabric.workflow.phase",
      outcome: "failed",
      failureStage: "validate",
      args: { name: "   " },
    });
  });

  it("records parallel and nested pipeline spans in issue order, including empty calls", async () => {
    const { service, context } = serviceFor();
    const result = await execute(
      service,
      context,
      `
await workflow.parallel([]);
await workflow.pipeline([],(value) => value);
await workflow.parallel([
  () => tools.call({ ref: "demo.echo", args: { value: "a" } }),
  () => tools.call({ ref: "demo.echo", args: { value: "b" } }),
], { concurrency: 1 });
await workflow.pipeline(
  ["c"],
  (value) => tools.call({ ref: "demo.echo", args: { value } }),
  (value) => value,
);
return true;
`,
    );

    expect(result.success).toBe(true);
    expect(result.trace.operations.map(({ sequence, ref, args, outcome }) => ({ sequence, ref, args, outcome }))).toEqual([
      { sequence: 0, ref: "fabric.workflow.parallel", args: { concurrency: 0, itemCount: 0, kind: "parallel" }, outcome: "succeeded" },
      { sequence: 1, ref: "fabric.workflow.pipeline", args: { itemCount: 0, kind: "pipeline", stageCount: 1 }, outcome: "succeeded" },
      { sequence: 2, ref: "fabric.workflow.parallel", args: { concurrency: 0, itemCount: 0, kind: "parallel" }, outcome: "succeeded" },
      { sequence: 3, ref: "fabric.workflow.parallel", args: { concurrency: 1, itemCount: 2, kind: "parallel" }, outcome: "succeeded" },
      { sequence: 4, ref: "demo.echo", args: {}, outcome: "succeeded" },
      { sequence: 5, ref: "demo.echo", args: {}, outcome: "succeeded" },
      { sequence: 6, ref: "fabric.workflow.pipeline", args: { itemCount: 1, kind: "pipeline", stageCount: 2 }, outcome: "succeeded" },
      { sequence: 7, ref: "fabric.workflow.parallel", args: { concurrency: 1, itemCount: 1, kind: "parallel" }, outcome: "succeeded" },
      { sequence: 8, ref: "demo.echo", args: {}, outcome: "succeeded" },
    ]);
    expect(JSON.stringify(result.trace)).not.toContain("span-");
  });

  it("fails pipeline and nested parallel spans when a stage throws", async () => {
    const { service, context } = serviceFor();
    const result = await execute(
      service,
      context,
      'return workflow.pipeline([1], () => { throw new Error("stage-error-secret"); });',
    );

    expect(result.success).toBe(false);
    expect(result.trace.operations).toMatchObject([
      { ref: "fabric.workflow.pipeline", outcome: "failed", failureStage: "invoke" },
      { ref: "fabric.workflow.parallel", outcome: "failed", failureStage: "invoke" },
    ]);
    expect(JSON.stringify(createFabricPersistedExecutionDetails(result))).not.toContain("stage-error-secret");
  });

  it("seals unclosed workflow spans on timeout and abort", async () => {
    const waitingProvider = demoProvider({
      async invoke() {
        return new Promise(() => undefined);
      },
    });
    const timed = serviceFor(waitingProvider);
    timed.service.config.executor.timeoutMs = 40;
    timed.service.config.subagents.timeoutMs = 40;
    const code = `return workflow.parallel([
      () => tools.call({ ref: "demo.echo", args: { value: "wait-secret" } }),
    ]);`;
    const timedResult = await execute(timed.service, timed.context, code);
    expect(timedResult.trace.operations.map(({ ref, outcome }) => ({ ref, outcome }))).toEqual([
      { ref: "fabric.workflow.parallel", outcome: "timed_out" },
      { ref: "demo.echo", outcome: "timed_out" },
    ]);

    const aborted = serviceFor(waitingProvider);
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("abort-secret")), 30);
    const abortedResult = await execute(aborted.service, aborted.context, code, controller.signal);
    expect(abortedResult.trace.operations.map(({ ref, outcome }) => ({ ref, outcome }))).toEqual([
      { ref: "fabric.workflow.parallel", outcome: "aborted" },
      { ref: "demo.echo", outcome: "aborted" },
    ]);
    expect(JSON.stringify([
      createFabricPersistedExecutionDetails(timedResult),
      createFabricPersistedExecutionDetails(abortedResult),
    ])).not.toContain("secret");
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
      error: `Call failed during ${stage}`,
      args: {},
    });
    expect(JSON.stringify(createFabricPersistedExecutionDetails(result))).not.toContain(
      "exploded",
    );
  });

  it("records execution guard failures", async () => {
    const { service, context } = serviceFor();
    const result = await execute(
      service,
      context,
      'return tools.call({ ref: "pi.write", args: { path: "safe.txt", content: "guard-content-secret" } });',
    );

    expect(result.trace.operations[0]).toMatchObject({
      ref: "pi.write",
      outcome: "failed",
      failureStage: "guard",
      error: "Call failed during guard",
      args: { path: "safe.txt" },
    });
    expect(result.audits).toEqual([]);
    expect(JSON.stringify(createFabricPersistedExecutionDetails(result))).not.toContain(
      "guard-content-secret",
    );
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
      error: "Call failed during approve",
      args: {},
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
      ref: operation.ref,
      args: operation.args,
      result: operation.result,
    }))).toEqual([
      { sequence: 0, ref: "demo.echo", args: {}, result: undefined },
      { sequence: 1, ref: "demo.echo", args: {}, result: undefined },
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

  it("returns a failed zero-call trace for type-check failure without source text", async () => {
    const { service, context } = serviceFor();
    const result = await execute(service, context, "return rawCodeSecretIdentifier;");
    const details = createFabricPersistedExecutionDetails(result);

    expect(result.typeErrors?.length).toBeGreaterThan(0);
    expect(result.trace).toMatchObject({
      outcome: "failed",
      operations: [],
      phases: [],
      error: "Execution failed",
    });
    expect(JSON.stringify(details)).not.toContain("rawCodeSecretIdentifier");
  });

  it("fails closed when a TypeBox validator throws", async () => {
    const provider = demoProvider({
      async describe(name) {
        return name === "echo"
          ? {
              ...descriptor,
              inputSchema: {
                type: "object",
                properties: { value: { type: "string", pattern: "[" } },
              },
            }
          : undefined;
      },
    });
    const { service, context } = serviceFor(provider);
    const result = await execute(
      service,
      context,
      'return tools.call({ ref: "demo.echo", args: { value: "validator-arg-secret" } });',
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Schema validator failed");
    expect(result.trace.operations[0]).toMatchObject({
      outcome: "failed",
      failureStage: "validate",
      error: "Call failed during validate",
      args: {},
    });
    expect(JSON.stringify(createFabricPersistedExecutionDetails(result))).not.toContain("secret");
  });

  it("preserves repeated phase occurrences", async () => {
    const { service, context } = serviceFor();
    const result = await execute(
      service,
      context,
      'await phase("A"); await phase("B"); await phase("A"); return true;',
    );

    expect(result.phases).toEqual(["A", "B", "A"]);
    expect(result.trace.phases).toEqual(["A", "B", "A"]);
  });

  it("does not infer timeout or abort outcomes from error prose", async () => {
    expect(executionOutcomeFromError(new Error("ordinary timeout wording"))).toBe("failed");
    expect(executionOutcomeFromError(new Error("ordinary aborted wording"))).toBe("failed");
    const controller = new AbortController();
    controller.abort(new Error("unclassified reason"));
    expect(executionOutcomeFromError(new Error("ordinary failure"), controller.signal)).toBe(
      "aborted",
    );

    const { service, context } = serviceFor();
    for (const message of ["runtime timeout false positive", "runtime aborted false positive"]) {
      const result = await execute(
        service,
        context,
        `throw new Error(${JSON.stringify(message)});`,
      );
      expect(result.trace.outcome).toBe("failed");
      expect(result.trace.error).toBe("Execution failed");
      expect(JSON.stringify(createFabricPersistedExecutionDetails(result))).not.toContain(message);
    }
  });

  it("reconstructs current render audits from trace and preserves legacy audit rendering", () => {
    const recorder = new FabricExecutionTraceRecorder();
    const operation = recorder.issueCall("pi.read", { path: "src/index.ts", offset: 4, limit: 8 });
    operation.succeed("omitted content");
    const trace = recorder.seal("succeeded", ["Inspect"]);

    expect(readFabricExecutionRenderDetails({ success: true, trace })).toMatchObject({
      phases: ["Inspect"],
      audits: [{ ref: "pi.read", provider: "pi", tool: "read", success: true, args: { path: "src/index.ts", offset: 4, limit: 8 } }],
    });
    const legacy = {
      success: true,
      phases: ["Legacy"],
      audits: [{ ref: "pi.read", tool: "read", args: { path: "old.txt" }, result: "old body" }],
    };
    expect(readFabricExecutionRenderDetails(legacy)).toMatchObject(legacy);
  });

  it("retains bash commands while omitting arbitrary argument and result content", () => {
    const recorder = new FabricExecutionTraceRecorder();
    const bash = recorder.issueCall("pi.bash", {
      command: "pnpm vitest run tests/audit-trace.test.ts",
      authorizationValue: "authorization-secret",
    });
    bash.succeed({ secretValue: "result-secret" });
    const write = recorder.issueCall("pi.write", {
      path: "/tmp/safe.txt",
      content: "write-content-secret",
    });
    write.succeed({ created: true, details: { secretValue: "write-result-secret" } });
    const agent = recorder.issueCall("agents.run", {
      task: "agent-task-secret",
      name: "also-private",
    });
    agent.succeed({ value: "agent-result-secret" });
    const external = recorder.issueCall("extensions.lookup", {
      query: "query-token-secret",
      url: "https://user:url-password@example.test/path?token=url-query-secret",
      arbitrary: { secretValue: "nested-secret" },
    });
    external.succeed({ authorizationValue: "external-result-secret" });
    const unsafePath = recorder.issueCall("pi.read", {
      path: "https://user:path-password@example.test/file?token=path-query-secret",
      offset: 2,
      limit: 4,
    });
    unsafePath.succeed("read-content-secret");
    recorder.issueCall("mesh.put", { key: "build.status", value: "mesh-value-secret" }).succeed({
      value: "mesh-result-secret",
    });
    recorder.issueCall("state.transition", {
      label: "release",
      value: "state-value-secret",
      evidence: ["state-evidence-secret"],
    }).succeed({ value: "state-result-secret" });
    recorder.issueCall("memory.recall", { query: "memory-query-secret" }).succeed({
      text: "memory-result-secret",
    });

    const trace = recorder.seal("succeeded", []);
    const details = createFabricPersistedExecutionDetails({ success: true, trace });
    const serialized = JSON.stringify(details);

    expect(trace.operations.map((operation) => operation.args)).toEqual([
      { command: "pnpm vitest run tests/audit-trace.test.ts" },
      { path: "/tmp/safe.txt" },
      {},
      {},
      { limit: 4, offset: 2 },
      { key: "build.status" },
      {},
      {},
    ]);
    expect(trace.operations.map((operation) => operation.result)).toEqual([
      undefined,
      { created: true },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    for (const secret of [
      "authorization-secret",
      "result-secret",
      "write-content-secret",
      "write-result-secret",
      "agent-task-secret",
      "also-private",
      "agent-result-secret",
      "query-token-secret",
      "url-password",
      "url-query-secret",
      "nested-secret",
      "external-result-secret",
      "path-password",
      "path-query-secret",
      "read-content-secret",
      "mesh-value-secret",
      "mesh-result-secret",
      "state-value-secret",
      "state-evidence-secret",
      "state-result-secret",
      "memory-query-secret",
      "memory-result-secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(details).not.toHaveProperty("audits");
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(
      FABRIC_EXECUTION_DETAILS_MAX_BYTES,
    );
    expect(trace.counts.droppedValues).toBeGreaterThan(0);
  });

  it("enforces the total UTF-8 envelope bound with explicit drops", () => {
    const recorder = new FabricExecutionTraceRecorder();
    const phases = Array.from(
      { length: 512 },
      (_, index) => `${String(index).padStart(4, "0")}${"x".repeat(1_100)}`,
    );
    const trace = recorder.seal("succeeded", phases);

    expect(Buffer.byteLength(JSON.stringify(trace), "utf8")).toBeLessThanOrEqual(
      FABRIC_EXECUTION_TRACE_MAX_BYTES,
    );
    const details = createFabricPersistedExecutionDetails({ success: true, trace });
    expect(Buffer.byteLength(JSON.stringify(details), "utf8")).toBeLessThanOrEqual(
      FABRIC_EXECUTION_DETAILS_MAX_BYTES,
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
