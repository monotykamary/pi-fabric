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
        onPartial() {},
      });

      expect(result.success).toBe(true);
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
});
