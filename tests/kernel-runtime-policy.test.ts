import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, MessageUpdateEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { CapturedToolCatalog } from "../src/capture/catalog.js";
import { normalizeFabricConfig } from "../src/config.js";
import { FabricRuntimeState } from "../src/fabric-runtime-state.js";
import { LiteralCallScanner } from "../src/speculation/scanner.js";

const fixture = async (python: boolean) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-kernel-policy-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", path.join(cwd, "agent"));
  vi.stubEnv("PI_FABRIC_PROJECT_ROOT", cwd);
  const pi = { events: { emit: vi.fn() }, getThinkingLevel: () => "off", sendMessage: vi.fn() } as unknown as ExtensionAPI;
  const context = {
    cwd, hasUI: false, isProjectTrusted: () => true, isIdle: () => true, hasPendingMessages: () => false,
    modelRegistry: { find: vi.fn(), getApiKeyAndHeaders: vi.fn() },
    sessionManager: { getSessionId: () => "kernel-policy", getSessionFile: () => undefined, getBranch: () => [], getLeafId: () => undefined },
    ui: { setStatus: vi.fn(), notify: vi.fn() },
  } as unknown as ExtensionContext;
  const config = normalizeFabricConfig({
    executor: { kernel: python ? "python" : "typescript" },
    speculation: { enabled: true }, mcp: { enabled: false, cache: { enabled: false } },
    agents: { enabled: false }, residency: { enabled: false }, prewalk: { enabled: false, alwaysRearm: false },
  });
  const unused = path.join(cwd, "unused.mjs");
  fs.writeFileSync(unused, "export default {};");
  const runtime = new FabricRuntimeState(pi, new CapturedToolCatalog(), { paths: { extension: unused, worker: unused, residentHost: unused, skills: cwd } });
  await runtime.initialize(context, config);
  const reload = (update: (next: typeof config) => void) => {
    const next = structuredClone(config);
    update(next);
    runtime.reloadConfig(context, next);
  };
  const close = async () => { await runtime.shutdown(); vi.unstubAllEnvs(); fs.rmSync(cwd, { recursive: true, force: true }); };
  return { runtime, reload, close, context };
};

const streamEvent = (type: "toolcall_start" | "toolcall_delta", delta = ""): MessageUpdateEvent => ({
  assistantMessageEvent: { type, contentIndex: 0, delta,
    partial: { content: [{ type: "toolCall", name: "fabric_exec", id: "policy-call" }] },
  },
} as MessageUpdateEvent);

describe("real runtime kernel policy wiring", () => {
  it.each(["allow", "read-deny", "read-ask", "core-hidden", "network-ask", "network-deny", "enforce-mcp"])("checks speculative policy before lookup: %s", async (policy) => {
    const { runtime, reload, close, context } = await fixture(false);
    try {
      reload((config) => {
        config.fullCodeMode = policy !== "core-hidden";
        config.approvals.read = policy === "read-deny" ? "deny" : policy === "read-ask" ? "ask" : "allow";
        config.approvals.network = policy === "network-ask" ? "ask" : policy === "network-deny" ? "deny" : "allow";
        config.speculation.mcpAllowlist = ["demo.read"];
      });
      if (policy === "enforce-mcp") runtime.setSchemaMode("enforce", "quickjs");
      const tap = runtime.speculationTap!;
      expect(tap).toBeDefined();
      tap.setScannerFactory(() => new LiteralCallScanner());
      const speculate = vi.spyOn(runtime.registry, "speculate");
      const code = policy.includes("network") || policy === "enforce-mcp"
        ? 'return await mcp.demo.read({});' : 'return await pi.read({path:"unused.mjs"});';
      tap.handleMessageUpdate(streamEvent("toolcall_start"), context);
      tap.handleMessageUpdate(streamEvent("toolcall_delta", JSON.stringify({ code })), context);
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (policy === "allow") expect(speculate).toHaveBeenCalledOnce();
      else expect(speculate).not.toHaveBeenCalled();
    } finally { await close(); }
  });

  it.each([false, true])("recreates speculation only for isolated TS (starts Python=%s)", async (python) => {
    const { runtime, reload, close } = await fixture(python);
    try {
      expect(Boolean(runtime.speculationTap)).toBe(!python);
      reload((config) => { config.executor.kernel = "typescript"; });
      const first = runtime.speculationTap!;
      expect(first).toBeDefined();
      const reset = vi.spyOn(first, "reset");
      reload((config) => { config.fullCodeMode = !config.fullCodeMode; });
      expect(reset).toHaveBeenCalled();
      expect(runtime.speculationTap).not.toBe(first);
      reload((config) => { config.executor.runtime = "node-process"; });
      expect(runtime.speculationTap).toBeUndefined();
      runtime.setSchemaMode("enforce", "quickjs");
      expect(runtime.speculationTap).toBeDefined();
      runtime.setSchemaMode("off", "node-process");
      expect(runtime.speculationTap).toBeUndefined();
      reload((config) => { config.executor.kernel = "python"; config.executor.pythonRuntime = "cpython"; });
      expect(runtime.speculationTap).toBeUndefined();
      reload((config) => { config.executor.pythonRuntime = "monty"; });
      expect(runtime.speculationTap).toBeUndefined();
      reload((config) => { config.executor.kernel = "typescript"; config.executor.runtime = "quickjs"; config.speculation.enabled = false; });
      expect(runtime.speculationTap).toBeUndefined();
      reload((config) => { config.speculation.enabled = true; config.speculation.maxEntries = 1; });
      expect(runtime.speculationTap).toBeDefined();
    } finally { await close(); }
  });
});
