import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const loads = vi.hoisted(() => vi.fn());
vi.mock("node:module", async original => {
  const actual = await original<typeof import("node:module")>();
  return { ...actual, createRequire: (base: string | URL) => {
    const require = actual.createRequire(base);
    return Object.assign((id: string) => { loads(id); return require(id); }, require);
  } };
});
beforeEach(() => { vi.resetModules(); loads.mockReset(); });

describe("optional preview startup", () => {
  it("formats explicit YAML when native require cannot resolve the package name", async () => {
    loads.mockImplementation((id: string) => {
      if (id === "yaml") throw new Error("Cannot find package 'yaml'");
    });
    const structured = await import("../src/ui/structured.js");
    expect(structured.formatFabricValue({ ok: true, answer: 6 * 7 }, "yaml")).toEqual({
      text: "ok: true\nanswer: 42",
      language: "yaml",
    });
  });

  it("keeps catalogs, serialization, and Python parsing out of import and configuration", async () => {
    const highlight = await import("../src/ui/highlight.js");
    const structured = await import("../src/ui/structured.js");
    const parser = await import("../src/ui/fabric-code-parser.js");
    highlight.configureHighlighting("auto", true);
    expect(structured.formatFabricValue("plain", "auto").text).toBe("plain");
    expect(parser.fabricExecTitleHint('return "hello";', "typescript")).toBeUndefined();
    expect(loads).not.toHaveBeenCalled();
  });

  it("loads synchronous preview dependencies once, on the first relevant use", async () => {
    const highlight = await import("../src/ui/highlight.js");
    const structured = await import("../src/ui/structured.js");
    const parser = await import("../src/ui/fabric-code-parser.js");
    expect(highlight.languageFromPath("main.py")).toBe("python");
    expect(highlight.languageFromPath("main.ts")).toBe("typescript");
    highlight.configureHighlighting("github-light", true);
    expect(highlight.effectiveShikiThemeIsLight()).toBe(true);
    expect(highlight.effectiveShikiThemeIsLight()).toBe(true);
    expect(structured.formatJsonAsYaml({ ok: true })).toBe("ok: true");
    expect(structured.formatJsonAsYaml({ ok: false })).toBe("ok: false");
    expect(parser.fabricExecTitleHint('await pi.read({"path": "example.py"})', "python")).toBeTruthy();
    parser.fabricExecTitleHint('await pi.read({"path": "other.py"})', "python");
    expect(loads.mock.calls.map(([id]) => id).sort()).toEqual([
      "@lezer/python", "shiki/langs", "shiki/themes", fileURLToPath(import.meta.resolve("yaml")),
    ].sort());
  });
});
