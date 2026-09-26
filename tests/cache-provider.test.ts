import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheProvider } from "../src/providers/cache-provider.js";
import { MAX_CACHE_LEASES } from "../src/cache/leases.js";
import { schemaRefAllowedInEnforce } from "../src/schema/policy.js";
import type { FabricCacheHoldResult, FabricCacheStatus, FabricInvocationContext } from "../src/protocol.js";

function fixture(supported = true, isMain = true) {
  const handlers = new Map<string, Set<(event: unknown, context: ExtensionContext) => unknown>>();
  const nativeOwners = new Set<symbol>();
  const releaseNative = vi.fn((key: symbol) => { nativeOwners.delete(key); });
  const acquire = vi.fn(() => { const key = Symbol(); nativeOwners.add(key); return () => releaseNative(key); });
  const host = {
    model: { provider: "test", id: "model" }, thinkingLevel: "off", getSystemPrompt: () => "stable prompt",
    sessionManager: { getSessionId: () => "session", getLeafEntry: () => undefined, getEntry: () => undefined },
    ...(supported ? { acquireCacheWarming: acquire } : {}),
  } as unknown as ExtensionContext;
  const pi = {
    getActiveTools: vi.fn(() => ["fabric_exec"]), getThinkingLevel: () => "off",
    on: vi.fn((name: string, callback: (event: unknown, context: ExtensionContext) => unknown) => {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name)!.add(callback);
      return () => { handlers.get(name)!.delete(callback); };
    }),
  };
  const provider = new CacheProvider(pi as unknown as ExtensionAPI, host, isMain);
  const ctx: FabricInvocationContext = { cwd: process.cwd(), signal: undefined, parentToolCallId: "outer", nestedToolCallId: "inner", extensionContext: host, update() {} };
  const hold = (args: Record<string, unknown> = {}) => provider.invoke("hold", { durationMs: 10_000, ...args }, ctx) as Promise<FabricCacheHoldResult>;
  const status = () => provider.invoke("status", {}, ctx) as Promise<FabricCacheStatus>;
  const emit = async (name: string) => { for (const handler of [...handlers.get(name) ?? []]) await handler({}, host); };
  return { provider, host, ctx, hold, status, emit, acquire, releaseNative, nativeOwners, pi, handlers };
}
function held(result: FabricCacheHoldResult) {
  if (result.status !== "held") throw new Error(result.reason);
  return result;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("CacheProvider", () => {
  it("is idle on construction and observation; older SDKs have no paid fallback", async () => {
    const f = fixture(false);
    expect(await f.status()).toMatchObject({ supported: false, leases: [], scheduled: null, observation: { lastRequest: null } });
    for (let i = 0; i < 3; i++) expect(await f.hold()).toMatchObject({ status: "unsupported" });
    expect(f.acquire).not.toHaveBeenCalled();
    expect(f.pi.on).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await f.provider.close();
  });
  it("declares honest read, paid-emission, and scoped effects", async () => {
    const f = fixture();
    expect((await f.provider.list({})).map(d => [d.name, d.risk, d.effect?.kind])).toEqual([
      ["status", "read", "none"], ["hold", "agent", "emission"], ["release", "write", "emission"], ["lease", "agent", "scoped"],
    ]);
    expect(await f.provider.describe("missing")).toBeUndefined();
    expect((await f.provider.list({ query: "Idempotently" })).map(d => d.name)).toEqual(["release"]);
    expect(schemaRefAllowedInEnforce("cache.status")).toBe(true);
    for (const ref of ["cache.hold", "cache.release", "cache.lease"]) expect(schemaRefAllowedInEnforce(ref)).toBe(false);
  });
  it("shares one native lease, releases independently, and preserves other native owners", async () => {
    const f = fixture();
    const externalRelease = f.acquire();
    const a = held(await f.hold()), b = held(await f.hold({ durationMs: 20_000 }));
    expect(f.acquire).toHaveBeenCalledTimes(2);
    expect(await f.provider.invoke("release", { id: a.id }, f.ctx)).toEqual({ released: true, cleanupError: null });
    expect(await f.provider.invoke("release", { id: a.id }, f.ctx)).toEqual({ released: false, cleanupError: null });
    expect(f.nativeOwners.size).toBe(2);
    await f.provider.invoke("release", { id: b.id }, f.ctx);
    expect(f.nativeOwners.size).toBe(1);
    externalRelease();
    await f.provider.close();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("expires by duration even if the wall clock moves backwards, without inference or renewal", async () => {
    const f = fixture();
    held(await f.hold({ durationMs: 1_000 }));
    vi.setSystemTime(Date.now() - 60_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await f.status()).leases).toEqual([]);
    expect(f.releaseNative).toHaveBeenCalledTimes(1);
    expect(f.acquire).toHaveBeenCalledTimes(1);
    await f.provider.close();
  });
  it.each(["session_start", "session_before_switch", "session_before_fork", "session_tree", "session_before_compact", "session_compact", "model_select", "session_shutdown"])("releases on %s without restarting warming", async event => {
    const f = fixture(); held(await f.hold()); await f.emit(event);
    expect((await f.status()).leases).toEqual([]);
    expect(f.releaseNative).toHaveBeenCalledTimes(1);
    expect(f.acquire).toHaveBeenCalledTimes(1);
    await f.provider.close();
    expect([...f.handlers.values()].every(set => set.size === 0)).toBe(true);
  });
  it.each(["model", "thinking", "prompt", "tools", "support"])("fences changed %s before a native decision without overriding the event", async change => {
    const f = fixture(); held(await f.hold());
    if (change === "model") f.host.model!.id = "other";
    if (change === "thinking") (f.host as { thinkingLevel?: string }).thinkingLevel = "high";
    if (change === "prompt") f.host.getSystemPrompt = () => "changed";
    if (change === "tools") f.pi.getActiveTools.mockReturnValue(["read"]);
    if (change === "support") delete (f.host as unknown as { acquireCacheWarming?: unknown }).acquireCacheWarming;
    for (const callback of f.handlers.get("cache_warming_decision")!) expect(await callback({}, f.host)).toBeUndefined();
    expect((await f.status()).leases).toEqual([]);
    await f.provider.close();
  });
  it("rejects unsupported hard budgets before acquiring any native interest", async () => {
    const f = fixture();
    for (const args of [{ maxCostUsd: 0.10 }, { maxRefreshes: 2 }]) expect(await f.hold(args)).toMatchObject({ status: "unsupported", reason: expect.stringContaining("bounds cannot be enforced") });
    expect(f.acquire).not.toHaveBeenCalled();
    await f.provider.close();
  });
  it("validates bounded inputs and local target authority", async () => {
    const f = fixture(true, false);
    for (const args of [{ durationMs: 0 }, { durationMs: 1_800_001 }, { durationMs: 1000.5 }, { durationMs: NaN }, { maxCostUsd: Infinity }, { maxRefreshes: -1 }, { target: "actor-id" }, { extra: true }]) await expect(f.hold(args)).rejects.toThrow();
    await expect(f.hold({ target: "main" })).rejects.toThrow("not local");
    f.host.sessionManager.getSessionId = () => "other-session";
    await expect(f.hold()).rejects.toThrow("different session");
    expect(f.acquire).not.toHaveBeenCalled();
    await f.provider.close();
  });
  it("ties component release to its disposer rather than guest possession of an id", async () => {
    const f = fixture();
    const scoped = await f.provider.acquire("lease", { durationMs: 10_000 }, f.ctx);
    const lease = held(scoped.value as FabricCacheHoldResult);
    await expect(f.provider.invoke("release", { id: lease.id }, f.ctx)).rejects.toThrow("owning scope");
    await expect(f.provider.invoke("lease", {}, f.ctx)).rejects.toThrow("context.acquire");
    await scoped.dispose(); await scoped.dispose();
    expect(f.releaseNative).toHaveBeenCalledTimes(1);
    await f.provider.close();
  });
  it("cancels on abort, but a successful hold survives its completed allocating invocation", async () => {
    const f = fixture(); const abort = new AbortController(); f.ctx.signal = abort.signal;
    held(await f.hold()); abort.abort();
    expect((await f.status()).leases).toEqual([]);
    await expect(f.hold()).rejects.toThrow();
    const later = new AbortController(); f.ctx.signal = later.signal;
    held(await f.hold()); await f.provider.invocationEnded("outer"); later.abort();
    expect((await f.status()).leases).toHaveLength(1);
    await f.provider.close();
  });
  it("does not retry failed native acquisition on the same binding", async () => {
    const f = fixture(); f.acquire.mockImplementation(() => { throw new Error("failed"); });
    for (let i = 0; i < 5; i++) expect(await f.hold()).toMatchObject({ status: "unavailable" });
    expect(f.acquire).toHaveBeenCalledTimes(1);
    await f.provider.close();
  });
  it("reports cleanup failures, blocks new spending, and retries cleanup on close", async () => {
    const f = fixture(); const lease = held(await f.hold());
    f.releaseNative.mockImplementationOnce(() => { throw new Error("cleanup failed"); });
    expect(await f.provider.invoke("release", { id: lease.id }, f.ctx)).toMatchObject({ released: true, cleanupError: "Native cache lease cleanup failed" });
    expect(await f.hold()).toMatchObject({ status: "unavailable" });
    await f.provider.close();
    expect(f.nativeOwners.size).toBe(0);
  });
  it("bounds retained handles and closes every timer and subscription", async () => {
    const f = fixture();
    for (let i = 0; i < MAX_CACHE_LEASES; i++) held(await f.hold());
    expect(await f.hold()).toMatchObject({ status: "unavailable", reason: "Cache lease capacity reached" });
    expect(f.acquire).toHaveBeenCalledTimes(1);
    await f.provider.close(); await f.provider.close();
    expect(vi.getTimerCount()).toBe(0);
    expect(await f.hold()).toMatchObject({ status: "unavailable" });
  });
});
