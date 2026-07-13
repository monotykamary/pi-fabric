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

  it("runs phased workflow fan-out and returns only worker values", async () => {
    const calls: string[] = [];
    const result = await new QuickJsRuntime().execute(
      `
await phase("Inspect");
const values = await parallel([
  () => agent("first", { label: "one" }),
  () => agent("second", { label: "two" }),
]);
return { values, spent: budget.spent() };
`,
      async (ref, args) => {
        calls.push(ref);
        if (ref === "fabric.$phase") return { name: args.name, index: 0 };
        if (ref === "agents.run") {
          return {
            status: "completed",
            text: String(args.task).toUpperCase(),
            usage: { input: 2, output: 3 },
          };
        }
        throw new Error(`Unexpected call: ${ref}`);
      },
      { ...options, tokenBudget: 20 },
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({ values: ["FIRST", "SECOND"], spent: 10 });
    expect(calls).toEqual(["fabric.$phase", "agents.run", "agents.run"]);
  });

  it("calls captured extension tools through the lazy proxy", async () => {
    const result = await new QuickJsRuntime().execute(
      'return extensions.deploy_release({ environment: "staging" });',
      async (ref, args) => {
        expect(ref).toBe("extensions.deploy_release");
        expect(args).toEqual({ environment: "staging" });
        return { text: "deployed", content: [], isError: false };
      },
      options,
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toMatchObject({ text: "deployed", isError: false });
  });

  it("exposes durable mesh operations through the host bridge", async () => {
    const result = await new QuickJsRuntime().execute(
      `
const self = await mesh.self();
await mesh.publish({ topic: "team.auth", text: "ready" });
return self.name;
`,
      async (ref) => {
        if (ref === "mesh.self") return { id: "actor-1", name: "reviewer", kind: "actor" };
        if (ref === "mesh.publish") return { sequence: 1 };
        throw new Error(`Unexpected call: ${ref}`);
      },
      options,
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toBe("reviewer");
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

  it("aborts sibling host calls when guest workflow code fails", async () => {
    let hostCallAborted = false;
    const result = await new QuickJsRuntime().execute(
      `
await Promise.all([
  tools.call({ ref: "demo.wait" }),
  Promise.reject(new Error("branch failed")),
]);
`,
      async (_ref, _args, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              hostCallAborted = true;
              reject(new Error("host call aborted"));
            },
            { once: true },
          );
        }),
      options,
    );
    expect(result.error).toContain("branch failed");
    expect(hostCallAborted).toBe(true);
  });

  it("aborts in-flight host calls when the sandbox deadline expires", async () => {
    let hostCallAborted = false;
    const result = await new QuickJsRuntime().execute(
      'await tools.call({ ref: "demo.wait" });',
      async (_ref, _args, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              hostCallAborted = true;
              reject(new Error("host call aborted"));
            },
            { once: true },
          );
        }),
      { ...options, timeoutMs: 50 },
    );
    expect(result.error).toContain("timed out");
    expect(hostCallAborted).toBe(true);
  });

  it("interrupts synchronous infinite loops", async () => {
    const result = await new QuickJsRuntime().execute("while (true) {}", async () => undefined, {
      ...options,
      timeoutMs: 50,
    });
    expect(result.error).toBeDefined();
  });

  it("exposes named strings via π and throws a clear error for unprovided keys", async () => {
    const provided = await new QuickJsRuntime().execute(
      `return { value: π.content, keys: Object.keys(π).join(",") };`,
      async () => undefined,
      { ...options, strings: { content: "hello" } },
    );
    expect(provided.error).toBeUndefined();
    expect(provided.value).toEqual({ value: "hello", keys: "content" });

    const failed = await new QuickJsRuntime().execute(
      `return π.previewFile;`,
      async () => undefined,
      { ...options, strings: { content: "hello" } },
    );
    expect(failed.error).toContain("π.previewFile is not defined");
    expect(failed.error).toContain("provided: content");
  });
});
