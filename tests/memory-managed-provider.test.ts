import { expect, it } from "vitest";
import { createMemoryProvider, createMemorySourceClient, createMemorySourceRegistry, memoryActionSchemas } from "../src/memory.js";
import type { FabricInvocationContext } from "../src/protocol.js";
import { messageEntry, sessionHeader, userMessage } from "./fixtures/memory.js";

import { QuickJsRuntime } from "../src/runtime/quickjs-runtime.js";

it("walks native portable pages and exact compacted operation follows inside QuickJS", async () => {
  const text = "retained café 🐚 ".repeat(100);
  const fact = { kind: "operation", entryId: "original", subordinal: "0", address: "original/0",
    ref: "pi.write", provider: "pi", action: "write", tool: "write",
    args: { path: "src/fake.ts" }, outcome: "succeeded", result: { bytes: 5 } };
  const records = [sessionHeader("s", "/work/fake"),
    messageEntry("root", null, "2024-01-01", userMessage(text)),
    { type: "branch_summary", id: "carrier", parentId: "root", fromId: "original", timestamp: "2024-01-02",
      summary: "nonsemantic prose", details: { kind: "pi-fabric.branch-summary", version: 1,
        source: { firstEntryId: "original", lastEntryId: "original", entryCount: 1 },
        facts: [fact], omittedFacts: 0, sections: ["[Fabric Activity]"],
        request: { text: "", sourceBytes: 0, truncated: false } } }];
  const sources = createMemorySourceRegistry();
  sources.register({ interfaceVersion: 1, id: "local",
    async listSessions() { return [{ sessionKey: "s", revision: "restored" }]; },
    async loadSession() { return { sessionKey: "s", revision: "restored", records, selectedLeafId: "carrier" }; },
  });
  const client = createMemorySourceClient({ sources });
  const provider = createMemoryProvider({ defaultSession: () => "s",
    dispatch: (action, args, ctx) => action === "expand"
      ? client.expand({ ...args, source: "local", session: String(args.session) }, ctx.signal ? { signal: ctx.signal } : {})
      : client[action]({ ...args, source: "local" }, ctx.signal ? { signal: ctx.signal } : {}),
  });
  const result = await new QuickJsRuntime().execute(`
    const hits = await memory.recall({ ref: "pi.write", outcome: "succeeded" });
    const exact = await tools.call(hits.hits[0].follow);
    let text = "";
    const walk = await memory.walk({ maxChars: 64, maxEntries: 1 }, entry => {
      if (entry.entryId === "root") text += entry.text;
    });
    return { text, walk, exact: exact.entries[0] };
  `, async (ref, args) => {
    if (ref === "fabric.$call") { ref = String(args.ref); args = args.args as Record<string, unknown>; }
    if (!ref.startsWith("memory.")) throw new Error("Unexpected guest capability");
    return provider.invoke(ref.slice(7), await provider.prepareArguments!(ref.slice(7), args, context), context);
  },
  { timeoutMs: 10000, memoryLimitBytes: 32 * 1024 * 1024 });
  expect(result.error).toBeUndefined();
  expect(result.value).toMatchObject({ text, walk: { visited: 3, stopped: false },
    exact: { operationAddress: "original/0", carrierEntryId: "carrier", ref: "pi.write", outcome: "succeeded" } });
});

const context: FabricInvocationContext = {
  cwd: "/work/fake", signal: undefined, parentToolCallId: "test", nestedToolCallId: "nested",
  extensionContext: {} as FabricInvocationContext["extensionContext"], update() {},
};
it("uses canonical descriptors and fences dispatcher results and unknown actions", async () => {
  let stopped = false;
  const provider = createMemoryProvider({
    check() { if (stopped) throw new Error("paused"); },
    async dispatch() { stopped = true; return "private"; },
  });
  for (const name of ["recall", "expand", "sessions"] as const) {
    expect(await provider.describe(name, context)).toMatchObject(memoryActionSchemas[name]);
  }
  await expect(provider.invoke("walk", {}, context)).rejects.toThrow("Unknown memory action");
  await expect(provider.invoke("recall", {}, context)).rejects.toThrow("paused");
  const controller = new AbortController();
  const aborting = createMemoryProvider({ async dispatch() { controller.abort(); return "private"; } });
  await expect(aborting.invoke("recall", {}, { ...context, signal: controller.signal })).rejects.toThrow();
});

it("observes live leaf navigation without revision changes in recall, expansion and sessions", async () => {
  let selectedLeafId: string | null = "a";
  const records = [sessionHeader("s", "/work/fake"),
    messageEntry("root", null, "2024-01-01", userMessage("root")),
    messageEntry("a", "root", "2024-01-02", userMessage("alpha")),
    messageEntry("b", "root", "2024-01-03", userMessage("beta"))];
  const sources = createMemorySourceRegistry();
  sources.register({ interfaceVersion: 1, id: "live",
    async listSessions() { return [{ sessionKey: "s", revision: "same" }]; },
    async loadSession() { return { sessionKey: "s", revision: "same", records, selectedLeafId }; },
  });
  const client = createMemorySourceClient({ sources });
  const recall = () => client.recall({ source: "live", scope: "session:s", query: "alpha" }) as Promise<any>;
  const first = await recall();
  expect(first.hits).toHaveLength(1);
  const follow = first.hits[0].follow.args;
  const expanded = await client.expand(follow) as any;
  expect(expanded.entries[0].entryId).toBe("a");
  selectedLeafId = "b";
  expect((await recall()).hits).toHaveLength(0);
  expect(await client.expand(follow)).toMatchObject({ error: { code: "stale_pointer" }, entries: [] });
  expect(await client.recall({ source: "live", branches: "all", query: "alpha" })).toMatchObject({ total: 1 });
  selectedLeafId = null;
  expect(await client.sessions({ source: "live" })).toMatchObject({ sessions: [{ entryCount: 0 }] });
  expect(await client.expand({ source: "live", session: "s" })).toMatchObject({ entryCount: 0 });
  selectedLeafId = "missing";
  expect(await client.expand({ source: "live", session: "s" })).toMatchObject({ error: { code: "invalid_source_response" } });
});
