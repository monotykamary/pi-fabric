import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_FABRIC_CONFIG,
  MAX_EXECUTOR_MEMORY_LIMIT_BYTES,
  QUICKJS_MAX_MEMORY_LIMIT_BYTES,
  loadFabricConfigForScope,
  maxExecutorMemoryLimitBytes,
  normalizeFabricConfig,
  saveFabricConfig,
} from "../src/config.js";
import type { FabricKernel } from "../src/runtime/kernel.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const configLocation = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-kernel-config-"));
  directories.push(directory);
  return { cwd: path.join(directory, "project"), agentDir: path.join(directory, "agent"), projectTrusted: true };
};

describe("executor kernel configuration", () => {
  it("defaults to TypeScript/QuickJS with an inert CPython binary setting", () => {
    const config = normalizeFabricConfig({});
    expect(config.executor).toMatchObject({
      kernel: "typescript",
      runtime: "quickjs",
      cpython: { binary: "python3" },
    });
    expect(config.executor).toEqual(DEFAULT_FABRIC_CONFIG.executor);
    expect(normalizeFabricConfig({ executor: { cpython: { binary: "/opt/bin/python3" } } }).executor.kernel)
      .toBe("typescript");
  });

  it.each<FabricKernel>(["typescript", "python"])("accepts the canonical %s kernel", (kernel) => {
    const config = normalizeFabricConfig({ executor: { kernel } });
    expect(config.executor.kernel).toBe(kernel);
    expect(config.executor.cpython).toEqual({ binary: "python3" });
    expect(config.executor.cpython).not.toHaveProperty("enabled");
    expect(normalizeFabricConfig(config as unknown as Record<string, unknown>)).toEqual(config);
  });

  it.each([undefined, null, "", "javascript", "PYTHON", false, 1, {}, []])(
    "falls back to TypeScript for invalid kernel %j", (kernel) => {
      expect(normalizeFabricConfig({ executor: { kernel } }).executor.kernel).toBe("typescript");
    },
  );

  it("normalizes the binary as a trimmed nonempty executable string", () => {
    const config = normalizeFabricConfig({ executor: { kernel: "python", cpython: { binary: "  /opt/Python 3/bin/python3  " } } });
    expect(config.executor.cpython.binary).toBe("/opt/Python 3/bin/python3");
  });

  it.each([undefined, null, "", "  ", 123, true, [], {}])(
    "defaults invalid CPython binary %j without disabling Python", (binary) => {
      const config = normalizeFabricConfig({ executor: { kernel: "python", cpython: { binary } } });
      expect(config.executor.kernel).toBe("python");
      expect(config.executor.cpython.binary).toBe("python3");
    },
  );

  it.each([null, "python3", [], true])("defaults malformed CPython section %j", (cpython) => {
    expect(normalizeFabricConfig({ executor: { kernel: "python", cpython } }).executor.cpython)
      .toEqual({ binary: "python3" });
  });

  it.each(["off", "audit", "enforce"])("preserves Python under schema %s", (mode) => {
    for (const runtime of ["quickjs", "node-process", "bun-process"]) {
      const config = normalizeFabricConfig({
        schema: { mode },
        executor: { kernel: "python", runtime, cpython: { binary: "python3.12" } },
      });
      expect(config.executor).toMatchObject({ kernel: "python", runtime, cpython: { binary: "python3.12" } });
    }
  });

  it.each(["node-process", "bun-process"])("still forces TS %s to QuickJS under enforce", (runtime) => {
    const config = normalizeFabricConfig({ schema: { mode: "enforce" }, executor: { kernel: "typescript", runtime } });
    expect(config.executor.kernel).toBe("typescript");
    expect(config.executor.runtime).toBe("quickjs");
  });

  it("uses the native Python memory ceiling even with a dormant QuickJS setting under enforce", () => {
    const config = normalizeFabricConfig({
      schema: { mode: "enforce" },
      executor: { kernel: "python", runtime: "quickjs", memoryLimitBytes: Number.MAX_SAFE_INTEGER },
    });
    expect(config.executor.memoryLimitBytes).toBe(MAX_EXECUTOR_MEMORY_LIMIT_BYTES);
    expect(maxExecutorMemoryLimitBytes("quickjs", "python")).toBe(MAX_EXECUTOR_MEMORY_LIMIT_BYTES);
    expect(maxExecutorMemoryLimitBytes("quickjs")).toBe(Math.min(QUICKJS_MAX_MEMORY_LIMIT_BYTES, MAX_EXECUTOR_MEMORY_LIMIT_BYTES));
    expect(normalizeFabricConfig({ executor: { kernel: "python", memoryLimitBytes: 1 } }).executor.memoryLimitBytes)
      .toBe(8 * 1024 * 1024);
  });

  it("persists exclusive selection and merges binary overrides through generic config scopes", () => {
    const location = configLocation();
    saveFabricConfig({ ...location, scope: "global" }, {
      executor: { kernel: "python", cpython: { binary: "python3.12" }, runtime: "bun-process" },
    });
    saveFabricConfig({ ...location, scope: "project" }, { executor: { cpython: { binary: "/opt/bin/python3" } } });
    expect(loadFabricConfigForScope(location, "global").executor)
      .toMatchObject({ kernel: "python", cpython: { binary: "python3.12" }, runtime: "bun-process" });
    expect(loadFabricConfigForScope(location, "project").executor)
      .toMatchObject({ kernel: "python", cpython: { binary: "/opt/bin/python3" }, runtime: "bun-process" });

    saveFabricConfig({ ...location, scope: "project" }, { executor: { kernel: "typescript" } });
    expect(loadFabricConfigForScope(location, "project").executor)
      .toMatchObject({ kernel: "typescript", cpython: { binary: "/opt/bin/python3" }, runtime: "bun-process" });
    expect(loadFabricConfigForScope({ ...location, projectTrusted: false }, "global").executor.kernel).toBe("python");
    expect(() => loadFabricConfigForScope({ ...location, projectTrusted: false }, "project")).toThrow("untrusted");
  });
});
