import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  ActionRegistry,
  type FabricCallAudit,
} from "../src/core/action-registry.js";
import type {
  FabricInvocationContext,
  FabricProvider,
} from "../src/protocol.js";

const provider = (): FabricProvider => ({
  name: "demo",
  description: "Demo provider",
  async list() {
    return [
      {
        name: "echo",
        description: "Echo a string",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        risk: "read",
      },
    ];
  },
  async describe(name) {
    return name === "echo" ? (await this.list({}, context))[0] : undefined;
  },
  async invoke(_name, args, invocationContext) {
    invocationContext.activity?.({ type: "progress", message: "echoing" });
    invocationContext.activity?.({
      type: "entity",
      id: "demo-entity",
      kind: "custom",
      name: "Echo operation",
    });
    return args.value;
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

describe("ActionRegistry", () => {
  it("lists, searches, describes, and invokes providers", async () => {
    const registry = new ActionRegistry();
    registry.register(provider());
    expect((await registry.list({}, context))[0]?.ref).toBe("demo.echo");
    expect((await registry.search("echo", context))[0]?.ref).toBe("demo.echo");
    expect((await registry.describe("demo.echo", context)).risk).toBe("read");

    const approve = vi.fn(async () => {});
    const audits: FabricCallAudit[] = [];
    const result = await registry.invoke("demo.echo", { value: "hello" }, {
      ...context,
      approve,
      audits,
      maxResultChars: 10_000,
    });
    expect(result).toBe("hello");
    expect(approve).toHaveBeenCalledOnce();
    expect(audits).toMatchObject([
      {
        ref: "demo.echo",
        provider: "demo",
        tool: "echo",
        args: { value: "hello" },
        success: true,
      },
    ]);
  });

  it("emits structured invocation activity without exposing another model tool", async () => {
    const registry = new ActionRegistry();
    registry.register(provider());
    const events: unknown[] = [];
    await registry.invoke("demo.echo", { value: "hello" }, {
      ...context,
      approve: async () => {},
      audits: [],
      maxResultChars: 10_000,
      observeInvocation: (event) => events.push(event),
    });

    expect(events).toMatchObject([
      { type: "call_start", ref: "demo.echo", args: { value: "hello" } },
      { type: "call_update", update: { type: "progress", message: "echoing" } },
      {
        type: "call_update",
        update: { type: "entity", id: "demo-entity", kind: "custom" },
      },
      { type: "call_end", success: true, result: "hello" },
    ]);
  });

  it("populates audit preview metadata before invoking the provider", async () => {
    const registry = new ActionRegistry();
    const audits: FabricCallAudit[] = [];
    let observed: FabricCallAudit | undefined;
    registry.register({
      ...provider(),
      async invoke(_name, args) {
        observed = audits[0] ? { ...audits[0] } : undefined;
        return args.value;
      },
    });

    await registry.invoke("demo.echo", { value: "in flight" }, {
      ...context,
      approve: async () => {},
      audits,
      maxResultChars: 10_000,
    });

    expect(observed).toMatchObject({
      ref: "demo.echo",
      provider: "demo",
      tool: "echo",
      args: { value: "in flight" },
    });
    expect(observed?.success).toBeUndefined();
  });

  it("marks failed agent results as failed nested calls without hiding the result", async () => {
    const registry = new ActionRegistry();
    const audits: FabricCallAudit[] = [];
    const events: unknown[] = [];
    registry.register({
      name: "agents",
      description: "Test agents",
      async list() {
        return [{
          name: "run",
          description: "Run a test agent",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          risk: "agent",
        }];
      },
      async describe(name) {
        return name === "run" ? (await this.list({}, context))[0] : undefined;
      },
      async invoke() {
        return { status: "failed", error: "provider unavailable" };
      },
    });

    const result = await registry.invoke("agents.run", {}, {
      ...context,
      approve: async () => {},
      audits,
      maxResultChars: 10_000,
      observeInvocation: (event) => events.push(event),
    });

    expect(result).toEqual({ status: "failed", error: "provider unavailable" });
    expect(audits).toMatchObject([{ success: false, error: "provider unavailable" }]);
    expect(events.at(-1)).toMatchObject({
      type: "call_end",
      success: false,
      error: "provider unavailable",
    });
  });

  it("caps nested results before crossing the sandbox bridge", async () => {
    const registry = new ActionRegistry();
    registry.register(provider());
    const audits: FabricCallAudit[] = [];
    const result = await registry.invoke("demo.echo", { value: "x".repeat(100) }, {
      ...context,
      approve: async () => {},
      audits,
      maxResultChars: 40,
    });
    expect(result).toMatchObject({ fabricTruncated: true, originalChars: 102 });
    expect(audits).toMatchObject([{ resultTruncated: true, resultChars: 102 }]);
  });

  it("validates arguments before approval or execution", async () => {
    const registry = new ActionRegistry();
    registry.register(provider());
    const approve = vi.fn(async () => {});
    await expect(
      registry.invoke("demo.echo", { value: 42 }, {
        ...context,
        approve,
        audits: [],
        maxResultChars: 10_000,
      }),
    ).rejects.toThrow("Invalid arguments");
    expect(approve).not.toHaveBeenCalled();
  });

  it("rejects duplicate and malformed provider names", () => {
    const registry = new ActionRegistry();
    registry.register(provider());
    expect(() => registry.register(provider())).toThrow("already registered");
    expect(() => registry.register({ ...provider(), name: "Bad Name" })).toThrow(
      "Invalid Fabric provider name",
    );
  });
});
