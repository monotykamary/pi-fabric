import fs from "node:fs";
import childProcess from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FabricRuntimeState } from "../src/fabric-runtime-state.js";
import { FabricManagedHost } from "../src/managed-host.js";
import { CapturedToolCatalog } from "../src/capture/catalog.js";
import { AgentService, createAgentServiceClient, createAgentServiceHandler, createAgentsProvider } from "../src/agents.js";

vi.mock("../src/agents/manager.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/agents/manager.js")>();
  return {...original, AgentManager: class { constructor() {throw new Error("Native AgentManager constructed");} }};
});

describe("managed runtime early composition", () => {
  it("mounts hosted agents and reloads without native manager, filesystem, config, model-history or session access", async () => {
    const service = new AgentService({rootId: "root", port: {execute: async () => ({status: "completed", text: "hosted"})}});
    const provider = createAgentsProvider(createAgentServiceClient(createAgentServiceHandler(service, "root")));
    const closed = vi.fn(async () => service.close());
    provider.close = closed;
    const host = new FabricManagedHost({providers: ["agents"]});
    host.register(provider);
    const pi = {events: {emit: vi.fn()}} as unknown as ExtensionAPI;
    const forbidden = () => {throw new Error("Ambient host access");};
    const context = {
      cwd: "/not-a-real-hosted-directory", hasUI: false, ui: {setStatus: vi.fn()}, isProjectTrusted: forbidden,
      sessionManager: new Proxy({}, {get: forbidden}), modelRegistry: new Proxy({}, {get: forbidden}),
    } as unknown as ExtensionContext;
    const runtime = new FabricRuntimeState(pi, new CapturedToolCatalog(), {managedHost: host});
    const read = vi.spyOn(fs, "readFileSync").mockImplementation(forbidden);
    const mkdir = vi.spyOn(fs, "mkdirSync").mockImplementation(forbidden);
    const spawn = vi.spyOn(childProcess, "spawn").mockImplementation(forbidden);
    try {
      await runtime.initialize(context);
      expect(runtime.initialized).toBe(true);
      const invocation = {cwd: context.cwd, signal: undefined, parentToolCallId: "test", nestedToolCallId: "nested", extensionContext: context, update() {}, approve: async () => {}, audits: [], maxResultChars: 10000};
      expect(await runtime.registry.invoke("agents.run", {task: "hosted"}, invocation)).toMatchObject({status: "completed", text: "hosted"});
      await runtime.components.reload("fabric.provider.agents");
      await runtime.initialize(context);
      expect(await runtime.registry.invoke("agents.run", {task: "again"}, invocation)).toMatchObject({status: "completed"});
      expect(closed).not.toHaveBeenCalled();
      expect(() => runtime.agents).toThrow();
      expect(read).not.toHaveBeenCalled(); expect(mkdir).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled();
      await runtime.shutdown();
      await host.close();
      expect(closed).toHaveBeenCalledOnce();
    } finally {
      vi.restoreAllMocks();
      await runtime.shutdown();
      await host.close();
    }
  });
});
