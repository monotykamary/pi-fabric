import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { ActionRegistry } from "../src/core/action-registry.js";
import { createMcpProvider, type HostedMcpSource } from "../src/mcp.js";
import { McpProvider } from "../src/providers/mcp-provider.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";

vi.mock("mcporter", () => { throw new Error("Ambient runtime imported"); });
vi.mock("../src/providers/mcp-descriptor-cache.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/providers/mcp-descriptor-cache.js")>(),
  statConfigLayers: () => { throw new Error("Ambient config filesystem access"); },
}));
const context = {
  cwd: "", signal: new AbortController().signal,
  parentToolCallId: "parent", nestedToolCallId: "nested",
  extensionContext: {} as ExtensionContext, update() {},
  approve: vi.fn(async () => {}), audits: [], maxResultChars: 100_000,
};
const schema = {
  type: "object", properties: { value: { type: "string" } },
  required: ["value"], additionalProperties: false,
};
function fixture() {
  let allowed = true;
  let names = Array.from({ length: 30 }, (_, i) => `tool-${i}`);
  const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "done" }] }));
  const listTools = vi.fn(async () => names.map(name => ({ name, inputSchema: schema })));
  const source: HostedMcpSource = {
    listServers: () => allowed ? ["authorized"] : [], listTools, callTool,
  };
  const provider = createMcpProvider({ source });
  const registry = new ActionRegistry();
  registry.register(provider);
  return { source, provider, registry, callTool, listTools,
    revoke: () => { allowed = false; }, tools: (next: string[]) => { names = next; } };
}

describe("hosted native MCP", () => {
  it("rejects ambiguous aliases while retaining exact tool identity", async () => {
    const f = fixture();
    f.tools(["read-a", "read.a"]);
    await expect(f.provider.describe("authorized.read_a", context)).rejects.toThrow("Unknown hosted MCP action");
    await expect(f.registry.invoke("mcp.authorized.read_a", {}, context)).rejects.toThrow("Unknown hosted MCP action");
    await expect(f.provider.invoke("authorized.read_a", {}, context)).rejects.toThrow("Unknown MCP tool");
    await f.provider.invoke("authorized.read.a", {}, context);
    expect(f.callTool).toHaveBeenCalledWith("authorized", "read.a", expect.anything());
  });

  it("forwards cancellation to the broker and never starts already aborted calls", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const callTool = vi.fn(async (_server, _tool, options) => {
      expect(options.signal).toBe(controller.signal);
      started();
      return new Promise<never>((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("broker aborted")), { once: true });
      });
    });
    const f = fixture();
    const provider = createMcpProvider({ source: { ...f.source, callTool } });
    const pending = provider.invoke("authorized.tool-0", { value: "ok" }, { ...context, signal: controller.signal });
    await ready;
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled|aborted/);
    await expect(provider.invoke("authorized.tool-0", {}, { ...context, signal: controller.signal })).rejects.toThrow("cancelled");
    expect(callTool).toHaveBeenCalledTimes(1);
  });
  it("reuses native full discovery, schema validation, aliases and result normalization", async () => {
    const f = fixture();
    expect(f.provider).toBeInstanceOf(McpProvider);
    expect(await f.provider.list({}, context)).toHaveLength(30);
    expect(await f.registry.describe("mcp.authorized.tool_29", context)).toMatchObject({ inputSchema: schema });
    await expect(f.registry.invoke("mcp.authorized.tool_29", { value: "ok" }, context)).resolves.toMatchObject({ text: "done" });
    expect(f.callTool).toHaveBeenCalledWith("authorized", "tool-29", expect.objectContaining({ args: { value: "ok" }, signal: context.signal }));
    await expect(f.registry.invoke("mcp.authorized.tool_29", { value: [] }, context)).rejects.toThrow();
    expect(f.callTool).toHaveBeenCalledTimes(1);
  });

  it("denies management including direct invoke and ignores ambient cache configuration", async () => {
    const f = fixture();
    const cache = { load: vi.fn(), save: vi.fn() };
    const provider = new McpProvider("/not-a-config-root", DEFAULT_FABRIC_CONFIG.mcp, {
      source: f.source, cache: cache as never,
    });
    provider.warmup();
    await provider.settle();
    expect(await provider.list({}, context)).toHaveLength(30);
    for (const name of ["$servers", "$register", "$reload", "$call"]) {
      await expect(provider.describe(name, context)).rejects.toThrow("management");
      await expect(provider.invoke(name, { server: "authorized", tool: "tool-0" }, context)).rejects.toThrow("management");
    }
    expect(cache.load).not.toHaveBeenCalled();
    expect(cache.save).not.toHaveBeenCalled();
    expect(f.callTool).not.toHaveBeenCalled();
    await provider.close();
    await expect(provider.list({}, context)).rejects.toThrow("closed");
  });

  it("rejects unknown sources before transport and observes live revocation without TTL", async () => {
    const f = fixture();
    expect(await f.provider.list({ namespace: "missing" }, context)).toEqual([]);
    expect(f.listTools).not.toHaveBeenCalled();
    await expect(f.registry.invoke("mcp.authorize.tool-0", {}, context)).rejects.toThrow("Unknown hosted MCP action");
    await f.provider.describe("authorized.tool-0", context);
    f.tools([]);
    await expect(f.provider.invoke("authorized.tool-0", {}, context)).rejects.toThrow("Unknown MCP tool");
    f.revoke();
    expect(await f.provider.list({}, context)).toEqual([]);
    await expect(f.provider.invoke("authorized.tool-0", {}, context)).rejects.toThrow("Unknown MCP server");
    expect(f.callTool).not.toHaveBeenCalled();
  });
});
