import type { ExtensionContext, MessageUpdateEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { normalizeFabricConfig } from "../src/config.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { FabricExecutionService } from "../src/execution-service.js";
import { RuntimeStateSpeculation } from "../src/runtime-state-speculation.js";
import { PythonLiteralCallScanner } from "../src/speculation/python-scanner.js";
import { availablePythonBackends, pythonBackends } from "./fixtures/python-backends.js";

const context = { cwd: process.cwd(), hasUI: false, sessionManager: { getSessionId: () => "speculation-python", getSessionFile: () => undefined } } as unknown as ExtensionContext;
const event = (type: "toolcall_start" | "toolcall_delta", delta = ""): MessageUpdateEvent => ({
  assistantMessageEvent: { type, contentIndex: 0, delta,
    partial: { content: [{ type: "toolCall", name: "fabric_exec", id: "python-spec" }] },
  },
} as MessageUpdateEvent);

describe.each(pythonBackends)("%s speculative host execution", (pythonRuntime) => {
  it.skipIf(!availablePythonBackends[pythonRuntime]).each(["hit", "reset", "mutation", "error", "deny"] as const)("preserves registry semantics: %s", async (mode) => {
    const config = normalizeFabricConfig({ executor: { kernel: "python", pythonRuntime, memoryLimitBytes: 256 * 1024 * 1024 } });
    const registry = new ActionRegistry();
    const invoke = vi.fn(async () => "fresh");
    if (mode === "error") invoke.mockRejectedValueOnce(new Error("speculative failure"));
    const descriptor = { name: "status", description: "Read fixture", risk: "read" as const, effect: { kind: "none" as const }, inputSchema: { type: "object" } };
    registry.register({ name: "compact", description: "Fixture", async list() { return [descriptor]; }, async describe() { return descriptor; }, invoke });
    const mutation = { name: "transition", description: "Write fixture", risk: "write" as const, effect: { kind: "emission" as const }, inputSchema: { type: "object" } };
    registry.register({ name: "state", description: "Fixture", async list() { return [mutation]; }, async describe() { return mutation; }, async invoke() { return {}; } });
    // Native CPython here exercises the real bridge with a controlled pure
    // program; production enables its tap only under OS sandbox enforcement.
    const speculation = new RuntimeStateSpeculation(registry, () => config.speculation, () => undefined, () => true, "python");
    const service = new FabricExecutionService(registry, config);
    const code = (mode === "mutation" ? 'await state.transition({})\n' : '') + 'return await compact.status(value={"enabled": True, "items": [None, -2]})';
    try {
      speculation.tap!.setScannerFactory(() => new PythonLiteralCallScanner());
      speculation.tap!.handleMessageUpdate(event("toolcall_start"), context);
      speculation.tap!.handleMessageUpdate(event("toolcall_delta", JSON.stringify({ code })), context);
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
      if (mode === "reset") speculation.reset();
      if (mode === "deny") config.approvals.read = "deny";
      const result = await service.execute({ code, signal: undefined, parentToolCallId: "python-spec", context, onPartial() {} });
      if (mode === "deny") {
        expect(result.success).toBe(false);
        expect(invoke).toHaveBeenCalledOnce();
      } else {
        expect(result.success, result.error).toBe(true);
        expect(result.value).toBe("fresh");
        expect(invoke).toHaveBeenCalledTimes(mode === "hit" ? 1 : 2);
        const audit = result.audits.find((audit) => audit.ref === "compact.status");
        expect(audit?.speculated === true).toBe(mode === "hit");
        expect(audit?.success).toBe(true);
      }
    } finally { speculation.reset(); await registry.close(); }
  });
});
