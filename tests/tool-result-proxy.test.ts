import type {
  ExtensionRunner,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  ActionRegistry,
  type ResolvedFabricAction,
} from "../src/core/action-registry.js";
import {
  FabricToolResultProxy,
  type FabricNestedToolResultProxy,
} from "../src/core/tool-result-proxy.js";
import {
  FABRIC_NESTED_TOOL_CALL_ID_PREFIX,
  readFabricToolResultProxyDetailsV1,
  type FabricInvocationContext,
  type FabricProvider,
} from "../src/protocol.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const action = (provider = "demo"): ResolvedFabricAction => ({
  ref: `${provider}.echo`,
  provider,
  name: "echo",
  description: "Echo a value",
  inputSchema: { type: "object", properties: {}, additionalProperties: true },
  risk: "read",
});

const request = (value: unknown, provider = "demo") => ({
  action: action(provider),
  args: { query: "value" },
  toolCallId: `${FABRIC_NESTED_TOOL_CALL_ID_PREFIX}test`,
  value,
});

const runnerWith = (
  emitToolResult: ReturnType<typeof vi.fn>,
): ExtensionRunner => ({ emitToolResult }) as unknown as ExtensionRunner;

describe("FabricToolResultProxy", () => {
  it("emits a namespaced nested tool_result and applies a content patch", async () => {
    const emitToolResult = vi.fn(async (_event: ToolResultEvent) => ({
      content: [{ type: "text" as const, text: "bounded preview" }],
    }));
    const proxy = new FabricToolResultProxy(() => runnerWith(emitToolResult));

    await expect(proxy.proxy(request("unbounded output"))).resolves.toBe("bounded preview");

    expect(emitToolResult).toHaveBeenCalledOnce();
    const event = emitToolResult.mock.calls[0]?.[0];
    expect(event).toMatchObject({
      type: "tool_result",
      toolName: "demo.echo",
      toolCallId: `${FABRIC_NESTED_TOOL_CALL_ID_PREFIX}test`,
      input: { query: "value" },
      content: [{ type: "text", text: "unbounded output" }],
      isError: false,
    });
    expect(readFabricToolResultProxyDetailsV1(event?.details)).toMatchObject({
      ref: "demo.echo",
      result: "unbounded output",
    });
  });

  it("uses a proxy-details result patch without flattening structured values", async () => {
    const replacement = {
      fabricTruncated: true,
      preview: "bounded",
      artifact: { id: "artifact_test" },
    };
    const emitToolResult = vi.fn(async (event: { details: unknown }) => ({
      details: {
        ...readFabricToolResultProxyDetailsV1(event.details),
        result: replacement,
      },
    }));
    const proxy = new FabricToolResultProxy(() => runnerWith(emitToolResult));

    await expect(proxy.proxy(request({ rows: [1, 2, 3] }))).resolves.toBe(replacement);
  });

  it("preserves the original value when middleware does not patch it", async () => {
    const original = { rows: [1, 2, 3] };
    const emitToolResult = vi.fn(async () => undefined);
    const proxy = new FabricToolResultProxy(() => runnerWith(emitToolResult));

    await expect(proxy.proxy(request(original))).resolves.toBe(original);
  });

  it.each(["pi", "extensions"])(
    "does not duplicate the native %s lifecycle",
    async (provider) => {
      const emitToolResult = vi.fn(async () => undefined);
      const proxy = new FabricToolResultProxy(() => runnerWith(emitToolResult));
      const original = { ok: true };

      await expect(proxy.proxy(request(original, provider))).resolves.toBe(original);
      expect(emitToolResult).not.toHaveBeenCalled();
    },
  );

  it("turns an isError patch into a provider invocation failure", async () => {
    const emitToolResult = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "rejected by guard" }],
      isError: true,
    }));
    const proxy = new FabricToolResultProxy(() => runnerWith(emitToolResult));

    await expect(proxy.proxy(request("value"))).rejects.toThrow("rejected by guard");
  });
});

const provider = (): FabricProvider => ({
  name: "demo",
  description: "Demo provider",
  async list() {
    return [action()];
  },
  async describe(name) {
    return name === "echo" ? action() : undefined;
  },
  async invoke() {
    return "x".repeat(1_000);
  },
});

const context: FabricInvocationContext = {
  cwd: process.cwd(),
  signal: undefined,
  parentToolCallId: "parent",
  nestedToolCallId: "metadata",
  extensionContext: {} as ExtensionContext,
  update() {},
};

describe("ActionRegistry result proxy", () => {
  it("runs the proxy before maxNestedResultChars is enforced", async () => {
    const proxy: FabricNestedToolResultProxy = {
      proxy: vi.fn(async ({ value }) => ({
        artifact: "artifact_test",
        originalChars: (value as string).length,
      })),
    };
    const registry = new ActionRegistry(proxy);
    registry.register(provider());

    const result = await registry.invoke("demo.echo", {}, {
      ...context,
      approve: async () => {},
      audits: [],
      maxResultChars: 100,
    });

    expect(result).toEqual({ artifact: "artifact_test", originalChars: 1_000 });
    expect(proxy.proxy).toHaveBeenCalledWith(expect.objectContaining({
      toolCallId: expect.stringMatching(/^fabric_/),
      value: "x".repeat(1_000),
    }));
  });
});
