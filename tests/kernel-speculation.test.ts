import type { ExtensionContext, MessageUpdateEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeFabricConfig } from "../src/config.js";
import { ActionRegistry, type FabricCallAudit } from "../src/core/action-registry.js";
import type { FabricInvocationContext } from "../src/protocol.js";
import { RuntimeStateSpeculation } from "../src/runtime-state-speculation.js";
import { LiteralCallScanner } from "../src/speculation/scanner.js";
import { FabricSpeculationStore } from "../src/speculation/store.js";
import { FabricSpeculationStreamTap } from "../src/speculation/stream-tap.js";

const context = { cwd: process.cwd() } as ExtensionContext;
const event = (type: "toolcall_start" | "toolcall_delta", delta = ""): MessageUpdateEvent => ({
  assistantMessageEvent: {
    type, contentIndex: 0, delta,
    partial: { content: [{ type: "toolCall", name: "fabric_exec", id: "call" }] },
  },
} as MessageUpdateEvent);
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const makeStore = () => new FabricSpeculationStore({ maxConcurrent: 4, maxEntries: 8, entryTtlMs: 1000 });
const streamFixture = () => {
  let enabled = true;
  const launch = vi.fn();
  const tap = new FabricSpeculationStreamTap({
    enabled: () => enabled, maxBufferBytes: () => 4096, isEligible: () => true, launch,
  });
  const start = (code = "return await compact.status()") => {
    tap.handleMessageUpdate(event("toolcall_start"), context);
    tap.handleMessageUpdate(event("toolcall_delta", JSON.stringify({ code })), context);
  };
  return { tap, launch, start, disable() { enabled = false; }, enable() { enabled = true; } };
};

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("kernel speculation boundaries", () => {
  it.each(["monty", "cpython"] as const)("Python/%s loads a Python scanner and speculative store", async (pythonRuntime) => {
    const config = normalizeFabricConfig({ executor: { kernel: "python", pythonRuntime } });
    const registry = new ActionRegistry();
    const install = vi.spyOn(registry, "setSpeculation");
    const scan = vi.spyOn(LiteralCallScanner.prototype, "push");
    const service = new RuntimeStateSpeculation(registry,
      () => config.speculation, () => undefined, () => true, "python");
    const speculate = vi.spyOn(registry, "speculate").mockResolvedValue(undefined);
    expect(service.tap).toBeDefined();
    expect(install).toHaveBeenCalledOnce();
    service.tap!.handleMessageUpdate(event("toolcall_start"), context);
    service.tap!.handleMessageUpdate(event("toolcall_delta", JSON.stringify({ code: 'await pi.read(path="x")' })), context);
    await vi.waitFor(() => {
      service.tap!.flushCatchUp(context);
      expect(speculate).toHaveBeenCalledOnce();
    });
    expect(speculate.mock.calls[0]?.slice(0, 2)).toEqual(["pi.read", { path: "x" }]);
    expect(scan).not.toHaveBeenCalled();
    service.reset();
    await registry.close();
  });

  it("does not parse Python or resume an old TS prefix while disabled", () => {
    const { tap, launch, start, disable, enable } = streamFixture();
    const scan = vi.spyOn(LiteralCallScanner.prototype, "push");
    start();
    disable();
    tap.setScannerFactory(() => new LiteralCallScanner());
    start('return await compact.status() # valid in both language prefixes');
    tap.flushCatchUp(context);
    expect(scan).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    enable();
    tap.handleMessageUpdate(event("toolcall_delta", ")"), context);
    expect(scan).not.toHaveBeenCalled();
    start();
    expect(launch).toHaveBeenCalledOnce();
  });

  it.each(["reset", "disable"] as const)("drops lazy scanner catch-up at %s", (boundary) => {
    const { tap, launch, start, disable, enable } = streamFixture();
    start();
    tap.setScannerFactory(() => new LiteralCallScanner());
    if (boundary === "reset") tap.reset();
    else disable();
    tap.flushCatchUp(context);
    enable();
    tap.flushCatchUp(context);
    expect(launch).not.toHaveBeenCalled();
  });

  it("retains ordinary TypeScript catch-up and eligibility", () => {
    const launch = vi.fn();
    const tap = new FabricSpeculationStreamTap({
      enabled: () => true, maxBufferBytes: () => 4096,
      isEligible: (ref) => ref === "compact.status", launch,
    });
    tap.handleMessageUpdate(event("toolcall_start"), context);
    tap.handleMessageUpdate(event("toolcall_delta", JSON.stringify({
      code: 'await compact.status(); await pi.write({path:"x", content:"y"});',
    })), context);
    tap.setScannerFactory(() => new LiteralCallScanner());
    tap.flushCatchUp(context);
    expect(launch).toHaveBeenCalledExactlyOnceWith("call", { ref: "compact.status", args: {} }, context);
  });

  it.each(["reset", "mutation", "invocation end"] as const)("rejects a claimed promise after %s", async (boundary) => {
    const store = makeStore();
    const result = deferred<string>();
    let signal!: AbortSignal;
    store.launch("call", "compact.status", {}, (abort) => { signal = abort; return result.promise; }, undefined, {}, "binding");
    const serving = store.tryServe("call", "compact.status", {}, "binding");
    await Promise.resolve();
    if (boundary === "reset") store.reset();
    else if (boundary === "mutation") store.bumpEpoch();
    else store.onInvocationEnd("call");
    result.resolve("old TS result");
    expect(await serving).toEqual({ hit: false, reason: "epoch" });
    expect(signal.aborted).toBe(true);
    expect(store.stats().served).toBe(0);
  });

  it("reexecutes through the audited registry when a claimed result is reset", async () => {
    const registry = new ActionRegistry();
    const store = makeStore();
    const pending = deferred<string>();
    const invoke = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue("fresh");
    const action = { name: "status", description: "Read", inputSchema: { type: "object" }, risk: "read" as const, effect: { kind: "none" as const } };
    registry.register({ name: "compact", description: "Test", async list() { return [action]; }, async describe() { return action; }, invoke });
    registry.setSpeculation(store, () => true);
    const invocation: FabricInvocationContext = {
      cwd: context.cwd, extensionContext: context, signal: undefined,
      parentToolCallId: "call", nestedToolCallId: "nested", update() {},
    };
    const prepared = await registry.speculate("compact.status", {}, invocation, {});
    expect(prepared).toBeDefined();
    store.launch("call", "compact.status", {}, prepared!.execute, undefined, {}, prepared!.bindingToken);
    const entered = deferred<void>();
    const serve = store.tryServe.bind(store);
    vi.spyOn(store, "tryServe").mockImplementation((...args) => {
      const result = serve(...args);
      entered.resolve();
      return result;
    });
    const approve = vi.fn(async () => {});
    const audits: FabricCallAudit[] = [];
    try {
      const result = registry.invoke("compact.status", {}, { ...invocation, approve, audits, maxResultChars: 1000 });
      await entered.promise;
      store.reset();
      pending.resolve("old");
      expect(await result).toBe("fresh");
      expect(invoke).toHaveBeenCalledTimes(2);
      expect(approve).toHaveBeenCalledOnce();
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ ref: "compact.status", success: true });
      expect(audits[0]?.speculated).not.toBe(true);
    } finally {
      store.reset();
      await registry.close();
    }
  });

  it("fences preparation across reset, mutation and invocation end", () => {
    const store = makeStore();
    const beforeReset = store.captureLaunch("call");
    store.reset();
    expect(beforeReset()).toBe(false);
    const beforeMutation = store.captureLaunch("call");
    store.bumpEpoch();
    expect(beforeMutation()).toBe(false);
    const beforeEnd = store.captureLaunch("call");
    store.onInvocationEnd("call");
    expect(beforeEnd()).toBe(false);
    expect(store.launch("call", "compact.status", {}, async () => "late", undefined, {}, "binding")).toBe(false);
    store.reset();
    expect(beforeEnd()).toBe(false);
    expect(store.captureLaunch("new-call")()).toBe(true);
  });

  it("rechecks external freshness after waiting for the provider", async () => {
    const store = makeStore();
    const result = deferred<string>();
    let fresh = true;
    store.launch("call", "pi.read", {}, () => result.promise, () => fresh, {}, "binding");
    const serving = store.tryServe("call", "pi.read", {}, "binding");
    fresh = false;
    result.resolve("stale");
    expect(await serving).toEqual({ hit: false, reason: "freshness" });
  });

  it.each([false, true])("honors TTL at consumption, pending=%s", async (pending) => {
    vi.useFakeTimers();
    const store = makeStore();
    const result = deferred<string>();
    store.launch("call", "compact.status", {}, () => result.promise, undefined, {}, "binding");
    const serving = pending ? store.tryServe("call", "compact.status", {}, "binding") : undefined;
    vi.advanceTimersByTime(1001);
    result.resolve("expired");
    expect(await (serving ?? store.tryServe("call", "compact.status", {}, "binding"))).toEqual({ hit: false, reason: "absent" });
  });
});
