import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadFabricConfig, loadFabricConfigForScope, normalizeFabricConfig, saveFabricConfig } from "../src/config.js";

const roots: string[] = [];
const location = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-agent-kernel-config-"));
  roots.push(root);
  return { cwd: path.join(root, "project"), agentDir: path.join(root, "agent"), projectTrusted: true };
};
beforeEach(() => {
  vi.stubEnv("PI_FABRIC_KERNEL", undefined);
  vi.stubEnv("PI_FABRIC_PYTHON_RUNTIME", undefined);
  vi.stubEnv("PI_FABRIC_COMPACTION_ENGINE", undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("inherited agent kernel config", () => {
  it.each(["typescript", "python"] as const)("applies inherited %s after disk merge without overwriting saved scopes", (kernel) => {
    const options = location();
    const diskKernel = kernel === "python" ? "typescript" : "python";
    saveFabricConfig({ ...options, scope: "global" }, { executor: { kernel: diskKernel, pythonRuntime: "cpython", cpython: { binary: "python3.12" } } });
    saveFabricConfig({ ...options, scope: "project" }, { executor: { kernel: diskKernel, pythonRuntime: "cpython", cpython: { binary: "/opt/python3" } } });
    vi.stubEnv("PI_FABRIC_KERNEL", kernel);
    vi.stubEnv("PI_FABRIC_PYTHON_RUNTIME", "monty");
    expect(loadFabricConfig(options).executor).toMatchObject({ kernel, pythonRuntime: "monty", cpython: { binary: "/opt/python3" } });
    for (const scope of ["global", "project"] as const) {
      expect(loadFabricConfigForScope(options, scope).executor).toMatchObject({ kernel: diskKernel, pythonRuntime: "cpython" });
    }
    const alternate = { ...options, cwd: path.join(options.cwd, "alternate"), projectTrusted: false };
    expect(loadFabricConfig(alternate).executor).toMatchObject({ kernel, pythonRuntime: "monty", cpython: { binary: "python3.12" } });
  });

  it("uses disk defaults when no inherited selector is present", () => {
    const options = location();
    saveFabricConfig({ ...options, scope: "global" }, { executor: { kernel: "python", pythonRuntime: "monty" } });
    expect(loadFabricConfig(options).executor).toMatchObject({ kernel: "python", pythonRuntime: "monty" });
    vi.stubEnv("PI_FABRIC_KERNEL", "typescript");
    vi.stubEnv("PI_FABRIC_PYTHON_RUNTIME", "cpython");
    expect(loadFabricConfig(options).executor).toMatchObject({ kernel: "typescript", pythonRuntime: "cpython" });
  });

  it.each(["inherit", "", "Python", "javascript", "python3", " python", "python; echo unsafe"])("fails closed on invalid inherited language %j", (kernel) => {
    const options = location();
    vi.stubEnv("PI_FABRIC_KERNEL", kernel);
    expect(() => loadFabricConfig(options)).toThrow("Invalid PI_FABRIC_KERNEL");
    expect(loadFabricConfigForScope(options, "global").executor.kernel).toBe("typescript");
  });

  it.each(["inherit", "", "CPython", "native", " monty"])("fails closed on invalid inherited backend %j", (runtime) => {
    const options = location();
    vi.stubEnv("PI_FABRIC_PYTHON_RUNTIME", runtime);
    expect(() => loadFabricConfig(options)).toThrow("Invalid PI_FABRIC_PYTHON_RUNTIME");
    expect(loadFabricConfigForScope(options, "global").executor.pythonRuntime).toBe("monty");
  });

  it.each([undefined, null, "", "native", "MONTY", false, 1, {}, []])("defaults malformed disk Python backend %j to Monty", (pythonRuntime) => {
    expect(normalizeFabricConfig({ executor: { pythonRuntime } }).executor.pythonRuntime).toBe("monty");
  });

  it.each(["cpython", "monty"] as const)("round-trips configured %s without selecting a different language", (pythonRuntime) => {
    expect(normalizeFabricConfig({ executor: { pythonRuntime } }).executor).toMatchObject({ kernel: "typescript", pythonRuntime });
    const options = location();
    saveFabricConfig(options, { executor: { kernel: "python", pythonRuntime } });
    expect(loadFabricConfig(options).executor).toMatchObject({ kernel: "python", pythonRuntime });
  });
});
