import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { buildFabricSettingsItems, FabricSettingsComponent } from "../src/ui/settings.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const borderLine = (width: number): string => "─".repeat(width);

const buildItems = (keepVisibleCandidates: string[] = ["fabric_exec"]) =>
  buildFabricSettingsItems(theme, DEFAULT_FABRIC_CONFIG, () => {}, { keepVisibleCandidates });

describe("FabricSettingsComponent", () => {
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
      "Mesh",
    ]) {
      expect(lines).toContain(label);
    }
    expect(items.length).toBe(8);
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
});
