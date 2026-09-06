import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { availablePythonBackends, pythonBackends } from "./fixtures/python-backends.js";
import { normalizeFabricConfig, type FabricSchemaMode, type FabricPythonRuntime } from "../src/config.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { FabricExecutionService } from "../src/execution-service.js";
import { MeshStore } from "../src/mesh/store.js";
import { PiToolsProvider } from "../src/providers/pi-tools-provider.js";
import { SchemaProvider } from "../src/providers/schema-provider.js";
import { SchemaController } from "../src/schema/controller.js";
import { StateStore } from "../src/state/store.js";

const roots: string[] = [];
const registries: ActionRegistry[] = [];
afterEach(async () => {
  await Promise.all(registries.splice(0).map((registry) => registry.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const fixture = (mode: FabricSchemaMode, pythonRuntime: FabricPythonRuntime) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-python-schema-"));
  roots.push(cwd);
  const config = normalizeFabricConfig({ executor: { kernel: "python", ...(pythonRuntime === "cpython" ? { pythonRuntime } : { cpython: { binary: "/nonexistent/python3" } }), memoryLimitBytes: 256 * 1024 * 1024 }, schema: { mode } });
  const mesh = new MeshStore(path.join(cwd, ".pi", "fabric", "mesh"), 256 * 1024, 500);
  const controller = new SchemaController(cwd, config.schema, mesh,
    { id: "session:python-schema", name: "main", kind: "main", sessionId: "python-schema" },
    new StateStore(mesh));
  const registry = new ActionRegistry();
  registries.push(registry);
  registry.register(new PiToolsProvider(cwd));
  registry.register(new SchemaProvider(controller));
  const service = new FabricExecutionService(registry, config, undefined, controller);
  let id = 0;
  const run = (code: string) => service.execute({
    code, signal: undefined, parentToolCallId: `python-schema-${++id}`,
    context: { cwd, hasUI: false } as ExtensionContext, onPartial() {},
  });
  return { cwd, config, run };
};

const transaction = `
hypothesis = await schema.hypothesize(
    label="python write", summary="create one verified file",
    evidence=[{"kind": "file_absent", "path": "result.txt"}])
verified = await schema.verify(hypothesisId=hypothesis["hypothesisId"])
assert verified["verified"], verified
committed = await schema.commit(
    hypothesisId=hypothesis["hypothesisId"], certificate=verified["certificate"],
    operations=[{"kind": "write", "path": "result.txt", "content": "verified Python", "expected": {"absent": True}}],
    postconditions=[{"kind": "file_contains", "path": "result.txt", "literal": "verified Python"}])
return {"outcome": committed["outcome"], "text": await pi.read("result.txt")}
`;

// Restricted CI containers may forbid OS sandbox startup. That must be an
// explicit fail-closed outcome, never a fallback to unrestricted Python.
const unavailableIsolation = (error: string | undefined) =>
  /sandbox|isolation|bubblewrap|bwrap/i.test(error ?? "");

describe.each(pythonBackends)("Schema uses the %s Python kernel", (pythonRuntime) => {
  const runTest = it.skipIf(!availablePythonBackends[pythonRuntime]);
  runTest.each(["off", "audit", "enforce"] as const)("runs Python schema transactions in %s mode", async (mode) => {
    const { cwd, config, run } = fixture(mode, pythonRuntime);
    expect(config.executor.pythonRuntime).toBe(pythonRuntime);
    expect(config.executor.kernel).toBe("python");
    const result = await run(transaction);
    if (pythonRuntime === "cpython" && mode === "enforce" && !result.success && unavailableIsolation(result.error)) {
      expect(result.audits).toEqual([]);
      expect(fs.existsSync(path.join(cwd, "result.txt"))).toBe(false);
      return;
    }
    expect(result.success, result.error).toBe(true);
    expect(result.value).toEqual({ outcome: "committed", text: "verified Python" });
    expect(result.audits.map((audit) => audit.ref)).toEqual([
      "schema.hypothesize", "schema.verify", "schema.commit", "pi.read",
    ]);
    expect(fs.readFileSync(path.join(cwd, "result.txt"), "utf8")).toBe("verified Python");
  });

  runTest("blocks host mutations and native writes instead of switching to TypeScript", async () => {
    const { cwd, run } = fixture("enforce", pythonRuntime);
    const host = await run('return await pi.write(path="bypass.txt", content="blocked")');
    expect(host.success).toBe(false);
    if (pythonRuntime === "monty" || !unavailableIsolation(host.error)) {
      expect(host.trace.operations[0]).toMatchObject({ ref: "pi.write", failureStage: "guard" });
    } else {
      expect(host.audits).toEqual([]);
    }
    expect(fs.existsSync(path.join(cwd, "bypass.txt"))).toBe(false);
    const native = await run('from pathlib import Path\nPath("native.txt").write_text("blocked")\nreturn "escaped"');
    expect(native.success).toBe(false);
    expect(native.typeErrors).toBeUndefined();
    expect(fs.existsSync(path.join(cwd, "native.txt"))).toBe(false);
  });
});
