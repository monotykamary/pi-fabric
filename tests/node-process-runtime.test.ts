import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { BunProcessRuntime, NodeProcessRuntime } from "../src/runtime/node-process-runtime.js";

const options = {
  timeoutMs: 5_000,
  memoryLimitBytes: 128 * 1024 * 1024,
};

const hasBun = (() => {
  try {
    execFileSync("bun", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

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
  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -100])("rejects non-positive timeout %s without spawning", async (timeoutMs) => {
    const result = await new NodeProcessRuntime().execute(
      "return 1;",
      async () => undefined,
      { ...options, timeoutMs },
    );

    expect(result.terminationReason).toBe("runtime_error");
    expect(result.error).toBe("Process timeout must be positive");
  });


  it("normalizes the string shorthand for tools.search", async () => {
    const result = await new NodeProcessRuntime().execute(
      'return tools.search("fovea");',
      async (ref, args) => {
        expect(ref).toBe("fabric.$search");
        expect(args).toEqual({ query: "fovea" });
        return [{ ref: "extensions.fovea_focus" }];
      },
      options,
    );

    expect(result.error).toBeUndefined();
    expect(result.value).toEqual([{ ref: "extensions.fovea_focus" }]);
  });


  it("provides memory.walk callbacks in the process runtime", async () => {
    let calls = 0;
    const result = await new NodeProcessRuntime().execute(
      `
const texts = [];
const walk = await memory.walk({ session: "session", indices: [4] }, async (entry) => {
  await Promise.resolve();
  texts.push(entry.text + ":" + entry.parentId);
});
return { texts, walk };
`,
      async (ref) => {
        expect(ref).toBe("memory.expand");
        calls += 1;
        return {
          entries: [{
            index: 4,
            entryId: "e4",
            parentId: "e3",
            type: "message",
            role: "user",
            timestamp: 4,
            isError: false,
            text: "remember",
            textRange: { start: 0, end: 8, total: 8, complete: true },
          }],
          next: null,
        };
      },
      options,
    );

    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({
      texts: ["remember:e3"],
      walk: { visited: 1, stopped: false },
    });
    expect(calls).toBe(1);
  });

  it("extends the active deadline for a long host call", async () => {
    const result = await new NodeProcessRuntime().execute(
      'await tools.call({ ref: "pi.bash", args: { timeout: 1 } }); return "ok";',
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_250));
        return { output: "ok" };
      },
      {
        ...options,
        timeoutMs: 1_000,
        minimumTimeoutMsForHostCall(ref) {
          return ref === "fabric.$call" ? 3_000 : undefined;
        },
      },
    );

    expect(result.terminationReason).toBe("completed");
    expect(result.value).toBe("ok");
  });

  it("preserves named string payloads", async () => {
    const content = [
      "multiline",
      "` ${value} { braces }",
      "quotes: \" '",
      "nul:" + String.fromCharCode(0) + " end",
    ].join("\n");
    const result = await new NodeProcessRuntime().execute(
      "return π.content;",
      async () => undefined,
      { ...options, strings: { content } },
    );

    expect(result.error).toBeUndefined();
    expect(result.value).toBe(content);
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

  it("does not wait for a non-cooperative sibling host call after guest failure", async () => {
    const startedAt = Date.now();
    const result = await new NodeProcessRuntime().execute(
      `
await Promise.all([
  tools.call({ ref: "demo.never" }),
  Promise.reject(new Error("branch failed")),
]);
`,
      async () => new Promise(() => undefined),
      options,
    );

    expect(result.terminationReason).toBe("runtime_error");
    expect(result.error).toContain("branch failed");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("bounds non-cooperative fire-and-forget host calls", async () => {
    const startedAt = Date.now();
    const result = await new NodeProcessRuntime().execute(
      'void tools.call({ ref: "demo.never" }); return "done";',
      async () => new Promise(() => undefined),
      options,
    );

    expect(result.terminationReason).toBe("completed");
    expect(result.value).toBe("done");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
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

  it("surfaces unbounded recursion as a runtime error", async () => {
    const result = await new NodeProcessRuntime().execute(
      "function f() { return f() + 1; } f();",
      async () => undefined,
      options,
    );

    expect(result.terminationReason).toBe("runtime_error");
    expect(result.error).toContain("Maximum call stack size exceeded");
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

describe("NodeProcessRuntime guest stack remapping", () => {
  it("remaps child error frames to user code lines", async () => {
    const result = await new NodeProcessRuntime().execute(
      ["const before = 1;", "print(before);", 'throw new Error("boom");'].join("\n"),
      async () => undefined,
      { timeoutMs: 5_000, memoryLimitBytes: 128 * 1024 * 1024 },
    );

    expect(result.terminationReason).toBe("runtime_error");
    expect(result.error).toContain("guest code:3:");
    expect(result.error).toContain("boom");
  });
});

describe.skipIf(!hasBun)("BunProcessRuntime", () => {
  it("runs guest code in a disposable Bun process and bridges host calls", async () => {
    const result = await new BunProcessRuntime().execute(
      `
const models = await tools.models();
print("models", models.length);
return { models, process: typeof process };
`,
      async (ref) => ref === "fabric.$models" ? [{ id: "large-model" }] : undefined,
      options,
    );

    expect(result.error).toBeUndefined();
    expect(result.logs).toEqual(["models 1"]);
    expect(result.value).toEqual({
      models: [{ id: "large-model" }],
      process: "undefined",
    });
  });

  it("preserves named string payloads", async () => {
    const content = [
      "multiline",
      "` ${value} { braces }",
      "quotes: \" '",
      "nul:" + String.fromCharCode(0) + " end",
    ].join("\n");
    const result = await new BunProcessRuntime().execute(
      "return π.content;",
      async () => undefined,
      { ...options, strings: { content } },
    );

    expect(result.error).toBeUndefined();
    expect(result.value).toBe(content);
  });

  it("waits for issued host calls before completing", async () => {
    let settled = false;
    const result = await new BunProcessRuntime().execute(
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
    const result = await new BunProcessRuntime().execute(
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
    const result = await new BunProcessRuntime().execute(
      "await new Promise(() => {});",
      async () => undefined,
      { ...options, signal: controller.signal },
    );

    expect(result.terminationReason).toBe("aborted");
    expect(result.error).toBe("Execution cancelled");
  });

  it("surfaces guest errors as runtime errors", async () => {
    const result = await new BunProcessRuntime().execute(
      'throw new Error("bun boom");',
      async () => undefined,
      options,
    );

    expect(result.terminationReason).toBe("runtime_error");
    expect(result.error).toContain("bun boom");
  });
});
