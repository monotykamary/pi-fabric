import { describe, expect, it, vi } from "vitest";
import { QuickJsRuntime } from "../src/runtime/quickjs-runtime.js";

const options = {
  timeoutMs: 5_000,
  memoryLimitBytes: 32 * 1024 * 1024,
};

describe("QuickJsRuntime", () => {
  it("rejects memory limits that overflow the WASM32 size_t", async () => {
    const result = await new QuickJsRuntime().execute(
      "return 1;",
      async () => undefined,
      { ...options, memoryLimitBytes: 4 * 1024 ** 3 },
    );

    expect(result.terminationReason).toBe("runtime_error");
    expect(result.error).toContain("WASM32 maximum");
  });

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
        if (ref === "fabric.$spanStart" || ref === "fabric.$spanEnd") return undefined;
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

  it("includes the workflow label and child cause in agent failures", async () => {
    const result = await new QuickJsRuntime().execute(
      'return agent("review", { label: "dashboard reviewer" });',
      async (ref) => {
        if (ref === "agents.run") {
          return {
            status: "failed",
            error: "openai-codex/gpt-test: fetch failed · WebSocket error",
            usage: { input: 0, output: 0 },
          };
        }
        throw new Error(`Unexpected call: ${ref}`);
      },
      options,
    );
    expect(result.error).toContain(
      "dashboard reviewer failed: openai-codex/gpt-test: fetch failed · WebSocket error",
    );
  });

  it("runs parallel(items, mapper, concurrency) fan-out", async () => {
    const calls: string[] = [];
    const result = await new QuickJsRuntime().execute(
      `
const items = [{ q: "first" }, { q: "second" }, { q: "third" }];
const out = await parallel(items, (item) => agent(item.q, { label: item.q }), 2);
return out;
`,
      async (ref, args) => {
        if (ref === "fabric.$spanStart" || ref === "fabric.$spanEnd") return undefined;
        if (ref === "agents.run") {
          calls.push(String(args.task));
          return { status: "completed", text: String(args.task).toUpperCase(), usage: { input: 1, output: 1 } };
        }
        throw new Error(`Unexpected call: ${ref}`);
      },
      { ...options, tokenBudget: 30 },
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual(["FIRST", "SECOND", "THIRD"]);
    expect(calls.sort()).toEqual(["first", "second", "third"]);
  });

  it("emits deterministic internal workflow span start/end calls from guest combinators", async () => {
    const calls: Array<{ ref: string; args: Record<string, unknown> }> = [];
    const result = await new QuickJsRuntime().execute(
      `
await workflow.parallel([], { concurrency: 9 });
await workflow.pipeline([1], (value) => value);
return {
  globalBridge: typeof globalThis.__fabricHostCall,
  lexicalBridge: typeof __fabricBridge,
  internalCall: typeof __call,
};
`,
      async (ref, args) => {
        calls.push({ ref, args });
        return undefined;
      },
      options,
    );

    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({
      globalBridge: "undefined",
      lexicalBridge: "undefined",
      internalCall: "undefined",
    });
    expect(calls).toEqual([
      { ref: "fabric.$spanStart", args: { id: "span-0", kind: "parallel", itemCount: 0, concurrency: 0 } },
      { ref: "fabric.$spanEnd", args: { id: "span-0", outcome: "succeeded" } },
      { ref: "fabric.$spanStart", args: { id: "span-1", kind: "pipeline", itemCount: 1, stageCount: 1 } },
      { ref: "fabric.$spanStart", args: { id: "span-2", kind: "parallel", itemCount: 1, concurrency: 1 } },
      { ref: "fabric.$spanEnd", args: { id: "span-2", outcome: "succeeded" } },
      { ref: "fabric.$spanEnd", args: { id: "span-1", outcome: "succeeded" } },
    ]);
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

  it("routes stable Fabric providers through first-class proxies", async () => {
    const calls: Array<{ ref: string; args: Record<string, unknown> }> = [];
    const result = await new QuickJsRuntime().execute(
      `
return Promise.all([
  memory.recall({ query: "needle" }),
  state.history({ limit: 2 }),
  schema.status(),
  compact.request({ reason: "context pressure" }),
]);
`,
      async (ref, args) => {
        calls.push({ ref, args });
        return { ref };
      },
      options,
    );

    expect(result.error).toBeUndefined();
    expect(calls).toEqual([
      { ref: "memory.recall", args: { query: "needle" } },
      { ref: "state.history", args: { limit: 2 } },
      { ref: "schema.status", args: {} },
      { ref: "compact.request", args: { reason: "context pressure" } },
    ]);
  });

  it("routes JavaScript-safe MCP aliases through the direct MCP proxy", async () => {
    const result = await new QuickJsRuntime().execute(
      'return mcp.fal_ai.get_model_schema({ endpoint_id: "openai/gpt-image-2" });',
      async (ref, args) => ({ ref, args }),
      options,
    );

    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({
      ref: "mcp.fal_ai.get_model_schema",
      args: { endpoint_id: "openai/gpt-image-2" },
    });
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

  it("waits for host calls without spinning the Node event loop", async () => {
    const immediate = vi.spyOn(globalThis, "setImmediate");
    try {
      const result = await new QuickJsRuntime().execute(
        'return tools.call({ ref: "demo.wait" });',
        async () => new Promise((resolve) => setTimeout(() => resolve("done"), 40)),
        options,
      );
      expect(result.value).toBe("done");
      expect(immediate).not.toHaveBeenCalled();
    } finally {
      immediate.mockRestore();
    }
  });

  it("resumes guest timers through event-driven job pumping", async () => {
    const result = await new QuickJsRuntime().execute(
      'return new Promise((resolve) => setTimeout(() => resolve("timer done"), 20));',
      async () => undefined,
      options,
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toBe("timer done");
  });

  it("times out unresolved guest promises", async () => {
    const startedAt = Date.now();
    const result = await new QuickJsRuntime().execute(
      "await new Promise(() => {});",
      async () => undefined,
      { ...options, timeoutMs: 50 },
    );
    expect(result.error).toContain("timed out");
    expect(result.terminationReason).toBe("timed_out");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("classifies timeout and abort words in thrown runtime errors as runtime failures", async () => {
    for (const message of ["business timeout was rejected", "operation was aborted upstream"]) {
      const result = await new QuickJsRuntime().execute(
        `throw new Error(${JSON.stringify(message)});`,
        async () => undefined,
        options,
      );
      expect(result.error).toContain(message);
      expect(result.terminationReason).toBe("runtime_error");
    }
  });

  it("returns a typed aborted termination for an external signal", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    const result = await new QuickJsRuntime().execute(
      "return 1;",
      async () => undefined,
      { ...options, signal: controller.signal },
    );
    expect(result.terminationReason).toBe("aborted");
  });

  it("extends the active deadline before a blocking host call runs", async () => {
    const result = await new QuickJsRuntime().execute(
      `
const ref = ["agents", "run"].join(".");
return tools.call({ ref, args: { task: "slow" } });
`,
      async () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ status: "completed", text: "ok" }), 150);
        }),
      {
        ...options,
        timeoutMs: 50,
        minimumTimeoutMsForHostCall(ref, args) {
          return ref === "fabric.$call" && args.ref === "agents.run" ? 1_000 : undefined;
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toMatchObject({ status: "completed", text: "ok" });
  });

  it("extends a late blocking host call from the call start", async () => {
    const result = await new QuickJsRuntime().execute(
      `
await tools.call({ ref: "demo.delay" });
return tools.call({ ref: "agents.run", args: { task: "late" } });
`,
      async () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ status: "completed" }), 70);
        }),
      {
        ...options,
        timeoutMs: 100,
        minimumTimeoutMsForHostCall(ref) {
          return ref === "fabric.$call" ? 100 : undefined;
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toMatchObject({ status: "completed" });
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
    expect(result.error).toContain("Execution timed out after 50ms");
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

  it("bridges tools.models() to the fabric.$models host call", async () => {
    const result = await new QuickJsRuntime().execute(
      `const models = await tools.models(); return models;`,
      async (ref) => {
        if (ref === "fabric.$models") {
          return [
            { provider: "litellm", id: "glm-5.2", name: "GLM 5.2", key: "litellm/glm-5.2" },
          ];
        }
        throw new Error(`Unexpected call: ${ref}`);
      },
      options,
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual([
      { provider: "litellm", id: "glm-5.2", name: "GLM 5.2", key: "litellm/glm-5.2" },
    ]);
  });

  it("bridges agents.models() to the runner-aware provider action", async () => {
    let request: Record<string, unknown> | undefined;
    const result = await new QuickJsRuntime().execute(
      `return agents.models({ runner: "claude", refresh: true });`,
      async (ref, args) => {
        if (ref === "agents.models") {
          request = args;
          return [{ runner: "claude", provider: "claude", id: "haiku", name: "Haiku", key: "claude/haiku" }];
        }
        throw new Error(`Unexpected call: ${ref}`);
      },
      options,
    );
    expect(result.error).toBeUndefined();
    expect(request).toEqual({ runner: "claude", refresh: true });
    expect(result.value).toEqual([
      { runner: "claude", provider: "claude", id: "haiku", name: "Haiku", key: "claude/haiku" },
    ]);
  });

  it("counts council.run role usage toward budget.spent()", async () => {
    const result = await new QuickJsRuntime().execute(
      `await council.run({ task: "review", roles: ["a", "b"], synthesize: false }); return budget.spent();`,
      async (ref, args) => {
        if (ref === "agents.run") {
          return { status: "completed", text: String(args.name), usage: { input: 10, output: 5 } };
        }
        throw new Error(`Unexpected call: ${ref}`);
      },
      { ...options, tokenBudget: 100 },
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toBe(30);
  });

  it("counts rlm.query usage and forces the Pi runner", async () => {
    let request: Record<string, unknown> | undefined;
    const result = await new QuickJsRuntime().execute(
      `await rlm.query({ task: "map" }); return budget.spent();`,
      async (ref, args) => {
        if (ref === "agents.run") {
          request = args;
          return { status: "completed", text: "done", usage: { input: 7, output: 3 } };
        }
        throw new Error(`Unexpected call: ${ref}`);
      },
      { ...options, tokenBudget: 100 },
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toBe(10);
    expect(request).toMatchObject({ task: "map", runner: "pi", recursive: true });
  });

  it("preempts the council synthesizer when roles exhaust the token budget", async () => {
    const calls: string[] = [];
    const result = await new QuickJsRuntime().execute(
      `await council.run({ task: "review", roles: ["a", "b"] }); return "done";`,
      async (ref, args) => {
        if (ref === "agents.run") {
          calls.push(String(args.name));
          return { status: "completed", text: "x", usage: { input: 100, output: 50 } };
        }
        throw new Error(`Unexpected call: ${ref}`);
      },
      { ...options, tokenBudget: 20 },
    );
    expect(result.error).toContain("token budget exhausted");
    expect(calls).toEqual(["a", "b"]);
  });

  it("routes agents.main and Main steering through the agents provider", async () => {
    const calls: string[] = [];
    const result = await new QuickJsRuntime().execute(
      `
const main = await agents.main();
const queued = await agents.steer({ id: main.id, message: "focus" });
return { main, queued };
`,
      async (ref) => {
        calls.push(ref);
        if (ref === "agents.main") {
          return { id: "session:root", name: "Main", kind: "main", status: "idle" };
        }
        if (ref === "agents.steer") {
          return { queued: true, messageId: "m1", routed: "main" };
        }
        throw new Error(`Unexpected call: ${ref}`);
      },
      options,
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toMatchObject({
      main: { id: "session:root", name: "Main" },
      queued: { queued: true, routed: "main" },
    });
    expect(calls).toEqual(["agents.main", "agents.steer"]);
  });

  it("routes agents.setEvents and agents.setInstructions to the actors provider", async () => {
    const calls: string[] = [];
    const result = await new QuickJsRuntime().execute(
      `
await agents.setEvents({ id: "a1", events: ["turn_end"] });
await agents.setInstructions({ id: "a1", instructions: "Be brief." });
return { done: true };
`,
      async (ref, args) => {
        calls.push(ref);
        if (ref === "agents.setEvents") return { id: args.id, status: "idle", name: "x" };
        if (ref === "agents.setInstructions") return { id: args.id, status: "idle", name: "x" };
        throw new Error(`Unexpected call: ${ref}`);
      },
      options,
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({ done: true });
    expect(calls).toEqual(["agents.setEvents", "agents.setInstructions"]);
  });
});
