import {
  createSyntheticSourceInfo,
  defineTool,
  type ExtensionAPI,
  type ExtensionRunner,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { CapturedToolCatalog } from "../src/capture/catalog.js";
import { coreOverridePromptGuidance } from "../src/core/core-override-guidance.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { FabricState } from "../src/fabric-state.js";

const runner = {
  createContext: () => ({ cwd: process.cwd() }),
  getActiveTools: () => [],
} as unknown as ExtensionRunner;

const captured = (name: string, snippet?: string, guidelines?: string[]) => defineTool({
  name,
  label: name,
  description: `${name} override`,
  ...(snippet !== undefined ? { promptSnippet: snippet } : {}),
  ...(guidelines !== undefined ? { promptGuidelines: guidelines } : {}),
  parameters: Type.Object({ value: Type.Optional(Type.String()) }),
  async execute() {
    return { content: [{ type: "text" as const, text: "ok" }], details: {} };
  },
});

describe("core override prompt guidance", () => {
  it("keeps authored metadata under the pi identity and ignores other captured tools", () => {
    const catalog = new CapturedToolCatalog();
    catalog.replace(
      [
        {
          definition: captured("read", "structure-aware reads", ["Prefer symbol IDs when available."]),
          sourceInfo: createSyntheticSourceInfo("/extensions/organon/index.ts", { source: "test" }),
        },
        {
          definition: captured("deploy", "not a core slot", ["Do not advertise this here."]),
          sourceInfo: createSyntheticSourceInfo("/extensions/deploy/index.ts", { source: "test" }),
        },
      ],
      runner,
      DEFAULT_FABRIC_CONFIG.capture,
      "/extensions/pi-fabric/index.ts",
    );

    const guidance = coreOverridePromptGuidance(catalog);
    expect(guidance).toContain("pi.read");
    expect(guidance).toContain("structure-aware reads");
    expect(guidance).toContain("Prefer symbol IDs when available.");
    expect(guidance).not.toContain("deploy");
    expect(guidance).not.toContain("extensions.read");
  });

  it("tracks replacement and removal without persisted prompt state", () => {
    const catalog = new CapturedToolCatalog();
    const replace = (snippet: string) => catalog.replace(
      [{
        definition: captured("edit", snippet),
        sourceInfo: createSyntheticSourceInfo("/extensions/editor/index.ts", { source: "test" }),
      }],
      runner,
      DEFAULT_FABRIC_CONFIG.capture,
      "/extensions/pi-fabric/index.ts",
    );

    replace("first effective schema");
    expect(coreOverridePromptGuidance(catalog)).toContain("first effective schema");
    replace("replacement effective schema");
    expect(coreOverridePromptGuidance(catalog)).toContain("replacement effective schema");
    expect(coreOverridePromptGuidance(catalog)).not.toContain("first effective schema");
    catalog.clear();
    expect(coreOverridePromptGuidance(catalog)).toBe("");
  });


  it("adds the live override guidance to the full-code before-agent prompt", async () => {
    const handlers = new Map<string, Array<(event: unknown, context: unknown) => unknown>>();
    const pi = {
      events: { emit: vi.fn(), on: vi.fn(() => () => {}) },
      getActiveTools: vi.fn(() => ["fabric_exec"]),
      getAllTools: vi.fn(() => []),
      on: vi.fn((event: string, handler: (event: unknown, context: unknown) => unknown) => {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      }),
      registerCommand: vi.fn(),
      registerTool: vi.fn(),
      setActiveTools: vi.fn(),
    } as unknown as ExtensionAPI;
    const fakeEntry = {
      name: "read",
      definition: {
        promptSnippet: "structure-aware reads",
        promptGuidelines: ["Prefer symbol IDs when available."],
      },
    };
    const get = vi.spyOn(CapturedToolCatalog.prototype, "get")
      .mockImplementation((name) => name === "read" ? fakeEntry as never : undefined);
    try {
      const { default: piFabric } = await import("../src/index.js");
      await piFabric(pi);
      const handler = handlers.get("before_agent_start")?.[0];
      if (!handler) throw new Error("before_agent_start handler was not registered");
      const result = await handler({
        systemPrompt: "base system",
        prompt: "inspect source",
        systemPromptOptions: { skills: [] },
      }, {});
      const prompt = (result as { systemPrompt: string }).systemPrompt;
      expect(prompt).toContain("pi.read");
      expect(prompt).toContain("structure-aware reads");
      expect(prompt).toContain("Prefer symbol IDs when available.");
      expect(prompt).not.toContain("extensions.read");

      const enforceConfig = structuredClone(DEFAULT_FABRIC_CONFIG);
      enforceConfig.fullCodeMode = false;
      enforceConfig.schema.mode = "enforce";
      const cwd = vi.spyOn(FabricState.prototype, "cwd", "get").mockReturnValue("/tmp");
      const config = vi.spyOn(FabricState.prototype, "config", "get").mockReturnValue(enforceConfig);
      try {
        const enforcedResult = await handler({
          systemPrompt: "base system",
          prompt: "inspect source",
          systemPromptOptions: { skills: [] },
        }, {});
        const enforcedPrompt = (enforcedResult as { systemPrompt: string }).systemPrompt;
        expect(enforcedPrompt).toContain("structure-aware reads");
        expect(enforcedPrompt).toContain("Prefer symbol IDs when available.");
        expect(enforcedPrompt).not.toContain("extensions.read");
      } finally {
        config.mockRestore();
        cwd.mockRestore();
      }
    } finally {
      get.mockRestore();
    }
  });

  it("adds no prose when an override has no prompt metadata", () => {
    const catalog = new CapturedToolCatalog();
    catalog.replace(
      [{
        definition: captured("read"),
        sourceInfo: createSyntheticSourceInfo("/extensions/reader/index.ts", { source: "test" }),
      }],
      runner,
      DEFAULT_FABRIC_CONFIG.capture,
      "/extensions/pi-fabric/index.ts",
    );
    expect(coreOverridePromptGuidance(catalog)).toBe("");
  });
});
