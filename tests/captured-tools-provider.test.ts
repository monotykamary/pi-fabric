import {
  createSyntheticSourceInfo,
  defineTool,
  type ExtensionContext,
  type ExtensionRunner,
  type RegisteredTool,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { CapturedToolCatalog } from "../src/capture/catalog.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { CapturedToolsProvider } from "../src/providers/captured-tools-provider.js";
import { PiToolsProvider } from "../src/providers/pi-tools-provider.js";
import { FabricExecutionService } from "../src/execution-service.js";
import { createFabricExecTool } from "../src/fabric-exec-tool.js";
import type { FabricState } from "../src/fabric-state.js";
import { defaultCodePreviewSettings } from "../src/ui/code-preview.js";

const context = {
  cwd: process.cwd(),
  signal: new AbortController().signal,
  parentToolCallId: "parent",
  nestedToolCallId: "metadata",
  extensionContext: { cwd: process.cwd() } as ExtensionContext,
  update: vi.fn(),
  approve: vi.fn(async () => {}),
  audits: [],
  maxResultChars: 100_000,
};

describe("CapturedToolsProvider", () => {
  it("attaches final captured images after result hooks without changing the tool result", async () => {
    const originalImage = { type: "image" as const, data: "original", mimeType: "image/png" };
    const finalImage = { type: "image" as const, data: "final", mimeType: "image/png" };
    const text = { type: "text" as const, text: "accessibility tree" };
    const definition = defineTool({
      name: "screenshot", label: "Screenshot", description: "Capture a fixture",
      parameters: Type.Object({}),
      async execute() { return { content: [text, originalImage], details: { window: 1 } }; },
    });
    const runner = {
      createContext: () => ({ cwd: process.cwd() }), getActiveTools: () => ["screenshot"],
      emit: vi.fn(async () => {}), emitToolCall: vi.fn(async () => undefined),
      emitToolResult: vi.fn(async () => ({ content: [text, finalImage] })),
    } as unknown as ExtensionRunner;
    const catalog = new CapturedToolCatalog();
    catalog.replace([{ definition, sourceInfo: createSyntheticSourceInfo("/extensions/screenshot.ts", { source: "test" }) }], runner, DEFAULT_FABRIC_CONFIG.capture, "/extensions/pi-fabric/index.ts");
    const provider = new CapturedToolsProvider(catalog);
    const attachMedia = vi.fn();
    const result = await provider.invoke("screenshot", {}, { ...context, attachMedia });
    expect(attachMedia).toHaveBeenCalledExactlyOnceWith([finalImage]);
    expect(result).toMatchObject({ content: [text, finalImage], text: text.text, details: { window: 1 } });
    await expect(provider.invoke("screenshot", {}, context)).resolves.toMatchObject({ content: [text, finalImage] });
    const registry = new ActionRegistry();
    registry.register(provider);
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.approvals.execute = "allow";
    const state = {
      config, ensure: async () => {}, claimHandoff: async () => undefined,
      execution: new FabricExecutionService(registry, config),
    } as unknown as FabricState;
    const tool = createFabricExecTool(state, defaultCodePreviewSettings(), new Map(), (tool) => tool);
    const output = await tool.execute("capture-e2e", {
      code: 'await tools.call({ ref: "extensions.screenshot", args: {} }); await tools.call({ ref: "extensions.screenshot", args: {} }); return "done";',
    }, undefined, undefined, {
      cwd: process.cwd(), hasUI: false, sessionManager: { getSessionId: () => "fixture" },
    } as ExtensionContext);
    expect(output).not.toMatchObject({ isError: true });
    expect(output.content.filter((part) => part.type === "image")).toEqual([finalImage, finalImage]);
    vi.mocked(runner.emitToolResult).mockResolvedValueOnce({ content: [text, finalImage], isError: true });
    const failedOutput = await tool.execute("capture-failed", {
      code: 'return await tools.call({ ref: "extensions.screenshot", args: {} });',
    }, undefined, undefined, {
      cwd: process.cwd(), hasUI: false, sessionManager: { getSessionId: () => "fixture" },
    } as ExtensionContext);
    expect(failedOutput).toMatchObject({ isError: true });
    expect(failedOutput.content.filter((part) => part.type === "image")).toEqual([finalImage]);
  });

  it("prepares, validates, intercepts, and executes a captured tool lazily", async () => {
    const execute = vi.fn(async (_id, params: { value: string }, _signal, onUpdate, ctx) => {
      onUpdate?.({
        content: [{ type: "text", text: "halfway" }],
        details: { progress: 50 },
      });
      return {
        content: [{ type: "text" as const, text: `${params.value}@${ctx.cwd}` }],
        details: { original: true },
        terminate: true,
      };
    });
    const definition = defineTool({
      name: "compat_tool",
      label: "Compat Tool",
      description: "Exercise captured execution",
      parameters: Type.Object({ value: Type.String() }),
      prepareArguments(args) {
        const input = args as { oldValue?: string };
        return { value: input.oldValue ?? "missing" };
      },
      execute,
    });
    const sourceInfo = createSyntheticSourceInfo("/extensions/pi-compat/index.ts", {
      source: "test",
    });
    const registeredTool: RegisteredTool = { definition, sourceInfo };
    const lifecycleEvents: string[] = [];
    const runner = {
      createContext: () => ({ cwd: "/captured-context" }),
      getActiveTools: () => [],
      emit: vi.fn(async (event: { type: string }) => {
        lifecycleEvents.push(event.type);
      }),
      emitToolCall: vi.fn(async (event: { input: Record<string, unknown> }) => {
        event.input.value = `${String(event.input.value)}!`;
        return undefined;
      }),
      emitToolResult: vi.fn(async () => ({ details: { hooked: true } })),
    } as unknown as ExtensionRunner;
    const catalog = new CapturedToolCatalog();
    catalog.replace(
      [registeredTool],
      runner,
      DEFAULT_FABRIC_CONFIG.capture,
      "/extensions/pi-fabric/index.ts",
    );
    const registry = new ActionRegistry();
    registry.register(new CapturedToolsProvider(catalog));

    await expect(registry.search("compat", context)).resolves.toMatchObject([
      {
        ref: "extensions.compat_tool",
        namespace: "extension:pi-compat",
        risk: "execute",
      },
    ]);
    const result = (await registry.invoke(
      "extensions.compat_tool",
      { oldValue: "hello" },
      context,
    )) as {
      text: string;
      details: unknown;
      terminate: boolean;
      isError: boolean;
    };

    expect(execute).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      text: "hello!@/captured-context",
      details: { hooked: true },
      terminate: true,
      isError: false,
    });
    expect(context.approve).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "extensions.compat_tool", risk: "execute" }),
      { value: "hello!" },
    );
    expect(context.update).toHaveBeenCalledWith("compat_tool: halfway");
    expect(lifecycleEvents).toEqual([
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
    ]);
  });

  it("removes tools from discovery when a captured tool deactivates them (#113)", async () => {
    let activeTools = ["selector", "retired_tool"];
    const selector = defineTool({
      name: "selector",
      label: "Selector",
      description: "Select active tools",
      parameters: Type.Object({}),
      async execute() {
        activeTools = ["selector"];
        return { content: [{ type: "text" as const, text: "updated" }], details: {} };
      },
    });
    const retired = defineTool({
      name: "retired_tool",
      label: "Retired",
      description: "Tool removed from the active set",
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text" as const, text: "unused" }], details: {} };
      },
    });
    const runner = {
      createContext: () => ({ cwd: process.cwd() }),
      getActiveTools: () => [...activeTools],
      emit: vi.fn(async () => {}),
      emitToolCall: vi.fn(async () => undefined),
      emitToolResult: vi.fn(async () => undefined),
    } as unknown as ExtensionRunner;
    const catalog = new CapturedToolCatalog();
    catalog.replace(
      [selector, retired].map((definition) => ({
        definition,
        sourceInfo: createSyntheticSourceInfo("/extensions/selector.ts", { source: "test" }),
      })),
      runner,
      DEFAULT_FABRIC_CONFIG.capture,
      "/extensions/pi-fabric/index.ts",
    );
    const provider = new CapturedToolsProvider(catalog);

    expect((await provider.list({}, context)).map((entry) => entry.name)).toEqual([
      "retired_tool",
      "selector",
    ]);
    await provider.invoke("selector", {}, context);
    expect((await provider.list({}, context)).map((entry) => entry.name)).toEqual(["selector"]);
    await expect(provider.describe("retired_tool", context)).resolves.toBeUndefined();
  });

  it("routes Fabric built-ins through captured extension overrides", async () => {
    const definition = defineTool({
      name: "read",
      label: "Audited read",
      description: "Read through an extension gate",
      parameters: Type.Object({ path: Type.String() }),
      async execute(_id, params) {
        return {
          content: [{ type: "text" as const, text: `override:${params.path}` }],
          details: { override: true },
        };
      },
    });
    const runner = {
      createContext: () => ({ cwd: process.cwd() }),
      getActiveTools: () => [],
      emit: vi.fn(async () => {}),
      emitToolCall: vi.fn(async () => undefined),
      emitToolResult: vi.fn(async () => undefined),
    } as unknown as ExtensionRunner;
    const catalog = new CapturedToolCatalog();
    catalog.replace(
      [
        {
          definition,
          sourceInfo: createSyntheticSourceInfo("/extensions/audited-read.ts", {
            source: "test",
          }),
        },
      ],
      runner,
      DEFAULT_FABRIC_CONFIG.capture,
      "/extensions/pi-fabric/index.ts",
    );
    const capturedProvider = new CapturedToolsProvider(catalog);
    const registry = new ActionRegistry();
    registry.register(new PiToolsProvider(process.cwd(), catalog, capturedProvider));

    await expect(registry.invoke("pi.read", { path: "README.md" }, context)).resolves.toBe(
      "override:README.md",
    );
  });

  it("discovers and routes a captured Fovea grep override", async () => {
    const definition = defineTool({
      name: "grep",
      label: "grep (Fovea)",
      description: "Navigate the pi-fovea code graph through grep's familiar shape",
      parameters: Type.Object({
        pattern: Type.String(),
        path: Type.Optional(Type.String()),
        glob: Type.Optional(Type.String()),
        ignoreCase: Type.Optional(Type.Boolean()),
        literal: Type.Optional(Type.Boolean()),
        context: Type.Optional(Type.Number()),
        limit: Type.Optional(Type.Number()),
      }),
      async execute(_id, params) {
        return {
          content: [{ type: "text" as const, text: `fovea grep ${params.pattern}` }],
          details: { backend: "fovea" },
        };
      },
    });
    const runner = {
      createContext: () => ({ cwd: process.cwd() }),
      getActiveTools: () => [],
      emit: vi.fn(async () => {}),
      emitToolCall: vi.fn(async () => undefined),
      emitToolResult: vi.fn(async () => undefined),
    } as unknown as ExtensionRunner;
    const catalog = new CapturedToolCatalog();
    catalog.replace(
      [{
        definition,
        sourceInfo: createSyntheticSourceInfo("/extensions/pi-fovea/src/index.ts", {
          source: "test",
        }),
      }],
      runner,
      DEFAULT_FABRIC_CONFIG.capture,
      "/extensions/pi-fabric/index.ts",
    );
    const capturedProvider = new CapturedToolsProvider(catalog);
    const registry = new ActionRegistry();
    registry.register(capturedProvider);
    registry.register(new PiToolsProvider(process.cwd(), catalog, capturedProvider));

    const refs = (await registry.search("fovea", context)).map((action) => action.ref);
    expect(refs).toContain("extensions.grep");
    expect(refs).toContain("pi.grep");
    await expect(registry.invoke("pi.grep", { pattern: "CreateUser" }, context)).resolves.toBe(
      "fovea grep CreateUser",
    );
  });

  it("releases scheduler barriers after an aborted non-cooperative tool", async () => {
    const hangingExecute = vi.fn(async () => new Promise<never>(() => undefined));
    const hanging = defineTool({
      name: "hanging_parallel",
      label: "Hanging parallel",
      description: "Never settles",
      parameters: Type.Object({}),
      execute: hangingExecute,
    });
    const sequential = defineTool({
      name: "sequential_after_abort",
      label: "Sequential after abort",
      description: "Runs after cancellation",
      parameters: Type.Object({}),
      executionMode: "sequential",
      async execute() {
        return { content: [{ type: "text" as const, text: "recovered" }], details: {} };
      },
    });
    const runner = {
      createContext: () => ({ cwd: process.cwd() }),
      getActiveTools: () => [],
      emit: vi.fn(async () => {}),
      emitToolCall: vi.fn(async () => undefined),
      emitToolResult: vi.fn(async () => undefined),
    } as unknown as ExtensionRunner;
    const catalog = new CapturedToolCatalog();
    catalog.replace(
      [hanging, sequential].map((definition) => ({
        definition,
        sourceInfo: createSyntheticSourceInfo(`/extensions/${definition.name}.ts`, {
          source: "test",
        }),
      })),
      runner,
      DEFAULT_FABRIC_CONFIG.capture,
      "/extensions/pi-fabric/index.ts",
    );
    const provider = new CapturedToolsProvider(catalog);
    const controller = new AbortController();
    const hangingInvocation = provider.invoke(
      "hanging_parallel",
      {},
      { ...context, signal: controller.signal },
    );
    await vi.waitFor(() => expect(hangingExecute).toHaveBeenCalledOnce());
    controller.abort(new Error("cancel hanging tool"));
    await expect(hangingInvocation).rejects.toThrow("cancel hanging tool");

    await expect(provider.invoke(
      "sequential_after_abort",
      {},
      { ...context, signal: new AbortController().signal },
    )).resolves.toMatchObject({ text: "recovered", isError: false });
  });

  it("honors sequential execution barriers from captured definitions", async () => {
    const timeline: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const makeDefinition = (
      name: string,
      operation: () => Promise<void> | void,
      executionMode?: "sequential" | "parallel",
    ) =>
      defineTool({
        name,
        label: name,
        description: name,
        parameters: Type.Object({}),
        ...(executionMode ? { executionMode } : {}),
        async execute() {
          await operation();
          return { content: [{ type: "text" as const, text: name }], details: {} };
        },
      });
    const definitions = [
      makeDefinition("parallel_first", async () => {
        timeline.push("parallel:first:start");
        await firstGate;
        timeline.push("parallel:first:end");
      }),
      makeDefinition(
        "sequential_middle",
        () => {
          timeline.push("sequential:middle");
        },
        "sequential",
      ),
      makeDefinition("parallel_last", () => {
        timeline.push("parallel:last");
      }),
    ];
    const runner = {
      createContext: () => ({ cwd: process.cwd() }),
      getActiveTools: () => [],
      emit: vi.fn(async () => {}),
      emitToolCall: vi.fn(async () => undefined),
      emitToolResult: vi.fn(async () => undefined),
    } as unknown as ExtensionRunner;
    const catalog = new CapturedToolCatalog();
    catalog.replace(
      definitions.map((definition) => ({
        definition,
        sourceInfo: createSyntheticSourceInfo(`/extensions/${definition.name}.ts`, {
          source: "test",
        }),
      })),
      runner,
      DEFAULT_FABRIC_CONFIG.capture,
      "/extensions/pi-fabric/index.ts",
    );
    const provider = new CapturedToolsProvider(catalog);
    const invocationContext = {
      ...context,
      update: vi.fn(),
    };

    const first = provider.invoke("parallel_first", {}, invocationContext);
    await vi.waitFor(() => expect(timeline).toEqual(["parallel:first:start"]));
    const middle = provider.invoke("sequential_middle", {}, invocationContext);
    const last = provider.invoke("parallel_last", {}, invocationContext);
    releaseFirst?.();
    await Promise.all([first, middle, last]);

    expect(timeline).toEqual([
      "parallel:first:start",
      "parallel:first:end",
      "sequential:middle",
      "parallel:last",
    ]);
  });
});
