import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  buildFabricSettingsItems,
  executorMemoryLimitOptions,
  FabricSettingsComponent,
  parseBudgetValue,
} from "../src/ui/settings.js";
import type { ModelSource } from "../src/ui/model-picker.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const borderLine = (width: number): string => "─".repeat(width);

const fakeModelSource: ModelSource = {
  models: [
    { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    { provider: "openai", id: "gpt-5.5", name: "GPT 5.5" },
  ],
  lastUsed: { "anthropic/claude-sonnet-4-5": 200, "openai/gpt-5.5": 100 },
};

const buildItems = (keepVisibleCandidates: string[] = ["fabric_exec"]) =>
  buildFabricSettingsItems(theme, DEFAULT_FABRIC_CONFIG, () => {}, {
    keepVisibleCandidates,
    modelSource: fakeModelSource,
  });

describe("FabricSettingsComponent", () => {
  it("offers executor memory limits through the machine capacity", () => {
    const machineCapacity = 24 * 1024 * 1024 * 1024;
    const values = executorMemoryLimitOptions(machineCapacity);

    expect(values).toContain(512 * 1024 * 1024);
    expect(values.at(-1)).toBe(machineCapacity);
  });

  it("renders the pi-core style top and bottom borders with search", () => {
    const component = new FabricSettingsComponent(theme, buildItems(), () => {}, () => {});
    const lines = component.render(80);

    expect(lines[0]).toBe(borderLine(80));
    expect(lines[lines.length - 1]).toBe(borderLine(80));
    expect(lines.some((line) => line.includes("Type to search"))).toBe(true);
    expect(lines.some((line) => line.includes("Full code mode"))).toBe(true);
    expect(lines.some((line) => line.includes("Executor"))).toBe(true);
  });

  it("renders every section", () => {
    const items = buildItems();
    const component = new FabricSettingsComponent(theme, items, () => {}, () => {});
    const lines = component.render(80).join("\n");

    for (const label of [
      "Full code mode",
      "Executor",
      "Approvals",
      "MCP",
      "Subagents",
      "Capture",
      "UI",
      "Compaction",
      "Mesh",
    ]) {
      expect(lines).toContain(label);
    }
    expect(items.length).toBe(9);
  });

  it("marks submenu rows with a drill-in marker and leaves inline toggles plain", () => {
    const items = buildItems();
    const labels = items.map((item) => item.label);
    // Top-level sections open a submenu.
    expect(labels).toContain("Executor ›");
    expect(labels).toContain("Subagents ›");
    // Full code mode cycles values inline; no drill-in marker.
    expect(labels).toContain("Full code mode");
    expect(labels).not.toContain("Full code mode ›");

    // Inside a section, submenu fields are marked but inline value toggles are not.
    const subagents = items.find((item) => item.id === "subagents")!;
    const lines = subagents.submenu!("", () => {}).render(80).join("\n");
    expect(lines).toContain("Default model ›");
    expect(lines).toContain("Max concurrent ›");
    expect(lines).toContain("Default tools ›");
    // Inline value-cycle rows stay plain.
    expect(lines).toContain("Transport");
    expect(lines).not.toContain("Transport ›");
    expect(lines).toContain("Enabled");
    expect(lines).not.toContain("Enabled ›");
  });

  it("opening a section submenu renders its fields", () => {
    const items = buildItems();
    const executor = items.find((item) => item.id === "executor");
    expect(executor?.submenu).toBeDefined();
    const submenu = executor!.submenu!("", () => {});
    const lines = submenu.render(80).join("\n");
    expect(lines).toContain("Timeout");
    expect(lines).toContain("Memory limit");
    expect(lines).toContain("Max output chars");
    expect(lines).toContain("Result format");
    expect(lines).toContain("auto");
  });

  it("exposes the compaction engine", () => {
    const items = buildItems();
    const compaction = items.find((item) => item.id === "compaction");
    expect(compaction?.currentValue).toBe("fabric");
    const lines = compaction!.submenu!("", () => {}).render(80).join("\n");
    expect(lines).toContain("Engine");
    expect(lines).toContain("fabric");
  });

  it("surfaces nested-tool visibility and the global debounce in UI settings", () => {
    const items = buildItems();
    const ui = items.find((item) => item.id === "ui");
    expect(ui?.submenu).toBeDefined();
    const lines = ui!.submenu!("", () => {}).render(80).join("\n");
    expect(lines).toContain("Nested tool calls");
    expect(lines).toContain("Nested tool debounce");
    expect(lines).toContain("100ms");
  });

  it("surfaces the recursion budget in the Subagents section", () => {
    const items = buildItems();
    const subagents = items.find((item) => item.id === "subagents");
    expect(subagents?.submenu).toBeDefined();
    const lines = subagents!.submenu!("", () => {}).render(80).join("\n");
    expect(lines).toContain("Recursion budget");
    expect(lines).toContain("Off");
  });

  it("shows the configured budget as a currency value", () => {
    const items = buildFabricSettingsItems(
      theme,
      { ...DEFAULT_FABRIC_CONFIG, subagents: { ...DEFAULT_FABRIC_CONFIG.subagents, budgetUsd: 0.25 } },
      () => {},
      { keepVisibleCandidates: ["fabric_exec"], modelSource: fakeModelSource },
    );
    const subagents = items.find((item) => item.id === "subagents")!;
    const lines = subagents.submenu!("", () => {}).render(80).join("\n");
    expect(lines).toContain("Recursion budget");
    expect(lines).toContain("$0.25");
  });

  it("parses currency-formatted budget values back to numbers", () => {
    expect(parseBudgetValue("$0.25")).toBe(0.25);
    expect(parseBudgetValue("$0.10")).toBe(0.1);
    expect(parseBudgetValue("Off")).toBe(0);
    expect(parseBudgetValue("0.5")).toBe(0.5);
    expect(parseBudgetValue("$5.00")).toBe(5);
  });

  it("surfaces the default thinking level in the Subagents section as Medium by default", () => {
    const items = buildItems();
    const subagents = items.find((item) => item.id === "subagents");
    expect(subagents?.submenu).toBeDefined();
    const lines = subagents!.submenu!("", () => {}).render(80).join("\n");
    expect(lines).toContain("Default thinking");
    expect(lines).toContain("Medium");
  });

  it("shows a configured thinking level in the Subagents section", () => {
    const items = buildFabricSettingsItems(
      theme,
      { ...DEFAULT_FABRIC_CONFIG, subagents: { ...DEFAULT_FABRIC_CONFIG.subagents, thinking: "high" } },
      () => {},
      { keepVisibleCandidates: ["fabric_exec"], modelSource: fakeModelSource },
    );
    const subagents = items.find((item) => item.id === "subagents")!;
    const lines = subagents.submenu!("", () => {}).render(80).join("\n");
    expect(lines).toContain("Default thinking");
    expect(lines).toContain("High");
  });

  it("surfaces the default model in the Subagents section as Inherit by default", () => {
    const items = buildItems();
    const subagents = items.find((item) => item.id === "subagents");
    expect(subagents?.submenu).toBeDefined();
    const lines = subagents!.submenu!("", () => {}).render(80).join("\n");
    expect(lines).toContain("Default model");
    expect(lines).toContain("Inherit");
  });

  it("shows the configured default model value in the Subagents section", () => {
    const items = buildFabricSettingsItems(
      theme,
      { ...DEFAULT_FABRIC_CONFIG, subagents: { ...DEFAULT_FABRIC_CONFIG.subagents, model: "claude-sonnet-4-5" } },
      () => {},
      { keepVisibleCandidates: ["fabric_exec"], modelSource: fakeModelSource },
    );
    const subagents = items.find((item) => item.id === "subagents")!;
    const lines = subagents.submenu!("", () => {}).render(80).join("\n");
    expect(lines).toContain("Default model");
    expect(lines).toContain("claude-sonnet-4-5");
    expect(lines).not.toContain("Default model ›      Inherit");
  });

  it("renders the list-editor rows with counts in their sections", () => {
    const items = buildItems(["fabric_exec", "custom-tool"]);
    const subagents = items.find((item) => item.id === "subagents")!;
    expect(subagents.submenu!("", () => {}).render(80).join("\n")).toContain("Default tools");
    expect(subagents.submenu!("", () => {}).render(80).join("\n")).toContain("7 tools");
    const capture = items.find((item) => item.id === "capture")!;
    const captureLines = capture.submenu!("", () => {}).render(80).join("\n");
    expect(captureLines).toContain("Keep visible");
    expect(captureLines).toContain("1 tool");
  });

  it("keep-visible candidates include existing entries plus fabric_exec", () => {
    const items = buildItems(["fabric_exec", "custom-tool"]);
    const capture = items.find((item) => item.id === "capture")!;
    const captureSub = capture.submenu!("", () => {});
    const lines = captureSub.render(80).join("\n");
    expect(lines).toContain("Keep visible");
  });

  it("surfaces the per-child token limit in the Subagents section", () => {
    const items = buildItems();
    const subagents = items.find((item) => item.id === "subagents");
    expect(subagents?.submenu).toBeDefined();
    const lines = subagents!.submenu!("", () => {}).render(80).join("\n");
    expect(lines).toContain("Token limit");
    expect(lines).toContain("Off");
  });

  it("shows a configured token limit formatted compactly", () => {
    const items = buildFabricSettingsItems(
      theme,
      { ...DEFAULT_FABRIC_CONFIG, subagents: { ...DEFAULT_FABRIC_CONFIG.subagents, maxTokensPerChild: 500_000 } },
      () => {},
      { keepVisibleCandidates: ["fabric_exec"], modelSource: fakeModelSource },
    );
    const subagents = items.find((item) => item.id === "subagents")!;
    const lines = subagents.submenu!("", () => {}).render(80).join("\n");
    expect(lines).toContain("Token limit");
    expect(lines).toContain("500k");
  });
});
