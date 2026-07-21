import { describe, expect, it, vi } from "vitest";
import {
  configureHighlighting,
  highlightCode,
  initHighlighting,
  languageFromPath,
} from "../src/ui/highlight.js";

describe("fabric highlight", () => {
  it("detects shiki languages from file paths", () => {
    expect(languageFromPath("src/index.ts")).toBe("typescript");
    expect(languageFromPath("README.md")).toBe("markdown");
    expect(languageFromPath("data.json")).toBe("json");
    expect(languageFromPath("scripts/run.sh")).toBe("bash");
    expect(languageFromPath("Dockerfile")).toBe("dockerfile");
    expect(languageFromPath("unknown.zzz")).toBeUndefined();
  });

  it("returns null before the highlighter is ready", () => {
    expect(highlightCode("const x = 1;", "typescript")).toBeNull();
  });

  it("invalidates through highlighter readiness and on-demand language loading", async () => {
    configureHighlighting("dark-plus", false);
    configureHighlighting("dark-plus", true);
    const invalidate = vi.fn();

    expect(highlightCode("value = True", "python", invalidate)).toBeNull();
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1), { timeout: 15_000 });
    expect(highlightCode("value = True", "python", invalidate)).toBeNull();
    await vi.waitFor(() => expect(invalidate.mock.calls.length).toBeGreaterThanOrEqual(2), {
      timeout: 15_000,
    });
    expect(highlightCode("value = True", "python", invalidate)?.join("\n")).toContain("\x1b[38;2;");
  }, 20_000);

  it("highlights code with truecolor ANSI after initialization", async () => {
    await initHighlighting("dark-plus", true);
    const lines = highlightCode("const x = 1;", "typescript");
    expect(lines).not.toBeNull();
    expect(Array.isArray(lines)).toBe(true);
    expect(lines!.length).toBe(1);
    // shiki emits 24-bit RGB foreground escapes for themed tokens.
    expect(lines![0]).toContain("\x1b[38;2;");

    const yaml = highlightCode("findings:\n  - severity: high", "yaml");
    expect(yaml).not.toBeNull();
    expect(yaml).toHaveLength(2);
    expect(yaml![1]).toContain("\x1b[38;2;");
  }, 15_000);

  it("falls back to null for unsupported languages", async () => {
    await initHighlighting("dark-plus", true);
    expect(highlightCode("hello", "totally-not-a-language")).toBeNull();
  });

  it("returns null when highlighting is disabled", async () => {
    await initHighlighting("dark-plus", false);
    expect(highlightCode("const x = 1;", "typescript")).toBeNull();
    await initHighlighting("dark-plus", true);
  }, 15_000);
});
