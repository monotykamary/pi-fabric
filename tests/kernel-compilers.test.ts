import fs from "node:fs";
import { rmTempSync } from "./fixtures/temp-cleanup.js";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeFabricConfig } from "../src/config.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { FabricExecutionService } from "../src/execution-service.js";
import type { FabricActionDescriptor } from "../src/protocol.js";
import { RepairCompiler } from "../src/repairs/compiler.js";
import { setActiveRepairCompiler } from "../src/repairs/active.js";
import { applyCatalogArgRepairs } from "../src/repairs/apply.js";
import { classifyToolResult } from "../src/repairs/classify.js";
import { clearActiveCompiledSurface, setActiveCompiledSurface } from "../src/entropy/active.js";
import {
  applyCompiledSurface, compileEntropySurface, compileEntropySurfaceAsync,
  effectiveSchemaFor, entropySessionEvidenceFromJsonl, mergeCompiledSurfaces,
  schemaDigest, sessionWindowEvidenceAsync,
  type CompiledSurfaceFile,
} from "../src/entropy/index.js";
import { availablePythonBackends } from "./fixtures/python-backends.js";

const roots: string[] = [];
const registries: ActionRegistry[] = [];
const compilers: RepairCompiler[] = [];
afterEach(async () => {
  setActiveRepairCompiler(undefined);
  clearActiveCompiledSurface();
  await Promise.all(compilers.splice(0).map((compiler) => compiler.flush()));
  await Promise.all(registries.splice(0).map((registry) => registry.close()));
  for (const root of roots.splice(0)) rmTempSync(root);
});
const temp = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-kernel-compilers-"));
  roots.push(root);
  return root;
};
const schema = () => ({
  type: "object", additionalProperties: false,
  properties: {
    session: { type: "string" },
    format: { type: "string", enum: ["pdf", "html", "text"] },
  },
  required: ["session", "format"],
});
const surface = () => ({ version: 1 as const, actions: [{ ref: "demo.recall", inputSchema: schema() }] });
const artifact = (inputSchema: Record<string, unknown>): CompiledSurfaceFile => ({
  version: 1, metricVersion: 2,
  actions: [{ ref: "demo.recall", inputSchema, baseSchemaDigest: schemaDigest(schema()) }],
  quarantined: [], applied: [], evidenceDigest: "fixture",
  gate: { passed: true, beforeScore: 1, afterScore: 0, reasons: [] },
});
const fixture = (backend: "typescript" | "monty" | "cpython") => {
  const cwd = temp();
  const registry = new ActionRegistry();
  registries.push(registry);
  const descriptor: FabricActionDescriptor = {
    name: "recall", description: "Compiler fixture", risk: "read", inputSchema: schema(),
  };
  const invoke = vi.fn(async (_name: string, args: Record<string, unknown>) => args);
  registry.register({
    name: "demo", description: "Compiler fixture",
    async list() { return [descriptor]; },
    async describe(name) { return name === descriptor.name ? descriptor : undefined; },
    invoke,
  });
  const compiler = new RepairCompiler({ agentDir: cwd });
  compilers.push(compiler);
  compiler.setCatalogSurface({ providers: ["demo"], capturedTools: [] });
  setActiveRepairCompiler(compiler);
  const config = normalizeFabricConfig({ executor: {
    kernel: backend === "typescript" ? "typescript" : "python",
    ...(backend === "cpython" ? { pythonRuntime: "cpython" } : {}),
    ...(backend !== "cpython" ? { cpython: { binary: "/nonexistent/python3" } } : {}),
    memoryLimitBytes: 256 * 1024 * 1024,
  } });
  const service = new FabricExecutionService(registry, config);
  const context = { cwd, hasUI: false, sessionManager: {
    getSessionId: () => "kernel-compilers", getSessionFile: () => undefined,
  } } as unknown as ExtensionContext;
  const run = (code: string) => service.execute({
    code, signal: undefined, parentToolCallId: "compiler-probe", context, onPartial() {},
  });
  const call = (ref: string, args: Record<string, unknown>) => run(config.executor.kernel === "python"
    ? `return await tools.call(ref=${JSON.stringify(ref)}, args=${JSON.stringify(args)})`
    : `return await tools.call({ref: ${JSON.stringify(ref)}, args: ${JSON.stringify(args)}});`);
  return { cwd, registry, descriptor, invoke, compiler, config, service, context, run, call };
};

