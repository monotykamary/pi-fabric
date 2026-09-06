import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agents/manager.js";
import type { AgentRunRequest, AgentRunResult } from "../src/agents/types.js";
import { ProcessTransport } from "../src/agents/transports/process-transport.js";
import { DEFAULT_FABRIC_CONFIG, type FabricPythonRuntime } from "../src/config.js";
import type { FabricKernel } from "../src/runtime/kernel.js";
import { parseWorkerOptions } from "../src/worker/options.js";
import { createRunningRecord, writeCrashRunRecord } from "../src/worker/run-record.js";

const roots: string[] = [];
const managers: AgentManager[] = [];
const temp = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-agent-kernel-"));
  roots.push(root);
  return root;
};
const createManager = (
  options: ConstructorParameters<typeof AgentManager>[2] = {},
  config = DEFAULT_FABRIC_CONFIG.agents,
) => {
  const manager = new AgentManager(process.cwd(), config, {
    runRoot: temp(),
    workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
    ...options,
  });
  managers.push(manager);
  return manager;
};

beforeEach(() => {
  for (const key of ["PI_FABRIC_DEPTH", "PI_FABRIC_BUDGET", "PI_FABRIC_BUDGET_FILE", "PI_FABRIC_BUDGET_ID", "PI_FABRIC_KERNEL", "PI_FABRIC_PYTHON_RUNTIME"]) {
    vi.stubEnv(key, undefined);
  }
});
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const argv = (overrides: Record<string, string> = {}) => [
  "node", "worker.js",
  ...Object.entries({
    id: "kernel-probe", name: "probe", runner: "pi", "task-file": "task.txt",
    "status-file": "status.json", "lifecycle-file": "lifecycle.jsonl", "log-file": "events.jsonl",
    cwd: process.cwd(), "pi-binary": "pi", "claude-binary": "claude", "veda-binary": "veda",
    "veda-backend": "agy", "veda-persona": "navigator-chat", "timeout-ms": "5000", depth: "1",
    "full-code-mode": "true", extensions: "true", tools: "[]", "granted-risks": "[]", transport: "process",
    ...overrides,
  }).flatMap(([key, value]) => [`--${key}`, value]),
];

