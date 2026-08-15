import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createSyntheticSourceInfo,
  defineTool,
  type ExtensionContext,
  type ExtensionRunner,
  type RegisteredTool,
} from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { CapturedToolCatalog } from "../src/capture/catalog.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { FabricExecutionService } from "../src/execution-service.js";
import { CapturedToolsProvider } from "../src/providers/captured-tools-provider.js";
import { PiToolsProvider } from "../src/providers/pi-tools-provider.js";

const makeRunner = (): ExtensionRunner => ({
  createContext: () => ({ cwd: process.cwd() }),
  getActiveTools: () => [],
  emit: vi.fn(async () => {}),
  emitToolCall: vi.fn(async () => undefined),
  emitToolResult: vi.fn(async () => undefined),
} as unknown as ExtensionRunner);

const makeContext = (cwd: string): ExtensionContext => ({
  cwd,
  hasUI: false,
  sessionManager: {
    getSessionId: () => "core-override-test",
    getSessionFile: () => undefined,
  },
} as unknown as ExtensionContext);

const makeOverride = (
  name: string,
  parameters: unknown,
  calls: Array<Record<string, unknown>>,
  output = name,
): RegisteredTool => ({
  definition: defineTool({
    name,
    label: `${name} override`,
    description: `Compatible ${name} override`,
    parameters: parameters as TSchema,
    async execute(_id, params) {
      calls.push(params as Record<string, unknown>);
      return {
        content: [{ type: "text" as const, text: `${output}:${String((params as { path?: unknown }).path ?? "")}` }],
        details: { implementation: output },
      };
    },
  }),
  sourceInfo: createSyntheticSourceInfo(`/extensions/${name}-override/index.ts`, { source: "test" }),
});

const setup = (
  cwd: string,
  registeredTools: RegisteredTool[],
): {
  catalog: CapturedToolCatalog;
  service: FabricExecutionService;
  runner: ExtensionRunner;
} => {
  const runner = makeRunner();
  const catalog = new CapturedToolCatalog();
  catalog.replace(
    registeredTools,
    runner,
    DEFAULT_FABRIC_CONFIG.capture,
    "/extensions/pi-fabric/index.ts",
  );
  const captured = new CapturedToolsProvider(catalog);
  const registry = new ActionRegistry();
  registry.register(new PiToolsProvider(cwd, catalog, captured));
  const config = structuredClone(DEFAULT_FABRIC_CONFIG);
  config.approvals.read = "allow";
  config.approvals.write = "allow";
  config.approvals.execute = "allow";
  const service = new FabricExecutionService(
    registry,
    config,
    undefined,
    undefined,
    undefined,
    undefined,
    catalog,
  );
  return { catalog, service, runner };
};