for (const backend of ["typescript", "monty", "cpython"] as const) {
  describe.skipIf(backend !== "typescript" && !availablePythonBackends[backend])(`${backend} shared host compilers`, () => {
    it("learns aliases without weakening canonical values, schema, approval, or pinned authority", async () => {
      const f = fixture(backend);
      const learned = await f.call("demo.search", { sessionId: "alias", format: "pdf" });
      expect(learned.success, learned.error).toBe(true);
      expect(learned.value).toEqual({ session: "alias", format: "pdf" });
      expect(f.compiler.repairs).toEqual(expect.arrayContaining([
        { kind: "actionAlias", provider: "demo", from: "search", to: "recall" },
        { kind: "keyAlias", ref: "demo.recall", from: "sessionId", to: "session" },
      ]));
      expect((await f.call("demo.search", { session: "canonical", sessionId: "spill", format: "pdf" })).success).toBe(false);
      expect((await f.call("demo.search", { session: "canonical", format: "pdf" })).value)
        .toEqual({ session: "canonical", format: "pdf" });
      f.compiler.observeInvalidArgs("demo.recall", { path: "p" }, ["session", "format"], "extra");
      const ambiguous = await f.call("demo.recall", { sessionId: "one", path: "two", format: "pdf" });
      expect(ambiguous.success).toBe(false);
      expect((await f.call("demo.recall", { sessionId: 42, format: "pdf" })).success).toBe(false);
      expect((await f.call("demo.!!!", { session: "s", format: "pdf" })).success).toBe(false);
      expect((await f.call("recall", { session: "s", format: "pdf" })).success).toBe(false);
      expect(f.invoke).toHaveBeenCalledTimes(2);
      f.config.approvals.read = "deny";
      expect((await f.call("demo.search", { sessionId: "s", format: "pdf" })).success).toBe(false);
      expect(f.invoke).toHaveBeenCalledTimes(2);
      f.config.approvals.read = "allow";
      const lease = await f.registry.acquireCapabilityView(["demo.recall"], {
        cwd: f.cwd, signal: undefined, parentToolCallId: "pin", nestedToolCallId: "pin",
        extensionContext: f.context, update() {},
      });
      expect(lease.satisfied).toBe(true);
      f.service.setCapabilityView(lease.view!);
      expect((await f.call("demo.search", { sessionId: "s", format: "pdf" })).success).toBe(false);
      expect(f.invoke).toHaveBeenCalledTimes(2);
      await lease.release();
      await f.compiler.flush();
      const reloaded = new RepairCompiler({ agentDir: f.cwd });
      reloaded.setCatalogSurface({ providers: ["demo"], capturedTools: [] });
      expect(reloaded.repairs).toEqual(f.compiler.repairs);
      reloaded.setCatalogSurface({ providers: ["demo", "new"], capturedTools: [] });
      expect(reloaded.repairs).toEqual([]);
      expect(reloaded.status().fingerprints).toEqual([]);
    });

    it("compiles normal forms across language switches without losing rare capabilities", async () => {
      const f = fixture(backend);
      const lines: string[] = [];
      for (const format of ["pdf", "pdf", "pdf", "pdf", "pdf", "pdf", "pdf", "html"]) {
        const result = await f.call("demo.recall", { session: "s", format });
        expect(result.success, result.error).toBe(true);
        lines.push(JSON.stringify({ message: { role: "toolResult", toolName: "fabric_exec", details: result } }));
      }
      const evidence = entropySessionEvidenceFromJsonl(lines);
      expect(evidence.auditCalls).toHaveLength(8);
      const input = { ...evidence, surface: surface() };
      const compiled = compileEntropySurface(input);
      expect(compiled.status).toBe("compiled");
      expect(await compileEntropySurfaceAsync(input)).toEqual(compiled);
      expect(compiled.artifact?.actions).toEqual([]);
      expect(compiled.artifact?.normalizations?.[0]?.ref).toBe("demo.recall");
      setActiveCompiledSurface(compiled.artifact);
      expect((await f.call("demo.recall", { session: "s", format: "text" })).success).toBe(true);
      const repaired = await f.call("demo.recall", { session: "s", format: "TEXT" });
      expect(repaired.success, repaired.error).toBe(true);
      expect(repaired.value).toEqual({ session: "s", format: "text" });
      expect(repaired.trace?.operations[0]?.normalization?.rules).toContainEqual({ kind: "enum-form", key: "format" });
      f.config.executor.kernel = backend === "typescript" ? "python" : "typescript";
      expect((await f.call("demo.recall", { session: "s", format: "TEXT" })).success).toBe(true);
      expect((await f.call("demo.recall", { session: "s", format: "pdf" })).success).toBe(true);
      f.descriptor.inputSchema = { ...schema(), description: "new declared revision" };
      expect((await f.call("demo.recall", { session: "s", format: "text" })).success).toBe(true);
      expect((await f.call("demo.recall", { session: "s", format: "TEXT" })).success).toBe(false);
      f.config.executor.kernel = backend === "typescript" ? "typescript" : "python";
      setActiveCompiledSurface({
        ...compiled.artifact!, version: 1, actions: [],
        quarantined: [{ ref: "demo.recall", baseSchemaDigest: schemaDigest(f.descriptor.inputSchema) }],
      });
      const callsBeforeLegacy = f.invoke.mock.calls.length;
      expect((await f.call("demo.recall", { session: "s", format: "pdf" })).success).toBe(true);
      expect((await f.call("demo.search", { sessionId: "s", format: "pdf" })).success).toBe(true);
      expect(f.invoke).toHaveBeenCalledTimes(callsBeforeLegacy + 2);
    });
  });
}