describe("agent kernel resolution", () => {
  it("defaults to TypeScript independently of ambient child environment", () => {
    vi.stubEnv("PI_FABRIC_KERNEL", "python");
    vi.stubEnv("PI_FABRIC_PYTHON_RUNTIME", "monty");
    const manager = createManager();
    expect(manager.resolveKernel({})).toBe("typescript");
    expect(manager.resolveKernel({ kernel: "inherit" })).toBe("typescript");
    expect(manager.resolvePythonRuntime()).toBe("monty");
  });

  it("inherits live caller configuration and permits an explicit language override", () => {
    let language: FabricKernel = "python";
    const manager = createManager({ kernel: () => language });
    expect(manager.resolveKernel({})).toBe("python");
    expect(manager.resolveKernel({ kernel: "inherit" })).toBe("python");
    expect(manager.resolveKernel({ kernel: "typescript" })).toBe("typescript");
    language = "typescript";
    expect(manager.resolveKernel({})).toBe("typescript");
    expect(manager.resolveKernel({ kernel: "python" })).toBe("python");
  });

  it.each(["ruby", "PYTHON", "", null, false, 4, {}, []])("rejects invalid runtime request %j before launch", async (kernel) => {
    const preparePiModel = vi.fn(async () => {});
    const manager = createManager({ preparePiModel });
    await expect(manager.spawn({ task: "invalid", kernel } as AgentRunRequest)).rejects.toThrow("Invalid Fabric agent kernel");
    expect(preparePiModel).not.toHaveBeenCalled();
    expect(manager.list()).toEqual([]);
  });

  it.each([
    { runner: "claude" as const }, { runner: "veda" as const }, { extensions: false },
  ])("does not assign a Fabric kernel to incompatible runner %j", async (request) => {
    const manager = createManager({ kernel: () => "python" });
    expect(manager.resolveKernel(request)).toBeUndefined();
    expect(manager.resolveKernel({ ...request, kernel: "inherit" })).toBeUndefined();
    for (const kernel of ["typescript", "python"] as const) {
      await expect(manager.spawn({ task: "invalid", ...request, kernel })).rejects.toThrow("Pi runner with Fabric extensions");
    }
  });

  it("uses configured runner/extensions defaults and rejects broken callback values", () => {
    const manager = createManager({}, { ...DEFAULT_FABRIC_CONFIG.agents, runner: "claude" });
    expect(manager.resolveKernel({})).toBeUndefined();
    expect(manager.resolveKernel({ runner: "pi", kernel: "python" })).toBe("python");
    const disabled = createManager({}, { ...DEFAULT_FABRIC_CONFIG.agents, extensions: false });
    expect(disabled.resolveKernel({})).toBeUndefined();
    expect(() => disabled.resolveKernel({ kernel: "python" })).toThrow("Fabric extensions");
    expect(disabled.resolveKernel({ extensions: true, kernel: "python" })).toBe("python");
    const broken = createManager({ kernel: () => "auto" as FabricKernel, pythonRuntime: () => "auto" as FabricPythonRuntime });
    expect(() => broken.resolveKernel({})).toThrow("Invalid inherited");
    expect(() => broken.resolvePythonRuntime()).toThrow("Invalid inherited");
  });

  it("freezes language and backend before async preparation and reports it through status", async () => {
    let language: FabricKernel = "python";
    let backend: FabricPythonRuntime = "monty";
    const launch = vi.spyOn(ProcessTransport.prototype, "launch");
    const manager = createManager({
      kernel: () => language,
      pythonRuntime: () => backend,
      preparePiModel: async () => { language = "typescript"; backend = "cpython"; },
    });
    const handle = await manager.spawn({ task: "freeze", transport: "process", kernel: "inherit" });
    expect(handle.kernel).toBe("python");
    const options = parseWorkerOptions(["node", "worker.js", ...launch.mock.calls[0]![0].workerArguments]);
    expect(options).toMatchObject({ kernel: "python", pythonRuntime: "monty" });
    const result = await manager.wait(handle.id);
    expect(result).toMatchObject({ status: "completed", kernel: "python" });
    expect(manager.status(handle.id).kernel).toBe("python");
  });

  it("recursive children inherit Python even when ordinary extensions default off", async () => {
    const manager = createManager({ kernel: () => "python" }, { ...DEFAULT_FABRIC_CONFIG.agents, extensions: false });
    const result = await manager.run({ task: "recursive", recursive: true, transport: "process" });
    expect(result.kernel).toBe("python");
    await expect(manager.spawn({ task: "contradictory", recursive: true, extensions: false, kernel: "python" })).rejects.toThrow("Recursive Fabric requires extensions");
  });

  it.each(["typescript", "python"] as const)("explicit %s loads Fabric even outside full-code mode", async (kernel) => {
    const launch = vi.spyOn(ProcessTransport.prototype, "launch");
    const manager = createManager({ fullCodeMode: false });
    const result = await manager.run({ task: "language", transport: "process", kernel });
    expect(result.kernel).toBe(kernel);
    const options = parseWorkerOptions(["node", "worker.js", ...launch.mock.calls[0]![0].workerArguments]);
    expect(options.fabricExtensionPath).toContain("index");
    expect(options.tools).toContain("fabric_exec");
    expect(options.fullCodeMode).toBe(false);
  });
});

