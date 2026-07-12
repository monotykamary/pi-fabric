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
    );
    expect(context.update).toHaveBeenCalledWith("compat_tool: halfway");
    expect(lifecycleEvents).toEqual([
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
    ]);
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
    registry.register(new PiToolsProvider(process.cwd(), capturedProvider));

    await expect(registry.invoke("pi.read", { path: "README.md" }, context)).resolves.toBe(
      "override:README.md",
    );
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