describe("language-neutral artifact guards", () => {
  it("rejects schema weakening despite a matching base digest, in consult/export/import", () => {
    const base = schema();
    const widened = [
      { ...base, required: [] },
      { ...base, additionalProperties: true },
      { ...base, properties: { ...base.properties, session: { type: "number" } } },
      { ...base, properties: { ...base.properties, format: { type: "string", enum: ["pdf", "exe"] } } },
      { ...base, properties: { ...base.properties, format: { type: "string" } } },
    ];
    for (const candidate of widened) {
      const file = artifact(candidate);
      expect(effectiveSchemaFor("demo.recall", base, file)).toBe(base);
      expect(applyCompiledSurface(surface(), file)).toEqual(surface());
      expect(mergeCompiledSurfaces(undefined, file, surface())).toMatchObject({ droppedOverlays: 1, file: { actions: [] } });
    }
    const restricted = { ...base, properties: { ...base.properties, format: { type: "string", enum: ["pdf"] } } };
    expect(effectiveSchemaFor("demo.recall", base, artifact(restricted))).toBe(base);
  });

  it("does not import inherited aliases or let Object.prototype beat a Python dictionary key", () => {
    const repairs = [{ kind: "keyAlias" as const, ref: "demo.recall", from: "sessionId", to: "session" }];
    const inherited = Object.create({ sessionId: "not supplied" }) as Record<string, unknown>;
    expect(applyCatalogArgRepairs("demo.recall", inherited, repairs, schema()).changed).toBe(false);
    const args = Object.assign(Object.create({ session: "inherited" }), { sessionId: "supplied", format: "pdf" });
    expect(applyCatalogArgRepairs("demo.recall", args, repairs, schema()).args).toEqual({ session: "supplied", format: "pdf" });
    const protoSchema = { type: "object", additionalProperties: false, properties: JSON.parse('{"__proto__":{"type":"object"}}') };
    const proto = applyCatalogArgRepairs("demo.recall", { proto: { safe: true } }, [
      { kind: "keyAlias", ref: "demo.recall", from: "proto", to: "__proto__" },
    ], protoSchema).args;
    expect(Object.hasOwn(proto, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(proto)).toBe(Object.prototype);
  });

  it("keeps Python-shaped prose out of learning while preserving spaced JSON model attribution and cache appends", async () => {
    const f = fixture("typescript");
    const result = await f.call("demo.recall", { session: "s", format: "pdf" });
    const prose = 'Traceback (most recent call last):\nNameError: name "pi-fabric.execution" is not defined\n{"format": "exe"}';
    const assistant = '{"message": {"role": "assistant", "provider": "test", "model": "python-model", "content": "pi-fabric.execution"}}';
    const fake = JSON.stringify({ message: { content: prose, details: { trace: { kind: "pi-fabric.execution", version: 999 }, audits: [{ ref: "demo.recall", args: { format: "exe" } }] } } });
    const valid = JSON.stringify({ message: { role: "toolResult", details: result } });
    const file = path.join(f.cwd, "session.jsonl");
    fs.writeFileSync(file, [assistant, fake, valid].join("\n") + "\n");
    const first = await sessionWindowEvidenceAsync([file]);
    expect(first.traces).toHaveLength(1);
    expect(first.traces[0]?.model).toBe("test/python-model");
    expect(first.valueObservations).not.toContainEqual(expect.objectContaining({ value: "exe" }));
    fs.appendFileSync(file, '{"type": "model_change", "provider": "test", "modelId": "next"}\n' + valid + "\n");
    const appended = await sessionWindowEvidenceAsync([file]);
    expect(appended.traces.map((trace) => trace.model)).toEqual(["test/python-model", "test/next"]);
    expect(appended.auditCalls).toHaveLength(2);
    expect(await sessionWindowEvidenceAsync([file])).toEqual(appended);
    expect(classifyToolResult({ toolName: "fabric_exec", isError: true, content: `Runtime error: ${prose}` })).toMatchObject({ stage: "effect" });
    for (const text of ["SyntaxError: invalid syntax", "NameError: name 'tools' is not defined", "TypeError: expected dict, got list"]) {
      const classified = classifyToolResult({ toolName: "fabric_exec", isError: true, content: text })!;
      expect(classified.candidate).toBeUndefined();
      f.compiler.observe(classified);
    }
    expect(f.compiler.repairs).toEqual([]);
  });
});
