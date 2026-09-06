import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeFabricConfig } from "../src/config.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import type { FabricInvocationContext, FabricProvider } from "../src/protocol.js";
import { RuntimeStateSpeculation } from "../src/runtime-state-speculation.js";
import type { FabricSpeculationTapOptions } from "../src/speculation/stream-tap.js";

const taps = vi.hoisted(() => [] as FabricSpeculationTapOptions[]);
vi.mock("../src/speculation/stream-tap.js", () => ({
  FabricSpeculationStreamTap: class {
    reset = vi.fn();
    setScannerFactory = vi.fn();
    constructor(options: FabricSpeculationTapOptions) { taps.push(options); }
  },
}));
vi.mock("../src/speculation/scanner.js", () => ({ LiteralCallScanner: class {} }));

const extensionContext = { cwd: process.cwd() } as ExtensionContext;
const context: FabricInvocationContext = {
  cwd: extensionContext.cwd,
  signal: undefined,
  parentToolCallId: "turn-call",
  nestedToolCallId: "nested",
  extensionContext,
  update() {},
};

const fixture = () => {
  const registry = new ActionRegistry();
  const invoke = vi.fn(async () => ({ status: "idle" }));
  const action = {
    name: "status", description: "Read status", inputSchema: { type: "object" },
    risk: "read" as const, effect: { kind: "none" as const },
  };
  const provider: FabricProvider = {
    name: "compact", description: "Test read provider",
    async list() { return [action]; },
    async describe() { return action; },
    invoke,
  };
  registry.register(provider);
  const config = normalizeFabricConfig({ speculation: { enabled: true } }).speculation;
  let capabilityView: FabricInvocationContext["capabilityView"];
  const service = new RuntimeStateSpeculation(registry, () => config, () => capabilityView);
  return { registry, invoke, config, service, setView(view: typeof capabilityView) { capabilityView = view; } };
};

describe("runtime state speculation wiring", () => {
  beforeEach(() => { taps.length = 0; });

  it("does not install a store or tap when disabled", () => {
    const registry = new ActionRegistry();
    const install = vi.spyOn(registry, "setSpeculation");
    const config = normalizeFabricConfig({ speculation: { enabled: false } }).speculation;
    const service = new RuntimeStateSpeculation(registry, () => config, () => undefined);
    expect(service.tap).toBeUndefined();
    expect(install).not.toHaveBeenCalled();
    service.reset();
  });

  it("reads live stream limits and MCP eligibility, and stops launch after disable", async () => {
    const { registry, config } = fixture();
    const speculate = vi.spyOn(registry, "speculate");
    const tap = taps[0]!;
    expect(tap.isEligible("compact.status")).toBe(true);
    expect(tap.isEligible("compact.cancel")).toBe(false);
    expect(tap.isEligible("mcp.docs.read")).toBe(false);
    config.mcpAllowlist = ["docs.*"];
    config.maxBufferBytes = 1234;
    expect(tap.isEligible("mcp.docs.read")).toBe(true);
    expect(tap.maxBufferBytes()).toBe(1234);
    config.enabled = false;
    expect(tap.enabled()).toBe(false);
    tap.launch("turn-call", { ref: "compact.status", args: {} }, extensionContext);
    await Promise.resolve();
    expect(speculate).not.toHaveBeenCalled();
  });

  it("replays a launched read once and resets unserved entries at the turn boundary", async () => {
    const { registry, invoke, service } = fixture();
    const tap = taps[0]!;
    const realCall = () => registry.invoke("compact.status", {}, {
      ...context, approve: async () => {}, audits: [], maxResultChars: 1000,
    });
    try {
      tap.launch("turn-call", { ref: "compact.status", args: {} }, extensionContext);
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
      expect(await realCall()).toEqual({ status: "idle" });
      expect(invoke).toHaveBeenCalledTimes(1);
      tap.launch("turn-call", { ref: "compact.status", args: {} }, extensionContext);
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
      service.reset();
      expect(service.tap?.reset).toHaveBeenCalledOnce();
      await realCall();
      expect(invoke).toHaveBeenCalledTimes(3);
    } finally {
      service.reset();
      await registry.close();
    }
  });

  it("resolves the capability commitment at launch time", async () => {
    const { registry, service, setView } = fixture();
    const lease = await registry.acquireCapabilityView(["compact.status"], context);
    expect(lease.satisfied).toBe(true);
    setView(lease.view);
    const speculate = vi.spyOn(registry, "speculate");
    try {
      taps[0]!.launch("turn-call", { ref: "compact.status", args: {} }, extensionContext);
      await vi.waitFor(() => expect(speculate).toHaveBeenCalledOnce());
      expect(speculate.mock.calls[0]?.[2]).toMatchObject({
        capabilityView: lease.view,
        parentToolCallId: "turn-call",
        nestedToolCallId: "fabric-speculation",
      });
    } finally {
      service.reset();
      await lease.release();
      await registry.close();
    }
  });
});
