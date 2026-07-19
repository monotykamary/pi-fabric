import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { FabricActivityStore } from "../src/activity/store.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { FabricExecutionService } from "../src/execution-service.js";
import { PiToolsProvider } from "../src/providers/pi-tools-provider.js";

describe("FabricExecutionService", () => {
  it("calls a Pi built-in from sandboxed TypeScript", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-execution-"));
    try {
      fs.writeFileSync(path.join(cwd, "sample.txt"), "fabric works\n", "utf8");
      const registry = new ActionRegistry();
      registry.register(new PiToolsProvider(cwd, undefined, undefined));
      const config = structuredClone(DEFAULT_FABRIC_CONFIG);
      config.approvals.read = "allow";
      const service = new FabricExecutionService(registry, config);
      const context = {
        cwd,
        hasUI: false,
      } as ExtensionContext;
      const result = await service.execute({
        code: 'const content = await pi.read({ path: "sample.txt" });\nreturn content.trim();',
        signal: undefined,
        parentToolCallId: "test",
        context,
        onPartial() {},
      });
      expect(result.success).toBe(true);
      expect(result.value).toBe("fabric works");
      expect(result.audits).toMatchObject([
        { ref: "pi.read", success: true, tool: "read", provider: "pi" },
      ]);
      expect(result.audits[0]?.args).toMatchObject({ path: "sample.txt" });
      expect(result.audits[0]?.result).toBe("fabric works\n");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("coalesces all parallel nested calls through one global debounce and flushes on settle", async () => {
    const registry = new ActionRegistry();
    const descriptor = {
      name: "ping",
      description: "emit rapid progress",
      inputSchema: {
        type: "object",
        properties: { id: { type: "number" } },
        required: ["id"],
        additionalProperties: false,
      },
      risk: "read" as const,
    };
    registry.register({
      name: "demo",
      description: "debounce fixture",
      async list() {
        return [descriptor];
      },
      async describe(name) {
        return name === "ping" ? descriptor : undefined;
      },
      async invoke(_name, args, invocation) {
        invocation.update(`starting ${String(args.id)}`);
        invocation.update(`finishing ${String(args.id)}`);
        return args.id;
      },
    });
    const context = { cwd: process.cwd(), hasUI: false } as ExtensionContext;
    const code = `return Promise.all([
      tools.call({ ref: "demo.ping", args: { id: 1 } }),
      tools.call({ ref: "demo.ping", args: { id: 2 } }),
      tools.call({ ref: "demo.ping", args: { id: 3 } }),
    ]);`;

    const debouncedConfig = structuredClone(DEFAULT_FABRIC_CONFIG);
    debouncedConfig.fullCodeMode = false;
    debouncedConfig.approvals.read = "allow";
    debouncedConfig.ui.nestedToolDebounceMs = 10_000;
    const debouncedPartials: Array<{ audits: unknown[] }> = [];
    const debounced = await new FabricExecutionService(registry, debouncedConfig).execute({
      code,
      signal: undefined,
      parentToolCallId: "global-debounce",
      context,
      onPartial(snapshot) {
        debouncedPartials.push(snapshot);
      },
    });
    expect(debounced.success).toBe(true);
    expect(debouncedPartials).toHaveLength(1);
    expect(debouncedPartials[0]?.audits).toHaveLength(3);

    const immediateConfig = structuredClone(debouncedConfig);
    immediateConfig.ui.nestedToolDebounceMs = 0;
    const immediatePartials: unknown[] = [];
    await new FabricExecutionService(registry, immediateConfig).execute({
      code,
      signal: undefined,
      parentToolCallId: "no-debounce",
      context,
      onPartial(snapshot) {
        immediatePartials.push(snapshot);
      },
    });
    expect(immediatePartials.length).toBeGreaterThan(1);
  });

  it("coalesces rapid workflow phase updates through the same debounce", async () => {
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.ui.nestedToolDebounceMs = 10_000;
    const partials: Array<{ phases: string[] }> = [];
    const result = await new FabricExecutionService(new ActionRegistry(), config).execute({
      code: `
for (let index = 0; index < 50; index++) {
  await phase("Phase " + index);
}
return "done";
`,
      signal: undefined,
      parentToolCallId: "phase-debounce",
      context: { cwd: process.cwd(), hasUI: false } as ExtensionContext,
      onPartial(snapshot) {
        partials.push(snapshot);
      },
    });

    expect(result.success).toBe(true);
    expect(result.phases).toHaveLength(50);
    expect(partials).toHaveLength(1);
    expect(partials[0]?.phases).toHaveLength(50);
  });

  it("attaches image blocks to the audit for a single nested image read", async () => {
    const cwd = process.cwd();
    const registry = new ActionRegistry();
    registry.register(new PiToolsProvider(cwd, undefined, undefined));
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.approvals.read = "allow";
    const service = new FabricExecutionService(registry, config);
    const context = { cwd, hasUI: false } as ExtensionContext;
    const result = await service.execute({
      code: 'return pi.read({ path: "tests/fixtures/images/sample.jpg" });',
      signal: undefined,
      parentToolCallId: "img-read",
      context,
      onPartial() {},
    });
    expect(result.success).toBe(true);
    expect(result.audits).toHaveLength(1);
    const media = result.audits[0]?.media;
    expect(media).toBeDefined();
    expect(media!.length).toBeGreaterThan(0);
    expect(media![0]?.type).toBe("image");
    expect(media![0]?.mimeType).toMatch(/^image\//);
    expect(typeof media![0]?.data).toBe("string");
    expect(media![0]?.data!.length).toBeGreaterThan(0);
  }, 15_000);

  it("keeps Pi core tools outside Fabric in orchestration-only mode", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-native-tools-"));
    try {
      fs.writeFileSync(path.join(cwd, "sample.txt"), "native\n", "utf8");
      const registry = new ActionRegistry();
      registry.register(new PiToolsProvider(cwd, undefined, undefined));
      const config = structuredClone(DEFAULT_FABRIC_CONFIG);
      config.fullCodeMode = false;
      config.approvals.read = "allow";
      const service = new FabricExecutionService(registry, config);
      const context = { cwd, hasUI: false } as ExtensionContext;

      const metadata = await service.execute({
        code: `
return {
  providers: await tools.providers(),
  search: await tools.search({ query: "read" }),
};
`,
        signal: undefined,
        parentToolCallId: "native-metadata",
        context,
        onPartial() {},
      });
      expect(metadata.success).toBe(true);
      expect(metadata.value).toEqual({ providers: [], search: [] });

      const direct = await service.execute({
        code: 'return pi.read({ path: "sample.txt" });',
        signal: undefined,
        parentToolCallId: "native-direct",
        context,
        onPartial() {},
      });
      expect(direct.typeErrors?.map((error) => error.message).join(" ")).toContain(
        "Cannot find name 'pi'",
      );

      const indirect = await service.execute({
        code: 'return tools.call({ ref: "pi.read", args: { path: "sample.txt" } });',
        signal: undefined,
        parentToolCallId: "native-indirect",
        context,
        onPartial() {},
      });
      expect(indirect.success).toBe(false);
      expect(indirect.error).toContain("full code mode is disabled");
      expect(indirect.audits).toEqual([]);

      const extension = await service.execute({
        code: 'return tools.call({ ref: "extensions.project_status", args: {} });',
        signal: undefined,
        parentToolCallId: "native-extension",
        context,
        onPartial() {},
      });
      expect(extension.success).toBe(false);
      expect(extension.error).toContain("registered extension tools directly outside fabric_exec");
      expect(extension.audits).toEqual([]);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("publishes declarative workflow activity for the dynamic TUI", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-activity-"));
    try {
      fs.writeFileSync(path.join(cwd, "sample.txt"), "dashboard\n", "utf8");
      const registry = new ActionRegistry();
      registry.register(new PiToolsProvider(cwd, undefined, undefined));
      const config = structuredClone(DEFAULT_FABRIC_CONFIG);
      config.approvals.read = "allow";
      const activity = new FabricActivityStore();
      const service = new FabricExecutionService(registry, config, activity);
      const context = { cwd, hasUI: false } as ExtensionContext;
      const partials: Array<{ phases: string[] }> = [];
      const result = await service.execute({
        code: `
await workflow.configure({ name: "File audit", description: "Read one fixture" });
await phase("Inspect", { id: "inspect", total: 1 });
await workflow.item({ id: "fixture", label: "Read fixture", status: "running" });
const text = await pi.read({ path: "sample.txt" });
await workflow.item({ id: "fixture", label: "Read fixture", status: "completed", completed: 1, total: 1 });
await workflow.event({ message: "Fixture inspected", level: "success" });
return text.trim();
`,
        signal: undefined,
        parentToolCallId: "activity-test",
        context,
        onPartial(snapshot) {
          partials.push(snapshot);
        },
      });

      expect(result.success).toBe(true);
      expect(partials.some((partial) => partial.phases.includes("Inspect"))).toBe(true);
      expect(activity.get("activity-test")).toMatchObject({
        name: "File audit",
        description: "Read one fixture",
        status: "completed",
        phases: [{ id: "inspect", name: "Inspect", status: "completed", total: 1 }],
        calls: [{ ref: "pi.read", status: "completed", phaseId: "inspect" }],
        items: [{ id: "fixture", status: "completed", completed: 1, total: 1 }],
        events: [{ message: "Fixture inspected", level: "success" }],
      });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("enforces the per-execution agent budget", async () => {
    const registry = new ActionRegistry();
    const descriptor = {
      name: "run",
      description: "fake agent",
      inputSchema: {
        type: "object",
        properties: { task: { type: "string" } },
        required: ["task"],
        additionalProperties: true,
      },
      risk: "agent" as const,
    };
    registry.register({
      name: "agents",
      description: "fake agents",
      async list() {
        return [descriptor];
      },
      async describe(name) {
        return name === "run" ? descriptor : undefined;
      },
      async invoke(_name, args) {
        return {
          status: "completed",
          text: String(args.task),
          usage: { input: 1, output: 1 },
        };
      },
    });
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = false;
    config.approvals.agent = "allow";
    const service = new FabricExecutionService(registry, config);
    const context = { cwd: process.cwd(), hasUI: false } as ExtensionContext;
    const result = await service.execute({
      code: `
await Promise.all([
  agents.run({ task: "one" }),
  agents.run({ task: "two" }),
]);
return "unreachable";
`,
      signal: undefined,
      parentToolCallId: "budget-test",
      context,
      maxAgentCalls: 1,
      onPartial() {},
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("agent budget exhausted (1 per execution)");
  });

  it("raises the executor deadline to the subagent deadline for orchestration programs", async () => {
    const registry = new ActionRegistry();
    const descriptor = {
      name: "run",
      description: "fake agent",
      inputSchema: {
        type: "object",
        properties: { task: { type: "string" } },
        required: ["task"],
        additionalProperties: true,
      },
      risk: "agent" as const,
    };
    registry.register({
      name: "agents",
      description: "fake agents",
      async list() {
        return [descriptor];
      },
      async describe(name) {
        return name === "run" ? descriptor : undefined;
      },
      async invoke(_name, _args, context) {
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            clearTimeout(timer);
            resolve({ status: "completed", text: "ok", usage: { input: 0, output: 0 } });
          }, 250);
          context.signal?.addEventListener("abort", () => clearTimeout(timer), { once: true });
        });
      },
    });
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = false;
    config.approvals.agent = "allow";
    config.executor.timeoutMs = 100;
    config.subagents.timeoutMs = 30_000;
    const service = new FabricExecutionService(registry, config);
    const context = { cwd: process.cwd(), hasUI: false } as ExtensionContext;
    const result = await service.execute({
      code: 'await agents.run({ task: "slow" }); return "ok";',
      signal: undefined,
      parentToolCallId: "orchestration-floor",
      context,
      onPartial() {},
    });
    expect(result.success).toBe(true);
    expect(result.value).toBe("ok");
  });

  it("raises the deadline for literal and computed generic agent refs", async () => {
    const registry = new ActionRegistry();
    const descriptor = {
      name: "run",
      description: "fake agent",
      inputSchema: {
        type: "object",
        properties: { task: { type: "string" } },
        required: ["task"],
        additionalProperties: true,
      },
      risk: "agent" as const,
    };
    registry.register({
      name: "agents",
      description: "fake agents",
      async list() {
        return [descriptor];
      },
      async describe(name) {
        return name === "run" ? descriptor : undefined;
      },
      async invoke(_name, args, context) {
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            resolve({
              status: "completed",
              text: String(args.task),
              usage: { input: 0, output: 0 },
            });
          }, 250);
          context.signal?.addEventListener("abort", () => clearTimeout(timer), { once: true });
        });
      },
    });
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = false;
    config.approvals.agent = "allow";
    config.executor.timeoutMs = 100;
    config.subagents.timeoutMs = 30_000;
    const service = new FabricExecutionService(registry, config);
    const context = { cwd: process.cwd(), hasUI: false } as ExtensionContext;
    const result = await service.execute({
      code: `
const computedRef = ["agents", "run"].join(".");
return Promise.all([
  tools.call({ ref: "agents.run", args: { task: "literal" } }),
  tools.call({ ref: computedRef, args: { task: "computed" } }),
]);
`,
      signal: undefined,
      parentToolCallId: "generic-orchestration-floor",
      context,
      onPartial() {},
    });
    expect(result.success).toBe(true);
    expect(result.value).toEqual([
      { status: "completed", text: "literal", usage: { input: 0, output: 0 } },
      { status: "completed", text: "computed", usage: { input: 0, output: 0 } },
    ]);
  });

  it("keeps the short executor deadline for non-orchestration programs", async () => {
    const registry = new ActionRegistry();
    const descriptor = {
      name: "slow",
      description: "slow call",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      risk: "read" as const,
    };
    registry.register({
      name: "demo",
      description: "demo provider",
      async list() {
        return [descriptor];
      },
      async describe(name) {
        return name === "slow" ? descriptor : undefined;
      },
      async invoke(_name, _args, context) {
        return new Promise((_resolve, reject) => {
          context.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      },
    });
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = false;
    config.approvals.read = "allow";
    config.executor.timeoutMs = 100;
    config.subagents.timeoutMs = 30_000;
    const service = new FabricExecutionService(registry, config);
    const context = { cwd: process.cwd(), hasUI: false } as ExtensionContext;
    const result = await service.execute({
      code: 'return tools.call({ ref: "demo.slow", args: {} });',
      signal: undefined,
      parentToolCallId: "no-floor",
      context,
      onPartial() {},
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
  });
});
