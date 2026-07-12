import {
  createSyntheticSourceInfo,
  defineTool,
  ExtensionRunner,
  type RegisteredTool,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapturedToolCatalog } from "../src/capture/catalog.js";
import {
  installRegisteredToolCapture,
  type RegisteredToolCaptureController,
} from "../src/capture/interceptor.js";
import { DEFAULT_FABRIC_CONFIG, effectiveToolCaptureConfig } from "../src/config.js";

const controllers: RegisteredToolCaptureController[] = [];

const tool = (name: string) =>
  defineTool({
    name,
    label: name,
    description: `${name} description`,
    parameters: Type.Object({ value: Type.Optional(Type.String()) }),
    execute: vi.fn(async (_id, params) => ({
      content: [{ type: "text" as const, text: params.value ?? name }],
      details: {},
    })),
  });

const registered = (definition: ReturnType<typeof tool>, sourcePath: string): RegisteredTool => ({
  definition,
  sourceInfo: createSyntheticSourceInfo(sourcePath, { source: "test" }),
});

const runnerWith = (...entries: RegisteredTool[]): ExtensionRunner => {
  const runner = Object.create(ExtensionRunner.prototype) as ExtensionRunner;
  (runner as unknown as { extensions: Array<{ tools: Map<string, RegisteredTool> }> }).extensions =
    [{ tools: new Map(entries.map((entry) => [entry.definition.name, entry])) }];
  return runner;
};

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
});

describe("registered extension tool capture", () => {
  it("captures every extension tool while retaining configured model-visible tools", async () => {
    const fabricTool = tool("fabric_exec");
    const customTool = tool("deploy_release");
    const readOverride = tool("read");
    const runner = runnerWith(
      registered(fabricTool, "/extensions/pi-fabric/index.ts"),
      registered(customTool, "/extensions/pi-deploy/index.ts"),
      registered(readOverride, "/extensions/pi-preview/index.ts"),
    );
    const catalog = new CapturedToolCatalog();
    const controller = await installRegisteredToolCapture({
      anchorDefinition: fabricTool,
      catalog,
    });
    controllers.push(controller);

    expect(runner.getAllRegisteredTools().map((entry) => entry.definition.name)).toEqual([
      "fabric_exec",
      "read",
    ]);
    expect(catalog.list().map((entry) => entry.name)).toEqual(["deploy_release", "read"]);
    expect(catalog.require("deploy_release").risk).toBe("execute");
    expect(catalog.require("read").risk).toBe("read");

    controller.dispose();
    expect(runner.getAllRegisteredTools().map((entry) => entry.definition.name)).toEqual([
      "fabric_exec",
      "deploy_release",
      "read",
    ]);
    expect(catalog.size).toBe(0);
  });

  it("does not attach to an unrelated tool with the Fabric tool name", async () => {
    const fabricTool = tool("fabric_exec");
    const collidingTool = tool("fabric_exec");
    const customTool = tool("custom_tool");
    const runner = runnerWith(
      registered(collidingTool, "/extensions/collision/index.ts"),
      registered(customTool, "/extensions/custom/index.ts"),
    );
    const catalog = new CapturedToolCatalog();
    const controller = await installRegisteredToolCapture({
      anchorDefinition: fabricTool,
      catalog,
    });
    controllers.push(controller);

    expect(runner.getAllRegisteredTools().map((entry) => entry.definition.name)).toEqual([
      "fabric_exec",
      "custom_tool",
    ]);
    expect(catalog.size).toBe(0);
  });

  it("updates dynamically and can leave captured tools visible", async () => {
    const fabricTool = tool("fabric_exec");
    const first = registered(tool("first_tool"), "/extensions/one/index.ts");
    const runner = runnerWith(registered(fabricTool, "/extensions/pi-fabric/index.ts"), first);
    const catalog = new CapturedToolCatalog();
    const controller = await installRegisteredToolCapture({
      anchorDefinition: fabricTool,
      catalog,
    });
    controllers.push(controller);

    runner.getAllRegisteredTools();
    const extension = (
      runner as unknown as { extensions: Array<{ tools: Map<string, RegisteredTool> }> }
    ).extensions[0];
    const second = registered(tool("second_tool"), "/extensions/two/index.ts");
    extension?.tools.set(second.definition.name, second);
    expect(runner.getAllRegisteredTools().map((entry) => entry.definition.name)).toEqual([
      "fabric_exec",
    ]);
    expect(catalog.list().map((entry) => entry.name)).toEqual(["first_tool", "second_tool"]);

    controller.setPolicy({
      ...structuredClone(DEFAULT_FABRIC_CONFIG.capture),
      hideFromModel: false,
    });
    expect(runner.getAllRegisteredTools().map((entry) => entry.definition.name)).toEqual([
      "fabric_exec",
      "first_tool",
      "second_tool",
    ]);

    controller.setPolicy(
      effectiveToolCaptureConfig({
        fullCodeMode: false,
        capture: DEFAULT_FABRIC_CONFIG.capture,
      }),
    );
    expect(catalog.size).toBe(0);
    expect(runner.getAllRegisteredTools().map((entry) => entry.definition.name)).toEqual([
      "fabric_exec",
      "first_tool",
      "second_tool",
    ]);
  });
});