describe("worker kernel contract", () => {
  it("defaults old worker argv to TypeScript/Monty, not ambient selectors", () => {
    vi.stubEnv("PI_FABRIC_KERNEL", "python");
    vi.stubEnv("PI_FABRIC_PYTHON_RUNTIME", "monty");
    expect(parseWorkerOptions(argv())).toMatchObject({ kernel: "typescript", pythonRuntime: "monty" });
    expect(parseWorkerOptions(argv({ "python-runtime": "cpython" })).pythonRuntime).toBe("cpython");
  });

  it.each(["inherit", "Python", "ruby", ""])("rejects unresolved or invalid worker kernel %j", (kernel) => {
    expect(() => parseWorkerOptions(argv({ kernel }))).toThrow("Invalid worker kernel");
  });

  it.each(["inherit", "CPython", "native", ""])("rejects invalid Python backend %j", (runtime) => {
    expect(() => parseWorkerOptions(argv({ "python-runtime": runtime }))).toThrow("Invalid worker Python runtime");
  });

  it.each([{ runner: "claude" }, { runner: "veda" }, { extensions: "false" }])("rejects explicit worker kernel for %j", (request) => {
    expect(parseWorkerOptions(argv(request)).kernel).toBeUndefined();
    expect(() => parseWorkerOptions(argv({ ...request, kernel: "python" }))).toThrow("Fabric extensions");
  });

  it("persists the resolved language in running and crash status files", () => {
    const options = parseWorkerOptions(argv({ kernel: "python", "python-runtime": "monty" }));
    const record = createRunningRecord(options, "task", undefined, 123);
    expect(record.kernel).toBe("python");
    const file = path.join(temp(), "status.json");
    writeCrashRunRecord(file, record, new Error("probe"));
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ kernel: "python", status: "failed" });
  });

  it.each([
    { kernel: "inherit" as const, recursive: true },
    { kernel: "typescript" as const, alternateCwd: true },
    { kernel: "python" as const, session: true },
    { extensions: false, alternateCwd: true },
  ])("runs the source worker with resolved child env and copied session paths: %j", async (request) => {
    const root = temp();
    const report = path.join(root, "env.json");
    const shim = path.join(root, "probe.mjs");
    fs.writeFileSync(shim, [
      "#!/usr/bin/env node",
      'import fs from "node:fs";',
      `fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({ kernel: process.env.PI_FABRIC_KERNEL, pythonRuntime: process.env.PI_FABRIC_PYTHON_RUNTIME, cwd: process.cwd(), argv: process.argv.slice(2) }));`,
      `await import(${JSON.stringify(pathToFileURL(path.resolve("tests/fixtures/fake-pi-launch-probe.mjs")).href)});`,
    ].join("\n"), { mode: 0o755 });
    vi.stubEnv("PI_FABRIC_KERNEL", "typescript");
    vi.stubEnv("PI_FABRIC_PYTHON_RUNTIME", "cpython");
    const manager = createManager({
      workerPath: path.resolve("src/worker.ts"), piBinary: shim,
      kernel: () => "python", pythonRuntime: () => "monty",
    });
    const sessionFile = path.join(root, "session.jsonl");
    const result: AgentRunResult = await manager.run({
      task: "probe", transport: "process",
      ...(request.kernel ? { kernel: request.kernel } : {}),
      ...(request.recursive ? { recursive: true } : {}),
      ...(request.extensions === false ? { extensions: false } : {}),
      ...(request.alternateCwd ? { cwd: root } : {}),
      ...(request.session ? { sessionFile } : {}),
    });
    expect(result.status, result.error).toBe("completed");
    const surface = JSON.parse(fs.readFileSync(report, "utf8"));
    const expectedKernel = request.extensions === false ? undefined : request.kernel === "typescript" ? "typescript" : "python";
    expect(surface.kernel).toBe(expectedKernel);
    expect(surface.pythonRuntime).toBe(expectedKernel ? "monty" : undefined);
    expect(result.kernel).toBe(expectedKernel);
    if (request.alternateCwd) expect(surface.cwd).toBe(fs.realpathSync(root));
    if (request.session) expect(surface.argv).toContain(sessionFile);
    expect(process.env.PI_FABRIC_KERNEL).toBe("typescript");
    expect(process.env.PI_FABRIC_PYTHON_RUNTIME).toBe("cpython");
  });
});
