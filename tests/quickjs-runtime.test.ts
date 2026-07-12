import { describe, expect, it, vi } from "vitest";
import { QuickJsRuntime } from "../src/runtime/quickjs-runtime.js";

const options = {
  timeoutMs: 5_000,
  memoryLimitBytes: 32 * 1024 * 1024,
};

describe("QuickJsRuntime", () => {
  it("runs parallel host calls and returns structured data", async () => {
    const hostCall = vi.fn(async (ref: string, args: Record<string, unknown>) => ({
      ref,
      value: args.value,
    }));
    const result = await new QuickJsRuntime().execute(
      `
const values = await Promise.all([
  tools.call({ ref: "demo.echo", args: { value: 1 } }),
  tools.call({ ref: "demo.echo", args: { value: 2 } }),
]);
print("calls", values.length);
return values;
`,
      hostCall,
      options,
    );
    expect(result.error).toBeUndefined();
    expect(result.logs).toEqual(["calls 2"]);
    expect(result.value).toEqual([
      { ref: "fabric.$call", value: undefined },
      { ref: "fabric.$call", value: undefined },
    ]);
    expect(hostCall.mock.calls[0]?.[1]).toEqual({ ref: "demo.echo", args: { value: 1 } });
    expect(hostCall).toHaveBeenCalledTimes(2);
  });

  it("does not expose Node globals", async () => {
    const result = await new QuickJsRuntime().execute(
      "return { process: typeof process, require: typeof require };",
      async () => undefined,
      options,
    );
    expect(result.value).toEqual({ process: "undefined", require: "undefined" });
  });

  it("times out unresolved guest promises", async () => {
    const startedAt = Date.now();
    const result = await new QuickJsRuntime().execute(
      "await new Promise(() => {});",
      async () => undefined,
      { ...options, timeoutMs: 50 },
    );
    expect(result.error).toContain("timed out");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("interrupts synchronous infinite loops", async () => {
    const result = await new QuickJsRuntime().execute(
      "while (true) {}",
      async () => undefined,
      { ...options, timeoutMs: 50 },
    );
    expect(result.error).toBeDefined();
  });
});
