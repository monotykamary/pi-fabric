import { describe, expect, it } from "vitest";
import { formatFabricValue } from "../src/ui/structured.js";

describe("formatFabricValue", () => {
  const value = { status: "completed", findings: [{ fixed: true }] };

  it("formats structured auto results as YAML", () => {
    const formatted = formatFabricValue(value, "auto");
    expect(formatted.language).toBe("yaml");
    expect(formatted.text).toContain("status: completed");
    expect(formatted.text).toContain("- fixed: true");
    expect(formatted.text).not.toContain("{\n");
  });

  it("preserves explicit JSON and text modes", () => {
    expect(formatFabricValue(value, "json")).toEqual({
      text: JSON.stringify(value, null, 2),
      language: "json",
    });
    expect(formatFabricValue({ text: "plain result", metadata: true }, "text")).toEqual({
      text: "plain result",
    });
  });

  it("keeps string values unchanged in auto mode", () => {
    expect(formatFabricValue("already textual", "auto")).toEqual({ text: "already textual" });
  });
});
