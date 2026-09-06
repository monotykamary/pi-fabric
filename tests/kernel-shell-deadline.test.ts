import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeFabricConfig } from "../src/config.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { FabricExecutionService } from "../src/execution-service.js";
import { CPythonRuntime } from "../src/runtime/cpython-runtime.js";
import { MontyRuntime } from "../src/runtime/monty-runtime.js";

afterEach(() => vi.restoreAllMocks());

describe.each(["monty", "cpython"] as const)("%s repaired shell deadline", (pythonRuntime) => {
  it("normalizes direct and generic numeric aliases before evaluating floors", async () => {
    const config = normalizeFabricConfig({ executor: { kernel: "python", pythonRuntime } });
    config.executor.timeoutMs = 100;
    const prototype = pythonRuntime === "monty" ? MontyRuntime.prototype : CPythonRuntime.prototype;
    vi.spyOn(prototype, "execute").mockImplementation(async (_code, _host, options) => ({
      terminationReason: "completed", logs: [], value: [
        options.minimumTimeoutMsForHostCall!("pi.bash", { timeout: "1" }),
        options.minimumTimeoutMsForHostCall!("fabric.$call", { ref: "pi.bash", args: { timeoutMs: "1000" } }),
        options.minimumTimeoutMsForHostCall!("pi.bash", { timeout: "2", timeoutMs: "1000" }),
      ],
    }));
    const registry = new ActionRegistry();
    try {
      const result = await new FabricExecutionService(registry, config).execute({
        code: "return 1", signal: undefined, parentToolCallId: "deadline", context: { cwd: process.cwd() } as ExtensionContext, onPartial() {},
      });
      expect(result).toMatchObject({ success: true, value: [6000, 6000, 7000] });
    } finally { await registry.close(); }
  });
});
