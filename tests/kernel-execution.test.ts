import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { availablePythonBackends, pythonBackends } from "./fixtures/python-backends.js";
import { rmTempSync } from "./fixtures/temp-cleanup.js";
import { normalizeFabricConfig, type FabricPythonRuntime } from "../src/config.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { FabricExecutionService } from "../src/execution-service.js";
import { PiToolsProvider } from "../src/providers/pi-tools-provider.js";
import type { FabricActionDescriptor } from "../src/protocol.js";

const roots: string[] = [];
const registries: ActionRegistry[] = [];
afterEach(async () => {
  await Promise.all(registries.splice(0).map((registry) => registry.close()));
  for (const root of roots.splice(0)) rmTempSync(root);
});

const fixture = (pythonRuntime: FabricPythonRuntime) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-python-service-"));
  roots.push(cwd);
  const registry = new ActionRegistry();
  registries.push(registry);
  registry.register(new PiToolsProvider(cwd));
  const config = normalizeFabricConfig({ executor: { kernel: "python", ...(pythonRuntime === "cpython" ? { pythonRuntime } : { cpython: { binary: "/nonexistent/python3" } }), memoryLimitBytes: 256 * 1024 * 1024 } });
  const service = new FabricExecutionService(registry, config);
  let sequence = 0;
  const run = (code: string, strings?: Record<string, string>) => service.execute({
    code, ...(strings ? { strings } : {}), signal: undefined,
    parentToolCallId: `python-${++sequence}`,
    context: { cwd, hasUI: false, sessionManager: {
      getSessionId: () => "python-kernel-test", getSessionFile: () => undefined,
    } } as unknown as ExtensionContext,
    onPartial() {},
  });
  return { cwd, registry, config, service, run };
};

const registerEcho = (registry: ActionRegistry, name = "demo", action = "echo", risk: "read" | "agent" = "read") => {
  const invoke = vi.fn(async (_name: string, args: Record<string, unknown>) => ({ value: args.value }));
  const descriptor: FabricActionDescriptor = {
    name: action, description: "Echo a string", risk,
    inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
  };
  registry.register({ name, description: "fixture", async list() { return [descriptor]; }, async describe() { return descriptor; }, invoke });
  return invoke;
};

