import { describe, expect, it } from "vitest";
import { NodeProcessRuntime } from "../src/runtime/node-process-runtime.js";

const options = {
  timeoutMs: 5_000,
  memoryLimitBytes: 128 * 1024 * 1024,
};

describe("NodeProcessRuntime", () => {
  it("runs guest code in a disposable process and bridges host calls", async () => {
    const result = await new NodeProcessRuntime().execute(
      `
const models = await tools.models();
print("models", models.length);
return { models, process: typeof process, require: typeof require };
`,
      async (ref) => ref === "fabric.$models" ? [{ id: "large-model" }] : undefined,
      options,
    );

    expect(result.error).toBeUndefined();
    expect(result.logs).toEqual(["models 1"]);
    expect(result.value).toEqual({
      models: [{ id: "large-model" }],
      process: "undefined",
      require: "undefined",
    });
  });

  it("accepts a heap limit above the QuickJS WASM32 ceiling", async () => {
    const result = await new NodeProcessRuntime().execute(
      "return 1;",
      async () => undefined,
      { ...options, memoryLimitBytes: 5 * 1024 ** 3 },
    );

    expect(result.terminationReason).toBe("completed");
    expect(result.value).toBe(1);
  });

  it("waits for issued host calls before completing", async () => {
    let settled = false;
    const result = await new NodeProcessRuntime().execute(
      'void tools.call({ ref: "demo.background" }); return "done";',
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        settled = true;
      },
      options,
    );

    expect(result.value).toBe("done");
    expect(settled).toBe(true);
  });

  it("forcibly terminates synchronous infinite loops", async () => {
    const result = await new NodeProcessRuntime().execute(
      "while (true) {}",
      async () => undefined,
      { ...options, timeoutMs: 50 },
    );

    expect(result.terminationReason).toBe("timed_out");
    expect(result.error).toContain("timed out after 50ms");
  });

  it("terminates the child process when externally aborted", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("stop")), 25);
    const result = await new NodeProcessRuntime().execute(
      "await new Promise(() => {});",
      async () => undefined,
      { ...options, signal: controller.signal },
    );

    expect(result.terminationReason).toBe("aborted");
    expect(result.error).toBe("Execution cancelled");
  });
});
