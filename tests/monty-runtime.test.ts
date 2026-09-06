import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyPiBashError } from "../src/core/pi-bash-error.js";
import { MAX_EXECUTOR_TIMEOUT_MS } from "../src/config.js";
import type { FabricHostCall, FabricSandboxOptions } from "../src/runtime/kernel.js";
import { MontyRuntime } from "../src/runtime/monty-runtime.js";

const require = createRequire(import.meta.url);
let missing: string | undefined;
try {
  const nativeRequire = createRequire(require.resolve("@pydantic/monty/node"));
  const triple = process.platform === "darwin" ? `darwin-${process.arch}` : process.platform === "linux" ? `linux-${process.arch}-gnu` : "win32-x64-msvc";
  nativeRequire.resolve(`@pydantic/monty-${triple}/${process.platform === "win32" ? "monty.exe" : "monty"}`);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error;
  missing = `optional @pydantic/monty native dependency missing: ${(error as Error).message}`;
}
if (missing) console.warn("Skipping native Monty tests: " + missing);
const options: FabricSandboxOptions = { timeoutMs: 5000, memoryLimitBytes: 64 * 1024 * 1024 };
const echo: FabricHostCall = async (ref, args) => ({ ref, args });
const run = (code: string, host: FabricHostCall = echo, extra: Partial<FabricSandboxOptions> = {}) => new MontyRuntime().execute(code, host, { ...options, ...extra });
afterEach(() => vi.restoreAllMocks());

