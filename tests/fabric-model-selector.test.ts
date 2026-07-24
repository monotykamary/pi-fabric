import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { FabricModelSelector } from "../src/ui/fabric-model-selector.js";
import { INHERIT_VALUE, type ModelSource } from "../src/ui/model-picker.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const source: ModelSource = {
  models: [
    { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    { provider: "openai", id: "gpt-5.5", name: "GPT 5.5" },
  ],
  lastUsed: { "anthropic/claude-sonnet-4-5": 200, "openai/gpt-5.5": 100 },
};

const render = (component: FabricModelSelector): string => component.render(80).join("\n");

describe("FabricModelSelector", () => {
  it("renders the Inherit row plus every model, Inherit pinned on top", () => {
    const component = new FabricModelSelector({
      theme,
      source,
      currentValue: INHERIT_VALUE,
      onSelect: () => {},
      onCancel: () => {},
    });
    const text = render(component);
    const inheritIndex = text.indexOf("Inherit");
    const claudeIndex = text.indexOf("claude-sonnet-4-5");
    const gptIndex = text.indexOf("gpt-5.5");
    expect(text).toContain("Inherit");
    expect(text).toContain("claude-sonnet-4-5");
    expect(text).toContain("gpt-5.5");
    expect(inheritIndex).toBeLessThan(claudeIndex);
    expect(claudeIndex).toBeLessThan(gptIndex);
  });

  it("marks the configured model with a checkmark and shows its name in the footer", () => {
    const component = new FabricModelSelector({
      theme,
      source,
      currentValue: "anthropic/claude-sonnet-4-5",
      onSelect: () => {},
      onCancel: () => {},
    });
    const text = render(component);
    expect(text).toContain("\u2713");
    expect(text).toContain("Model Name: Claude Sonnet 4.5");
  });

  it("sorts by pi-model-sort recency with the current model first after Inherit", () => {
    const component = new FabricModelSelector({
      theme,
      source,
      currentValue: "openai/gpt-5.5",
      onSelect: () => {},
      onCancel: () => {},
    });
    const text = render(component);
    expect(text.indexOf("Inherit")).toBeLessThan(text.indexOf("gpt-5.5"));
    expect(text.indexOf("gpt-5.5")).toBeLessThan(text.indexOf("claude-sonnet-4-5"));
  });

  it("selects a model on Enter and reports its canonical value", () => {
    let selected: string | undefined;
    const component = new FabricModelSelector({
      theme,
      source,
      currentValue: INHERIT_VALUE,
      onSelect: (value) => {
        selected = value;
      },
      onCancel: () => {},
    });
    component.handleInput("\x1b[B");
    component.handleInput("\r");
    expect(selected).toBe("anthropic/claude-sonnet-4-5");
  });

  it("can pick Inherit when it is selected", () => {
    let selected: string | undefined;
    const component = new FabricModelSelector({
      theme,
      source,
      currentValue: "anthropic/claude-sonnet-4-5",
      onSelect: (value) => {
        selected = value;
      },
      onCancel: () => {},
    });
    component.handleInput("\x1b[A");
    component.handleInput("\r");
    expect(selected).toBe(INHERIT_VALUE);
  });

  it("filters by search and re-sorts by recency", () => {
    const component = new FabricModelSelector({
      theme,
      source,
      currentValue: INHERIT_VALUE,
      onSelect: () => {},
      onCancel: () => {},
    });
    component.handleInput("g");
    component.handleInput("p");
    component.handleInput("t");
    const text = render(component);
    expect(text).toContain("gpt-5.5");
    expect(text).not.toContain("claude-sonnet-4-5");
    // The Inherit row is filtered out; only the hint line still mentions it.
    expect(text).not.toContain("→ Inherit");
  });

  it("cancels on Escape", () => {
    let cancelled = false;
    const component = new FabricModelSelector({
      theme,
      source,
      currentValue: INHERIT_VALUE,
      onSelect: () => {},
      onCancel: () => {
        cancelled = true;
      },
    });
    component.handleInput("\x1b");
    expect(cancelled).toBe(true);
  });

  it("uses custom headerText and inheritName when provided", () => {
    const component = new FabricModelSelector({
      theme,
      source,
      currentValue: INHERIT_VALUE,
      headerText: 'Model for actor "reviewer". Pick Inherit to use the Fabric default.',
      inheritName: "Use the Fabric default model (or host default)",
      onSelect: () => {},
      onCancel: () => {},
    });
    const text = render(component);
    expect(text).toContain('Model for actor "reviewer". Pick Inherit to use the Fabric default.');
    // The Inherit row's footer name reflects the custom inherit description.
    expect(text).toContain("Use the Fabric default model (or host default)");
    // The default global wording is no longer present.
    expect(text).not.toContain("Default model for Fabric agents and actors");
    expect(text).not.toContain("Use the host session's default model");
  });

  it("supports a custom unset-row label without changing its sentinel value", () => {
    let selected: string | undefined;
    const component = new FabricModelSelector({
      theme,
      source,
      currentValue: INHERIT_VALUE,
      inheritLabel: "Ask each time",
      onSelect: (value) => {
        selected = value;
      },
      onCancel: () => {},
    });

    const text = render(component);
    expect(text).toContain("Ask each time ✓");
    component.handleInput("\r");
    expect(selected).toBe(INHERIT_VALUE);
  });

  it("defaults to the global wording when headerText/inheritName are omitted", () => {
    const component = new FabricModelSelector({
      theme,
      source,
      currentValue: INHERIT_VALUE,
      onSelect: () => {},
      onCancel: () => {},
    });
    const text = render(component);
    expect(text).toContain("Default model for Fabric agents and actors");
    expect(text).toContain("Use the host session's default model");
  });
});
