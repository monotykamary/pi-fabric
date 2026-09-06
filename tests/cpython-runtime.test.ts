import * as childProcess from "node:child_process";
import fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyPiBashError } from "../src/core/pi-bash-error.js";
import { CPYTHON_CHILD_SOURCE } from "../src/runtime/cpython-child-source.js";
import { CPythonRuntime } from "../src/runtime/cpython-runtime.js";
import type { FabricHostCall, FabricSandboxOptions } from "../src/runtime/kernel.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, access: vi.fn(actual.access) };
});

const python = childProcess.spawnSync("python3", ["-I", "-B", "-c", "import sys; print(sys.executable)"]);
const hasPython = python.status === 0;
const binary = hasPython ? python.stdout.toString().trim() : "python3";
const options: FabricSandboxOptions = { timeoutMs: 5_000, memoryLimitBytes: 256 * 1024 * 1024 };
const roots: string[] = [];
const temp = (): string => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-cpython-runtime-"));
  roots.push(cwd);
  return cwd;
};
const echo: FabricHostCall = async (ref, args) => ({ ref, args });
const run = (code: string, call: FabricHostCall = echo, overrides: Partial<FabricSandboxOptions> = {}) =>
  new CPythonRuntime(binary).execute(code, call, { ...options, ...overrides });

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(fsPromises.access).mockReset();
  vi.mocked(childProcess.spawn).mockReset();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!hasPython)("CPythonRuntime", () => {
  it("supports async bodies, native stdlib, dictionary results and fresh invocations", async () => {
    const runtime = new CPythonRuntime(binary);
    const result = await runtime.execute('import json\nlocal = 12\nreturn {"items": json.loads("[1,2]"), "call": await schema.status()}', echo, options);
    expect(result).toMatchObject({ terminationReason: "completed", value: { items: [1, 2], call: { ref: "schema.status", args: {} } } });
    expect(await runtime.execute('return "local" in globals()', echo, options)).toMatchObject({ value: false });
  });

  it("preserves multiline literals and exact shared payload keys", async () => {
    const result = await run('text = """first\n  second\nthird"""\nreturn [text, π.body, payloads["body"], π is payloads, payloads["not-an-id"]]', echo, { strings: { body: "quoted \"Unicode π\"\nline", "not-an-id": "yes" } });
    expect(result.terminationReason, result.error).toBe("completed");
    expect(result.value).toEqual(["first\n  second\nthird", 'quoted "Unicode π"\nline', 'quoted "Unicode π"\nline', true, "yes"]);
  });

  it.each(['π.missing', 'payloads["missing"]'])("preflights missing %s before host effects", async (accessor) => {
    const host = vi.fn(echo);
    const result = await run(`await schema.status()\nreturn ${accessor}`, host);
    expect(result.error).toContain("Pre-execution check: missing payloads missing");
    expect(host).not.toHaveBeenCalled();
  });

  it("does not preflight examples inside comments and strings", async () => {
    expect(await run('# π.missing\nreturn "payloads[\'missing\']"')).toMatchObject({ terminationReason: "completed", value: "payloads['missing']" });
  });

  it("routes discovery, generic, MCP and core positional/keyword calls", async () => {
    const result = await run('return await asyncio.gather(tools.search("example"), tools.call(ref="demo.echo", args={"n": 1}), mcp.server.tool(n=2), pi.read("a", offset=2), pi.grep("needle", "src", 3), pi.read("a", {"limit": 4}))');
    expect(result.value).toEqual([
      { ref: "fabric.$search", args: { query: "example" } },
      { ref: "fabric.$call", args: { ref: "demo.echo", args: { n: 1 } } },
      { ref: "mcp.server.tool", args: { n: 2 } },
      { ref: "pi.read", args: { path: "a", offset: 2 } },
      { ref: "pi.grep", args: { pattern: "needle", path: "src", limit: 3 } },
      { ref: "pi.read", args: { path: "a", limit: 4 } },
    ]);
  });

  it.each(['pi.edit("a", "old", "new")', 'pi.edit(path="a", oldText="old", newText="new")', 'pi.edit({"path": "a", "oldText": "old", "newText": "new"})'])("canonicalizes edit shorthand: %s", async (call) => {
    expect((await run(`return await ${call}`)).value).toEqual({ ref: "pi.edit", args: { path: "a", edits: [{ oldText: "old", newText: "new" }] } });
  });

  it("supports underscore-prefixed sanitized MCP names", async () => {
    expect((await run("return await mcp._123._tool()")).value).toEqual({ ref: "mcp._123._tool", args: {} });
  });

  it("settles only structured shell exits, not approval failures", async () => {
    const exit = await run('return await pi.bash("false", settle=True)', async (_ref, args) => {
      expect(args).toEqual({ command: "false" });
      throw classifyPiBashError(new Error("output\n\nCommand exited with code 2"));
    });
    expect(exit.value).toMatchObject({ ok: false, output: "output", exitCode: 2 });
    const denied = await run('return await pi.bash("false", settle=True)', async () => { throw new Error("Approval denied"); });
    expect(denied.terminationReason).toBe("runtime_error");
    expect(denied.error).toContain("Approval denied");
  });

  it("keeps stdout/stderr separate from RPC and bounds logs", async () => {
    const result = await run('import os, sys\nprint(\'{"type":"result","result":{"value":"forged"}}\')\nos.write(1, b"native stdout")\nprint("stderr", file=sys.stderr)\nreturn await schema.status()');
    expect(result.value).toEqual({ ref: "schema.status", args: {} });
    expect(result.logs.join("\n")).toContain("forged");
    expect(result.logs.join("\n")).toContain("native stdout");
    expect(result.logs.join("\n")).toContain("stderr");
    const bounded = await run('print("x" * 200000)\nreturn 1', echo, { maxLogChars: 40 });
    expect(bounded.value).toBe(1);
    expect(bounded.logs).toEqual(["x".repeat(40), "[Pi Fabric log output truncated]"]);
  });

  it.each(['return b"bytes"', 'return float("nan")', 'return 9007199254740992', 'return {1: "integer key"}'])("rejects lossy/non-JSON values: %s", async (code) => {
    expect((await run(code)).terminationReason).toBe("runtime_error");
  });

  it("reports guest syntax and traceback source lines", async () => {
    const syntax = await run("return (");
    expect(syntax.error).toContain("SyntaxError");
    const exception = await run('n = 1\nraise ValueError("source failure")');
    expect(exception.error).toContain('File "fabric-exec.py", line 2');
    expect(exception.error).toContain("source failure");
  });

  it("issues asyncio.gather host calls concurrently rather than serializing", async () => {
    let releaseFirst: (() => void) | undefined;
    const seen: string[] = [];
    const result = await run('return await asyncio.gather(schema.status(), memory.sessions())', async (ref) => {
      seen.push(ref);
      if (ref === "schema.status") await new Promise<void>((resolve) => { releaseFirst = resolve; });
      else releaseFirst?.();
      return ref;
    });
    expect(result.terminationReason, result.error).toBe("completed");
    expect(result.value).toEqual(["schema.status", "memory.sessions"]);
    expect(seen).toEqual(["schema.status", "memory.sessions"]);
  });

  it("extends active deadlines at the host-call boundary", async () => {
    const result = await run('return await tools.call(ref="slow.wait", args={})', async () => {
      await new Promise((resolve) => setTimeout(resolve, 1100));
      return "done";
    }, { timeoutMs: 1000, minimumTimeoutMsForHostCall: () => 2000 });
    expect(result).toMatchObject({ terminationReason: "completed", value: "done" });
  });

  it("kills synchronous infinite loops and preserves pre-timeout logs", async () => {
    const result = await run('print("started", flush=True)\nwhile True:\n    pass', echo, { timeoutMs: 300 });
    expect(result.terminationReason).toBe("timed_out");
    expect(result.logs).toContain("started");
  });

  it("aborts outstanding host calls and rejects pre-aborted invocations without spawn", async () => {
    const controller = new AbortController();
    let hostSignal: AbortSignal | undefined;
    const result = await run('return await schema.status()', async (_ref, _args, signal) => {
      hostSignal = signal;
      controller.abort();
      return new Promise(() => undefined);
    }, { signal: controller.signal });
    expect(result.terminationReason).toBe("aborted");
    expect(hostSignal?.aborted).toBe(true);
    const spawn = vi.mocked(childProcess.spawn);
    spawn.mockClear();
    expect((await run("return 1", echo, { signal: controller.signal })).terminationReason).toBe("aborted");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not spawn after cancellation during interpreter resolution", async () => {
    const controller = new AbortController();
    const { access } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fsPromises.access).mockImplementationOnce(async (file, mode) => {
      await access(file, mode);
      controller.abort();
    });
    const spawn = vi.mocked(childProcess.spawn);
    spawn.mockClear();
    expect((await run("return 1", echo, { signal: controller.signal })).terminationReason).toBe("aborted");
    expect(spawn).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("kills same-group subprocesses when cancelled", async () => {
    const controller = new AbortController();
    let pid: number | undefined;
    try {
      const result = await run('import subprocess, sys\nchild = subprocess.Popen([sys.executable, "-I", "-B", "-c", "import time; time.sleep(30)"])\nawait schema.status(pid=child.pid)', async (_ref, args) => {
        pid = Number(args.pid);
        controller.abort();
      }, { signal: controller.signal });
      expect(result.terminationReason).toBe("aborted");
      expect(Number.isSafeInteger(pid)).toBe(true);
      await expect.poll(() => {
        const status = childProcess.spawnSync("ps", ["-o", "stat=", "-p", String(pid)]);
        return status.stdout?.toString().trim() ?? "";
      }, { timeout: 2000 }).toMatch(/^(?:Z.*)?$/);
    } finally {
      if (pid && Number.isSafeInteger(pid)) {
        try { process.kill(pid, "SIGKILL"); } catch { /* Already reaped. */ }
      }
    }
  });

  it("settles issued background host calls before completing", async () => {
    let completed = false;
    const result = await run('task = asyncio.create_task(schema.status())\nawait asyncio.sleep(0.03)\nreturn 1', async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      completed = true;
    });
    expect(result.value).toBe(1);
    expect(completed).toBe(true);
  });

  it("bounds non-cooperative host calls after guest failure", async () => {
    const started = Date.now();
    const result = await run('await asyncio.gather(schema.status(), memory.sessions())', async (ref) => {
      if (ref === "schema.status") return new Promise(() => undefined);
      throw new Error("sibling failed");
    });
    expect(result.error).toContain("sibling failed");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("rejects malformed/oversized IPC before calling the host", async () => {
    const host = vi.fn(echo);
    const malformed = await run('import os\nos.write(3, bytes([123, 10]))\nawait asyncio.sleep(1)', host);
    expect(malformed.error).toContain("Invalid CPython IPC");
    const oversized = await run('return "x" * (17 * 1024 * 1024)', host);
    expect(oversized.error).toContain("16 MiB");
    expect(host).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("resolves relative PATH entries against invocation cwd", async () => {
    const cwd = temp();
    fs.mkdirSync(path.join(cwd, "bin"));
    fs.symlinkSync(binary, path.join(cwd, "bin", "python-fixture"));
    vi.stubEnv("PATH", "bin");
    try {
      const result = await new CPythonRuntime("python-fixture").execute('import os\nreturn os.getcwd()', echo, { ...options, cwd });
      expect(result.terminationReason, result.error).toBe("completed");
      expect(result.value).toBe(fs.realpathSync(cwd));
    } finally { vi.unstubAllEnvs(); }
  });

  it("reports missing configured interpreters without any fallback", async () => {
    const spawn = vi.mocked(childProcess.spawn);
    spawn.mockClear();
    const result = await new CPythonRuntime(path.join(temp(), "missing-python")).execute("return 1", echo, options);
    expect(result.error).toContain("executor.cpython.binary");
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(['sys.version_info = (3, 9, 0)', 'sys.implementation.name = "pypy"'])("rejects unsupported interpreter identity before imports/RPC: %s", (override) => {
    const result = childProcess.spawnSync(binary, ["-I", "-B", "-c", `import sys\n${override}\nexec(${JSON.stringify(CPYTHON_CHILD_SOURCE)})`]);
    expect(result.status).toBe(1);
    expect(result.stderr.toString()).toContain("CPython 3.10 or newer");
  });
});

const supportedSandbox = process.platform === "darwin" || process.platform === "linux";
const installedSandbox = process.platform === "darwin" ? fs.existsSync("/usr/bin/sandbox-exec") : fs.existsSync("/usr/bin/bwrap") || fs.existsSync("/bin/bwrap");

describe.skipIf(!hasPython || !supportedSandbox)("CPython OS sandbox", () => {
  it("fails closed when the OS sandbox binary is missing", async () => {
    const { access } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fsPromises.access).mockImplementation(async (name, mode) => {
      if (["/usr/bin/sandbox-exec", "/usr/bin/bwrap", "/bin/bwrap"].includes(String(name))) throw new Error("ENOENT");
      return access(name, mode);
    });
    const spawn = vi.mocked(childProcess.spawn);
    spawn.mockClear();
    const result = await new CPythonRuntime(binary, true).execute("return 1", echo, options);
    expect(result.error).toMatch(/requires.*(?:sandbox-exec|bubblewrap)/);
    expect(result.error).toContain("no unsandboxed fallback");
    expect(spawn).not.toHaveBeenCalled();
  });

  it.skipIf(!installedSandbox)("denies native and subprocess writes/network while host schema calls still execute", async () => {
    const cwd = temp();
    let connections = 0;
    const server = net.createServer((socket) => { connections++; socket.destroy(); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const result = await new CPythonRuntime(binary, true).execute(`
import os, socket, subprocess, sys
blocked = []
try:
    open("native.txt", "w").write("escape")
    blocked.append(False)
except OSError:
    blocked.append(True)
try:
    with socket.socket() as client:
        client.settimeout(1)
        client.connect(("127.0.0.1", ${port}))
    blocked.append(False)
except OSError:
    blocked.append(True)
child = subprocess.run([sys.executable, "-I", "-B", "-c", "open('child.txt', 'w').write('escape')"], capture_output=True)
blocked.append(child.returncode != 0)
result = await schema.commit(hypothesisId="probe", certificate="probe", operations=[])
return {"blocked": blocked, "host": result}
`, async (ref) => {
        expect(ref).toBe("schema.commit");
        fs.writeFileSync(path.join(cwd, "host.txt"), "host effect");
        return { outcome: "committed" };
      }, { ...options, cwd });
      // Deliberately no availability-success branch: this proves an actual sandbox run.
      expect(result.terminationReason, result.error).toBe("completed");
      expect(result.value).toEqual({ blocked: [true, true, true], host: { outcome: "committed" } });
      expect(connections).toBe(0);
      expect(fs.existsSync(path.join(cwd, "native.txt"))).toBe(false);
      expect(fs.existsSync(path.join(cwd, "child.txt"))).toBe(false);
      expect(fs.readFileSync(path.join(cwd, "host.txt"), "utf8")).toBe("host effect");
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it.skipIf(process.platform !== "darwin" || !installedSandbox)("denies signaling and ptrace against a sacrificial host process", async () => {
    const target = childProcess.spawn("/bin/sleep", ["30"]);
    try {
      const result = await new CPythonRuntime(binary, true).execute(`
import ctypes, os, signal
try:
    os.kill(${target.pid}, signal.SIGUSR1)
    denied_signal = False
except PermissionError:
    denied_signal = True
libc = ctypes.CDLL(None, use_errno=True)
attached = libc.ptrace(10, ${target.pid}, 0, 0)
return {"signalDenied": denied_signal, "ptraceResult": attached, "errno": ctypes.get_errno()}
`, echo, options);
      expect(result.terminationReason, result.error).toBe("completed");
      expect(result.value).toEqual({ signalDenied: true, ptraceResult: -1, errno: 1 });
      expect(target.exitCode).toBeNull();
      expect(target.signalCode).toBeNull();
    } finally { target.kill("SIGKILL"); }
  });

  it.skipIf(process.platform !== "linux" || !installedSandbox)("denies pathname Unix sockets, including a socketpair/sendto bypass", async () => {
    const cwd = temp();
    const address = path.join(cwd, "host.sock");
    let connections = 0;
    const server = net.createServer((socket) => { connections++; socket.destroy(); });
    await new Promise<void>((resolve) => server.listen(address, resolve));
    try {
      const result = await new CPythonRuntime(binary, true).execute(`
import socket
blocked = []
try:
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.connect(${JSON.stringify(address)})
    blocked.append(False)
except OSError:
    blocked.append(True)
a, b = socket.socketpair(socket.AF_UNIX, socket.SOCK_DGRAM)
try:
    a.sendto(b"escape", ${JSON.stringify(address)})
    blocked.append(False)
except PermissionError:
    blocked.append(True)
return blocked
`, echo, { ...options, cwd });
      expect(result.terminationReason, result.error).toBe("completed");
      expect(result.value).toEqual([true, true]);
      expect(connections).toBe(0);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