describe("captured core overrides through Fabric execution", () => {
  it("type-checks and invokes additive read forms while preserving shorthand and strings", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-core-read-"));
    const calls: Array<Record<string, unknown>> = [];
    const schema = Type.Object({
      path: Type.String(),
      offset: Type.Optional(Type.Number()),
      limit: Type.Optional(Type.Number()),
      structure: Type.Optional(Type.Literal("symbols")),
      symbolId: Type.Optional(Type.String()),
    }, { additionalProperties: false });
    const entry = makeOverride("read", schema, calls, "read-override");
    const { catalog, service } = setup(cwd, [entry]);
    try {
      const result = await service.execute({
        code: `
const shorthand = await pi.read("plain.ts");
const structure = await pi.read({ file: "tree.ts", structure: "symbols", symbolId: "opaque", offset: "3" });
return { shorthand, structure };
`,
        signal: undefined,
        parentToolCallId: "core-read",
        context: makeContext(cwd),
        onPartial() {},
      });

      expect(result.success).toBe(true);
      expect(result.value).toEqual({
        shorthand: "read-override:plain.ts",
        structure: "read-override:tree.ts",
      });
      expect(calls).toEqual([
        { path: "plain.ts" },
        { path: "tree.ts", structure: "symbols", symbolId: "opaque", offset: 3 },
      ]);

      const invalid = await service.execute({
        code: 'await pi.read({ path: "bad.ts", structrue: "symbols" }); return "never";',
        signal: undefined,
        parentToolCallId: "core-read-invalid",
        context: makeContext(cwd),
        onPartial() {},
      });
      expect(invalid.success).toBe(false);
      expect(invalid.typeErrors?.length).toBeGreaterThan(0);
      expect(calls).toHaveLength(2);

      const runtimeInvalid = await service.execute({
        code: 'const args = { path: "bad.ts", outside: true }; return pi.read(args);',
        signal: undefined,
        parentToolCallId: "core-read-runtime-invalid",
        context: makeContext(cwd),
        onPartial() {},
      });
      expect(runtimeInvalid.success).toBe(false);
      expect(runtimeInvalid.error).toContain("Invalid arguments for pi.read");
      expect(calls).toHaveLength(2);
    } finally {
      catalog.clear();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("normalizes edit positional, alias, batch, and symbol forms into the override", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-core-edit-"));
    const calls: Array<Record<string, unknown>> = [];
    const schema = Type.Object({
      path: Type.String(),
      oldText: Type.Optional(Type.String()),
      newText: Type.Optional(Type.String()),
      edits: Type.Optional(Type.Array(Type.Object({
        oldText: Type.String(),
        newText: Type.String(),
        all: Type.Optional(Type.Boolean()),
      }, { additionalProperties: false }))),
      symbolId: Type.Optional(Type.String()),
    }, { additionalProperties: false });
    const entry = makeOverride("edit", schema, calls, "edit-override");
    const { catalog, service } = setup(cwd, [entry]);
    try {
      const result = await service.execute({
        code: `
const positional = await pi.edit("file.ts", "one", "two");
const alias = await pi.edit({ file: "file.ts", old: "three", new: "four" });
const batch = await pi.edit({ path: "file.ts", edits: [{ old: "five", new: "six", all: true }] });
const symbol = await pi.edit({ path: "file.ts", symbolId: "opaque", oldText: "seven", newText: "eight" });
const symbolAlias = await pi.edit({ file: "file.ts", symbolId: "opaque", old: "nine", new: "ten" });
return [positional.output, alias.output, batch.output, symbol.output, symbolAlias.output];
`,
        signal: undefined,
        parentToolCallId: "core-edit",
        context: makeContext(cwd),
        onPartial() {},
      });

      expect(result.success).toBe(true);
      expect(result.value).toEqual([
        "edit-override:file.ts",
        "edit-override:file.ts",
        "edit-override:file.ts",
        "edit-override:file.ts",
        "edit-override:file.ts",
      ]);
      expect(calls).toEqual([
        { path: "file.ts", edits: [{ oldText: "one", newText: "two" }] },
        { path: "file.ts", edits: [{ oldText: "three", newText: "four" }] },
        { path: "file.ts", edits: [{ oldText: "five", newText: "six", all: true }] },
        { path: "file.ts", symbolId: "opaque", edits: [{ oldText: "seven", newText: "eight" }] },
        { path: "file.ts", symbolId: "opaque", edits: [{ oldText: "nine", newText: "ten" }] },
      ]);

      const invalid = await service.execute({
        code: 'await pi.edit({ path: "file.ts", edits: [{ oldText: "a", newText: "b", alll: true }] }); return "never";',
        signal: undefined,
        parentToolCallId: "core-edit-invalid",
        context: makeContext(cwd),
        onPartial() {},
      });
      expect(invalid.success).toBe(false);
      expect(invalid.typeErrors?.length).toBeGreaterThan(0);
      expect(calls).toHaveLength(5);
    } finally {
      catalog.clear();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("refreshes replacement and removal for the next execution without stale declarations", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-core-refresh-"));
    fs.writeFileSync(path.join(cwd, "sample.txt"), "built-in result\n", "utf8");
    const calls: Array<Record<string, unknown>> = [];
    const firstSchema = Type.Object({
      path: Type.String(),
      firstOnly: Type.Optional(Type.Literal(true)),
    }, { additionalProperties: false });
    const secondSchema = Type.Object({
      path: Type.String(),
      secondOnly: Type.Optional(Type.Literal(true)),
    }, { additionalProperties: false });
    const first = makeOverride("read", firstSchema, calls, "first");
    const second = makeOverride("read", secondSchema, calls, "second");
    const { catalog, service, runner } = setup(cwd, [first]);
    try {
      const run = (code: string, id: string) => service.execute({
        code,
        signal: undefined,
        parentToolCallId: id,
        context: makeContext(cwd),
        onPartial() {},
      });
      await expect(run('return pi.read({ path: "one", firstOnly: true });', "refresh-first"))
        .resolves.toMatchObject({ success: true, value: "first:one" });

      catalog.replace(
        [second],
        runner,
        DEFAULT_FABRIC_CONFIG.capture,
        "/extensions/pi-fabric/index.ts",
      );
      await expect(run('return pi.read({ path: "two", secondOnly: true });', "refresh-second"))
        .resolves.toMatchObject({ success: true, value: "second:two" });

      catalog.clear();
      await expect(run('return pi.read({ path: "sample.txt" });', "refresh-removed"))
        .resolves.toMatchObject({ success: true, value: "built-in result\n" });
      expect(calls).toEqual([
        { path: "one", firstOnly: true },
        { path: "two", secondOnly: true },
      ]);
    } finally {
      catalog.clear();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("keeps unsupported schemas reachable but leaves invalid arguments to registry validation", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-core-fallback-"));
    const calls: Array<Record<string, unknown>> = [];
    const properties: Record<string, unknown> = {
      path: { type: "string" },
    };
    for (let index = 0; index < 200; index += 1) {
      properties[`field_${index}`] = { type: "string" };
    }
    const overBudget = { type: "object", properties, required: ["path"], additionalProperties: false };
    const { catalog, service } = setup(cwd, [makeOverride("read", overBudget, calls, "never")]);
    try {
      const result = await service.execute({
        code: 'const args = { path: "file.ts", outside: true }; return pi.read(args);',
        signal: undefined,
        parentToolCallId: "core-fallback",
        context: makeContext(cwd),
        onPartial() {},
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid arguments for pi.read");
      expect(calls).toEqual([]);
    } finally {
      catalog.clear();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