describe.each(pythonBackends)("%s Python kernel host integration", (pythonRuntime) => {
  const runTest = it.skipIf(!availablePythonBackends[pythonRuntime]);
  it.skipIf(!availablePythonBackends[pythonRuntime] || pythonRuntime !== "cpython")("runs CPython stdlib and payloads without consuming TypeScript declarations", async () => {
    const { registry, run } = fixture(pythonRuntime);
    const declarations = vi.spyOn(registry, "guestTypeSources");
    const result = await run('import json\nreturn {"sum": sum(json.loads(π.numbers)), "same": payloads["numbers"] == π.numbers}', { numbers: "[1,2,3]" });
    expect(result).toMatchObject({ success: true, value: { sum: 6, same: true }, audits: [] });
    expect(declarations).not.toHaveBeenCalled();
  });

  runTest("uses the configured Python backend with native payload dictionaries", async () => {
    const { registry, config, run } = fixture(pythonRuntime);
    const declarations = vi.spyOn(registry, "guestTypeSources");
    expect(config.executor.pythonRuntime).toBe(pythonRuntime);
    const result = await run('return {"sum": sum([1, 2, 3]), "same": payloads["numbers"] == π.numbers}', { numbers: "[1,2,3]" });
    expect(result).toMatchObject({ success: true, value: { sum: 6, same: true }, audits: [] });
    expect(declarations).not.toHaveBeenCalled();
  });

  runTest("routes core file operations through the audited registry", async () => {
    const { run, cwd } = fixture(pythonRuntime);
    const result = await run('written = await pi.write(path="example.txt", content=π.body)\ntext = await pi.read("example.txt")\nreturn {"ok": written["ok"], "text": text}', { body: "python bridge\n" });
    expect(result.success, result.error).toBe(true);
    expect(result.value).toEqual({ ok: true, text: "python bridge\n" });
    expect(result.audits.map((audit) => audit.ref)).toEqual(["pi.write", "pi.read"]);
    expect(result.trace.operations.map((operation) => operation.ref)).toEqual(["pi.write", "pi.read"]);
    expect(fs.readFileSync(path.join(cwd, "example.txt"), "utf8")).toBe("python bridge\n");
  });

  runTest("supports discovery and parallel calls while retaining schema validation", async () => {
    const { registry, run } = fixture(pythonRuntime);
    const invoke = registerEcho(registry);
    const success = await run('import asyncio\ndescriptor = await tools.describe(ref="demo.echo")\nvalues = await asyncio.gather(tools.call(ref="demo.echo", args={"value":"a"}), tools.call(ref="demo.echo", args={"value":"b"}))\nreturn {"ref": descriptor["ref"], "values": values}');
    expect(success.success, success.error).toBe(true);
    expect(success.value).toEqual({ ref: "demo.echo", values: [{ value: "a" }, { value: "b" }] });
    const failed = await run('return await tools.call(ref="demo.echo", args={"value": 123})');
    expect(failed.success).toBe(false);
    expect(failed.error).toContain("Invalid arguments");
    expect(failed.trace.operations[0]).toMatchObject({ ref: "demo.echo", failureStage: "validate" });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  runTest("enforces approvals and orchestration-only mode at the host boundary", async () => {
    const { registry, config, run } = fixture(pythonRuntime);
    const invoke = registerEcho(registry);
    config.approvals.read = "deny";
    expect((await run('return await tools.call(ref="demo.echo", args={"value":"blocked"})')).success).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
    config.approvals.read = "allow";
    config.fullCodeMode = false;
    const direct = await run('return await pi.read("example.txt")');
    const generic = await run('return await tools.call(ref="pi.read", args={"path":"example.txt"})');
    expect(direct.error).toContain("full code mode is disabled");
    expect(generic.error).toContain("full code mode is disabled");
    expect(direct.trace.operations[0]).toMatchObject({ ref: "pi.read", failureStage: "guard" });
  });

  runTest("preserves native shell result and settle contracts", async () => {
    const { run } = fixture(pythonRuntime);
    const result = await run('ok = await pi.bash(command="printf bridge")\nfailed = await pi.bash(command="printf failed; exit 3", settle=True)\nreturn {"output": ok["output"], "failed": failed["ok"], "exitCode": failed["exitCode"]}');
    expect(result.success, result.error).toBe(true);
    expect(result.value).toEqual({ output: "bridge", failed: false, exitCode: 3 });
  });

  runTest("repairs core aliases and numeric options for direct and generic calls", async () => {
    const { run, cwd } = fixture(pythonRuntime);
    const result = await run('await pi.write(file="notes.txt", text="alpha\\nbeta\\n")\nawait pi.edit(file_path="notes.txt", edits=[{"old_string":"beta", "new_string":"gamma"}])\ntext = await tools.call(ref="pi.READ", args={"file_path":"notes.txt", "start":"2", "max":"1"})\nshell = await pi.bash(cmd="printf repaired", timeoutMs="1500")\nfailed = await tools.call(ref="pi.bash", args={"cmd":"exit 7", "settle":True})\nreturn {"text":text, "shell":shell["output"], "failed":failed["ok"], "exit":failed["exitCode"]}');
    expect(result.success, result.error).toBe(true);
    expect(result.value).toMatchObject({ text: expect.stringContaining("gamma"), shell: "repaired", failed: false, exit: 7 });
    expect(fs.readFileSync(path.join(cwd, "notes.txt"), "utf8")).toBe("alpha\ngamma\n");
    expect(result.trace.operations.some((operation) => operation.ref === "pi.READ")).toBe(true);
  });

  runTest("refuses fuzzy action names before any tool executes", async () => {
    const { run } = fixture(pythonRuntime);
    const result = await run('return await tools.call(ref="pi.reed", args={"path":"never-executed.txt"})');
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown Fabric action: pi.reed");
    expect(result.error).toContain("pi.read");
    expect(result.trace.operations[0]?.failureStage).toBe("resolve");
  });

  runTest("preserves canonical values when aliases collide", async () => {
    const { run, cwd } = fixture(pythonRuntime);
    const result = await run('await pi.write(path="correct.txt", file="wrong.txt", content="canonical", text="alias")\nreturn await pi.read(file="correct.txt", limit=None)');
    expect(result.success, result.error).toBe(true);
    expect(result.value).toBe("canonical");
    expect(fs.existsSync(path.join(cwd, "wrong.txt"))).toBe(false);
  });

  runTest.each([
    'return await pi.write(path="blocked.txt", content="changed", unexpected="ignored?")',
    'return await pi.bash(command="touch blocked.txt", stdin="unsupported")',
    'return await pi.bash(command="touch blocked.txt", settle="true")',
    'return await tools.call(ref="pi.bash", args={"command":"touch blocked.txt", "settle":1})',
    'return await tools.call(ref="pi.write", args=[{"path":"blocked.txt", "content":"changed"}])',
    'return await pi.write({"path":"blocked.txt", "content":"changed", "__proto__":{"polluted":True}})',
  ])("rejects invalid/unknown arguments before effects: %s", async (code) => {
    const { run, cwd } = fixture(pythonRuntime);
    const result = await run(code);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/unexpected|stdin|dictionary|__proto__|additional properties|settle/i);
    expect(fs.existsSync(path.join(cwd, "blocked.txt"))).toBe(false);
  });

  runTest.each([false, true])("retains unknown nested edit keys for validation (all=%s)", async (all) => {
    const { run, cwd } = fixture(pythonRuntime);
    fs.writeFileSync(path.join(cwd, "notes.txt"), "original");
    const result = await run(`return await pi.edit(path="notes.txt", edits=[{"old":"original", "new":"changed", "surprise":True}], all=${all ? "True" : "False"})`);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/surprise|additional properties/i);
    expect(fs.readFileSync(path.join(cwd, "notes.txt"), "utf8")).toBe("original");
  });

  runTest("adds actionable Python advice to the final tool error", async () => {
    const { run } = fixture(pythonRuntime);
    const result = await run('result = await pi.bash(command="printf x")\nreturn result.output');
    expect(result.success).toBe(false);
    expect(result.error).toContain('File "fabric-exec.py", line 2');
    expect(result.error).toContain('result["output"]');
    expect(result.error!.split("Recovery hint:")).toHaveLength(2);
    expect(result.error).not.toMatch(/<string>|<python-input|in _main|_HostError/);
  });

  runTest("never settles denied generic shell calls", async () => {
    const { run, config, cwd } = fixture(pythonRuntime);
    config.approvals.execute = "deny";
    const result = await run('return await tools.call(ref="pi.bash", args={"cmd":"touch blocked.txt", "settle":True})');
    expect(result.success).toBe(false);
    expect(fs.existsSync(path.join(cwd, "blocked.txt"))).toBe(false);
  });

  runTest("enforces agent call budgets and refreshes kernels after configuration changes", async () => {
    const { registry, config, run } = fixture(pythonRuntime);
    const invoke = registerEcho(registry, "agents", "run", "agent");
    config.agents.maxPerExecution = 1;
    const result = await run('await agents.run(value="first")\nreturn await agents.run(value="second")');
    expect(result.success).toBe(false);
    expect(result.error).toContain("agent budget exhausted");
    expect(invoke).toHaveBeenCalledOnce();
    config.executor.kernel = "typescript";
    expect(await run("const n: number = 7; return n;")).toMatchObject({ success: true, value: 7 });
    config.executor.kernel = "python";
    expect(await run('return [n * n for n in range(3)]')).toMatchObject({ success: true, value: [0, 1, 4] });
    expect((await run("const n = 7; return n;")).success).toBe(false);
  });
});
