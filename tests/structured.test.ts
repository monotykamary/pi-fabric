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

describe("multi-line string fidelity", () => {
  // A multi-line string nested in a returned object must reach the model with
  // its exact bytes. YAML literal block scalars indent every content line, so
  // text transcribed from the display (e.g. into pi.edit oldText) does not
  // match the file on disk.
  const file = "function x() {\n    stopLoader();\n        deep();\n}";

  it("hoists multi-line strings so content keeps its exact bytes", () => {
    const formatted = formatFabricValue({ content: file }, "auto");
    // content appears verbatim: 4-space and 8-space indents intact
    expect(formatted.text).toContain("\n    stopLoader();\n");
    expect(formatted.text).toContain("\n        deep();\n");
    // never as a re-indented YAML block scalar
    expect(formatted.text).not.toContain("      stopLoader();");
    expect(formatted.text).not.toMatch(/\|\d?-/);
  });

  it("labels hoisted sections with their value path", () => {
    const formatted = formatFabricValue(
      { results: ["one\ntwo", { note: "a\nb" }] },
      "auto",
    );
    expect(formatted.text).toContain("results[0]");
    expect(formatted.text).toContain("results[1].note");
    expect(formatted.text).toContain("one\ntwo");
    expect(formatted.text).toContain("a\nb");
  });

  it("keeps single-line strings inline in the YAML skeleton", () => {
    const formatted = formatFabricValue({ a: "x", b: 1 }, "auto");
    expect(formatted).toEqual({ text: "a: x\nb: 1", language: "yaml" });
  });

  it("drops the yaml language tag when raw sections are appended", () => {
    const formatted = formatFabricValue({ content: file }, "auto");
    expect(formatted.language).toBeUndefined();
  });
});