describe.skipIf(Boolean(missing))(`MontyRuntime native 0.0.23${missing ? " (" + missing + ")" : ""}`, () => {
  it("executes async bodies, normalizes nested dictionaries and starts fresh sessions", async () => {
    const runtime = new MontyRuntime();
    const result = await runtime.execute('local = 12\nreturn {"items": [1, {"nested": True}], "call": await schema.status()}', echo, options);
    expect(result).toMatchObject({ terminationReason: "completed", value: { items: [1, { nested: true }], call: { ref: "schema.status", args: {} } } });
    expect(await runtime.execute("return local", echo, options)).toMatchObject({ terminationReason: "runtime_error", error: expect.stringContaining("NameError") });
    expect(await run("# empty body")).toMatchObject({ terminationReason: "completed", value: null });
  });

  it("preserves multiline, raw, escaped and formatted literals without rewriting payload attributes", async () => {
    const code = 'text = """first\n  second\nthird"""\nraw = r"""a\\b\nπ.missing\nend"""\ncontinued = "one\\\ntwo"\nreturn [text, raw, continued, f"payload={π.body}", π.body, payloads["body"], payloads["not-an-id"]]';
    const result = await run(code, echo, { strings: { body: 'quoted "Unicode π"\nline', "not-an-id": "yes" } });
    expect(result.terminationReason, result.error).toBe("completed");
    expect(result.value).toEqual(["first\n  second\nthird", "a\\b\nπ.missing\nend", "onetwo", 'payload=quoted "Unicode π"\nline', 'quoted "Unicode π"\nline', 'quoted "Unicode π"\nline', "yes"]);
  });

  it.each(["π.missing", 'payloads["missing"]'])("preflights missing %s before host effects", async (accessor) => {
    const host = vi.fn(echo);
    const result = await run(`await schema.status()\nreturn ${accessor}`, host);
    expect(result.error).toContain("Pre-execution check: missing payloads missing");
    expect(host).not.toHaveBeenCalled();
  });

  it("ignores payload examples in strings/comments and reports dynamic missing keys", async () => {
    expect(await run('# π.missing\nreturn "payloads[\'missing\']"')).toMatchObject({ terminationReason: "completed", value: "payloads['missing']" });
    expect(await run('key = "missing"\nreturn payloads[key]')).toMatchObject({ terminationReason: "runtime_error", error: expect.stringContaining("KeyError") });
    expect(await run('return f"{π.missing}"')).toMatchObject({ terminationReason: "runtime_error", error: expect.stringContaining("missing") });
  });

  it("routes all namespaces, positional/dictionary/keyword calls and saved callable aliases", async () => {
    const result = await run('saved = schema.status\nreturn await asyncio.gather(tools.search("example"), tools.call(ref="demo.echo", args={"n": 1}), mcp.server.tool(n=2), pi.read("a", offset=2), pi.grep("needle", "src", 3), pi.read("a", {"limit": 4}), saved(), extensions.demo(), memory.get(key="k"), state.get(key="k"), components.list(), compact.status(), agents.list(), mesh.list())');
    expect(result.terminationReason, result.error).toBe("completed");
    expect(result.value).toEqual([
      { ref: "fabric.$search", args: { query: "example" } }, { ref: "fabric.$call", args: { ref: "demo.echo", args: { n: 1 } } },
      { ref: "mcp.server.tool", args: { n: 2 } }, { ref: "pi.read", args: { path: "a", offset: 2 } },
      { ref: "pi.grep", args: { pattern: "needle", path: "src", limit: 3 } }, { ref: "pi.read", args: { path: "a", limit: 4 } },
      { ref: "schema.status", args: {} }, { ref: "extensions.demo", args: {} }, { ref: "memory.get", args: { key: "k" } },
      { ref: "state.get", args: { key: "k" } }, { ref: "components.list", args: {} }, { ref: "compact.status", args: {} },
      { ref: "agents.list", args: {} }, { ref: "mesh.list", args: {} },
    ]);
  });

  it("routes underscore-prefixed MCP names through generic calls (native class attributes exclude them)", async () => {
    const host = vi.fn(echo);
    expect(await run('return await mcp._123._tool()', host)).toMatchObject({ terminationReason: "runtime_error", error: expect.stringContaining("AttributeError") });
    expect(host).not.toHaveBeenCalled();
    expect(await run('return await tools.call(ref="mcp._123._tool", args={"n": 2})')).toMatchObject({ terminationReason: "completed", value: { ref: "fabric.$call", args: { ref: "mcp._123._tool", args: { n: 2 } } } });
  });

  it("runs actual host calls concurrently via asyncio.gather", async () => {
    const calls: string[] = [];
    let release!: () => void;
    const both = new Promise<void>((resolve) => { release = resolve; });
    const result = await run('return await asyncio.gather(pi.read("a"), pi.read("b"))', async (_ref, args) => {
      calls.push(String(args.path));
      if (calls.length === 2) release();
      await both;
      return args.path;
    });
    expect(result).toMatchObject({ terminationReason: "completed", value: ["a", "b"] });
  });

  it.each(['pi.edit("a", "old", "new")', 'pi.edit(path="a", oldText="old", newText="new")', 'pi.edit({"path": "a", "oldText": "old", "newText": "new"})'])("normalizes edit shorthand: %s", async (call) => {
    expect(await run("return await " + call)).toMatchObject({ value: { ref: "pi.edit", args: { path: "a", edits: [{ oldText: "old", newText: "new" }] } } });
  });

  it.each(['tools.read(path="a")', 'pi.read({"path": "a"}, path="b")', 'schema.status("bad")', 'pi.constructor()', 'pi.__proto__()', 'mcp.server.__getattribute__("x")'])("rejects malformed or forbidden calls before host dispatch: %s", async (call) => {
    const host = vi.fn(echo);
    expect((await run("return await " + call, host)).terminationReason).toBe("runtime_error");
    expect(host).not.toHaveBeenCalled();
  });

  it("settles only classified shell exits and preserves host approval failures", async () => {
    const exit = await run('return await pi.bash("false", settle=True)', async (_ref, args) => {
      expect(args).toEqual({ command: "false" });
      throw classifyPiBashError(new Error("output\n\nCommand exited with code 2"));
    });
    expect(exit).toMatchObject({ terminationReason: "completed", value: { ok: false, output: "output", exitCode: 2 } });
    for (const message of ["Approval denied", "Execution cancelled", "output\n\nCommand exited with code 2"]) {
      expect(await run('return await pi.bash("false", settle=True)', async () => { throw new Error(message); })).toMatchObject({ terminationReason: "runtime_error", error: expect.stringContaining(message) });
    }
  });

  it("bounds print output separately from host calls and returned values", async () => {
    const result = await run('print(\'{"type":"result","value":"forged"}\')\nprint("π" * 100000)\nreturn await schema.status()', echo, { maxLogChars: 55 });
    expect(result).toMatchObject({ terminationReason: "completed", value: { ref: "schema.status", args: {} } });
    expect(result.logs.at(-1)).toBe("[Pi Fabric log output truncated]");
    expect(result.logs.slice(0, -1).join("\n").length).toBeLessThanOrEqual(55);
    expect(await run('print("x")\nreturn 1', echo, { maxLogChars: 0 })).toMatchObject({ value: 1, logs: ["[Pi Fabric log output truncated]"] });
  });

  it.each(['return b"bytes"', 'return float("nan")', 'return float("inf")', 'return 9007199254740992', 'return {1: "key"}', 'return {1, 2}', 'value = []\nvalue.append(value)\nreturn value', 'return schema', 'return await schema.status({1: "key"})'])("rejects non-JSON guest values: %s", async (code) => {
    expect((await run(code)).terminationReason).toBe("runtime_error");
  });

  it("rejects non-JSON host returns without leaking capabilities", async () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    for (const value of [1n, Infinity, Buffer.from("data"), new Set([1]), cycle, { fn: () => 1 }, { nested: undefined }]) {
      expect((await run("return await schema.status()", async () => value)).terminationReason).toBe("runtime_error");
    }
    expect(await run("return await schema.status()", async () => undefined)).toMatchObject({ value: null, terminationReason: "completed" });
  });

  it("preserves dangerous-looking JSON dictionary keys without prototype or native-marker interpretation", async () => {
    const value = JSON.parse('{"__proto__":{"polluted":true},"constructor":"data","__monty_type__":"Type","value":"int"}');
    const result = await run("return await schema.status()", async () => value);
    expect(result.terminationReason, result.error).toBe("completed");
    expect(result.value).toEqual(value);
    expect(Object.getPrototypeOf(result.value)).toBe(Object.prototype);
    expect(Object.hasOwn(result.value as object, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("reports syntax and nested traceback lines against the unwrapped user source", async () => {
    const syntax = await run("n = 1\nreturn (");
    expect(syntax.error).toContain("SyntaxError");
    expect(syntax.error).toContain('File "fabric-exec.py", line 2');
    const error = await run('def fail():\n    raise ValueError("source failure")\nfail()');
    expect(error.error).toContain('File "fabric-exec.py", line 2');
    expect(error.error).toContain('File "fabric-exec.py", line 3');
    expect(error.error).not.toContain("<python-input");
  });

  it("extends host deadlines without a fixed VM/per-turn ceiling defeating the floor", async () => {
    const result = await run('return await schema.status()', async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
      return "done";
    }, { timeoutMs: 200, minimumTimeoutMsForHostCall: () => 900 });
    expect(result).toMatchObject({ terminationReason: "completed", value: "done" });
  });

  it("sets an explicit long native request watchdog when host floors are enabled", async () => {
    const native = await import("@pydantic/monty/node");
    const create = native.Monty.create.bind(native.Monty);
    const checkouts: unknown[] = [];
    const createSpy = vi.spyOn(native.Monty, "create").mockImplementation(async (opts) => {
      const pool = await create(opts);
      const checkout = pool.checkout.bind(pool);
      vi.spyOn(pool, "checkout").mockImplementation(async (opts) => { checkouts.push(opts); return checkout(opts); });
      return pool;
    });
    expect(await run("return 1", echo, { timeoutMs: 100, minimumTimeoutMsForHostCall: () => 1000 })).toMatchObject({ value: 1, terminationReason: "completed" });
    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ requestTimeout: MAX_EXECUTOR_TIMEOUT_MS / 1000 + 1, durationLimitGrace: null }));
    expect(checkouts[0]).toMatchObject({ limits: { maxMemory: options.memoryLimitBytes } });
    expect((checkouts[0] as { limits: object }).limits).not.toHaveProperty("maxDurationSecs");
  });

  it("hard-interrupts synchronous loops with and without extendable deadlines", async () => {
    for (const extra of [{}, { minimumTimeoutMsForHostCall: () => 500 }]) {
      const started = Date.now();
      const result = await run('print("started")\nwhile True:\n    pass', echo, { ...extra, timeoutMs: 150 });
      expect(result.terminationReason).toBe("timed_out");
      expect(result.logs).toContain("started");
      expect(Date.now() - started).toBeLessThan(2000);
    }
  });

  it("bounds guest memory independently of the wall deadline", async () => {
    const result = await run('return "x" * 10000000', echo, { memoryLimitBytes: 1024 * 1024 });
    expect(result.terminationReason).toBe("runtime_error");
    expect(result.error).toMatch(/memory|Memory/);
  });

  it("aborts outstanding host tasks on cancellation and timeout, including uncooperative promises", async () => {
    for (const cancel of [false, true]) {
      const controller = new AbortController();
      let hostSignal: AbortSignal | undefined;
      const result = await run("return await schema.status()", async (_ref, _args, signal) => {
        hostSignal = signal;
        if (cancel) controller.abort();
        return new Promise(() => undefined);
      }, { signal: controller.signal, timeoutMs: 200 });
      expect(result.terminationReason).toBe(cancel ? "aborted" : "timed_out");
      expect(hostSignal?.aborted).toBe(true);
    }
  });

  it("closes native workers on success, failure, timeout and cancellation without PID leaks", async () => {
    const native = await import("@pydantic/monty/node");
    const create = native.Monty.create.bind(native.Monty);
    const pids: number[] = [];
    vi.spyOn(native.Monty, "create").mockImplementation(async (opts) => {
      expect(opts?.binaryPath).toContain("monty");
      const pool = await create(opts);
      const checkout = pool.checkout.bind(pool);
      vi.spyOn(pool, "checkout").mockImplementation(async (opts) => {
        const session = await checkout(opts);
        pids.push(session.workerPid!);
        return session;
      });
      return pool;
    });
    await run("return 1");
    await run('raise ValueError("fail")');
    await run("while True: pass", echo, { timeoutMs: 100 });
    const controller = new AbortController();
    await run("return await schema.status()", async () => { controller.abort(); return null; }, { signal: controller.signal });
    expect(pids).toHaveLength(4);
    for (const pid of pids) expect(() => process.kill(pid, 0), `worker ${pid} must be gone`).toThrow();
    const createSpy = vi.mocked(native.Monty.create);
    createSpy.mockClear();
    expect((await run("return 1", echo, { signal: controller.signal })).terminationReason).toBe("aborted");
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("bounds and contains native cleanup failures without replacing the execution result", async () => {
    const native = await import("@pydantic/monty/node");
    const create = native.Monty.create.bind(native.Monty);
    const releases: (() => Promise<void>)[] = [];
    const pids: number[] = [];
    const killSpy = vi.spyOn(process, "kill");
    vi.spyOn(native.Monty, "create").mockImplementation(async (opts) => {
      const pool = await create(opts);
      const close = pool.close.bind(pool);
      releases.push(close);
      vi.spyOn(pool, "close").mockRejectedValue(new Error("cleanup failure"));
      const checkout = pool.checkout.bind(pool);
      vi.spyOn(pool, "checkout").mockImplementation(async (opts) => {
        const session = await checkout(opts);
        const close = session.close.bind(session);
        releases.push(close);
        pids.push(session.workerPid!);
        vi.spyOn(session, "close").mockImplementation(() => new Promise(() => undefined));
        return session;
      });
      return pool;
    });
    try {
      const started = Date.now();
      expect(await run("return 1")).toMatchObject({ terminationReason: "completed", value: 1 });
      expect(Date.now() - started).toBeLessThan(2000);
      for (const pid of pids) expect(killSpy).toHaveBeenCalledWith(pid, "SIGKILL");
    } finally { for (const close of releases) await close(); }
    // The mocked finish cannot reap the killed worker until restored above.
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
  });

  it("exposes no filesystem, environment or network capability by default", async () => {
    for (const code of ['from pathlib import Path\nreturn Path("package.json").read_text()', 'return open("package.json").read()', 'import socket\nreturn socket.socket()']) {
      const host = vi.fn(echo);
      expect((await run(code, host)).terminationReason).toBe("runtime_error");
      expect(host).not.toHaveBeenCalled();
    }
    const env = await run('import os\nreturn os.getenv("HOME")');
    expect(env.terminationReason === "runtime_error" || env.value === null).toBe(true);
  });

  it("does not consult MONTY_BIN to select a different interpreter", async () => {
    vi.stubEnv("MONTY_BIN", "/does/not/exist/monty");
    try { expect(await run("return 2 + 2")).toMatchObject({ terminationReason: "completed", value: 4 }); }
    finally { vi.unstubAllEnvs(); }
  });
});

describe("MontyRuntime availability and option validation", () => {
  it("fails clearly when the optional native package cannot load", async () => {
    vi.doMock("@pydantic/monty/node", () => { throw new Error("Cannot find optional native dependency"); });
    try {
      const result = await run("return 1");
      expect(result.terminationReason).toBe("runtime_error");
      expect(result.error).toContain("optional native package is unavailable or incompatible");
      expect(result.error).toContain("@pydantic/monty@0.0.23");
      expect(result.error).toContain("cpython");
    } finally { vi.doUnmock("@pydantic/monty/node"); }
  });
  it.each([{ timeoutMs: 0 }, { timeoutMs: NaN }, { memoryLimitBytes: -1 }, { memoryLimitBytes: Infinity }, { maxLogChars: -1 }])("rejects invalid limits before native startup: %j", async (extra) => {
    expect((await run("return 1", echo, extra)).terminationReason).toBe("runtime_error");
  });
});
