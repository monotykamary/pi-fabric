import { describe, expect, it, vi, beforeEach } from "vitest";

// Faithful host-loader regression for issue #46.
//
// In Pi's extension host, shiki's internal lazy `import("@shikijs/themes/<id>)`
// (invoked when createHighlighter is handed a bare theme *id string*) fails to
// resolve, so previews fall to plain text. The fix resolves the theme object
// from pi-fabric's own module graph and hands createHighlighter the *object*,
// so shiki never performs that host-fragile subpath import.
//
// This mock reproduces the host failure: createHighlighter throws the exact
// module-resolution error when it receives a string theme id, and succeeds
// when it receives a resolved theme object.

const createHighlighterMock = vi.fn();

vi.mock("shiki", () => ({
  createHighlighter: (options: unknown) => createHighlighterMock(options),
}));

vi.mock("@shikijs/themes/dark-plus", () => ({
  default: { name: "dark-plus", type: "dark", colors: {} },
}));

import {
  configureHighlighting,
  highlightCode,
  initHighlighting,
} from "../src/ui/highlight.js";
import { resolveShikiThemeObject } from "../src/ui/shiki-theme.js";

beforeEach(() => {
  createHighlighterMock.mockReset();
  createHighlighterMock.mockImplementation(async (options: {
    themes: unknown[];
    langs: unknown[];
  }) => {
    const first = options.themes[0];
    if (typeof first === "string") {
      // Simulates Pi's extension host failing on shiki's internal lazy
      // `import("@shikijs/themes/<id>)` subpath resolution.
      throw new Error(
        "Cannot find module '@shikijs/themes/dark-plus' from '.../shiki/dist/themes.mjs'",
      );
    }
    return {
      dispose: () => {},
      codeToHtml: () => "<span>highlighted</span>",
      codeToTokens: () => ({ tokens: [] }),
      // highlightCode calls codeToTokensBase directly; without it the mock
      // silently fell into the catch-all plain-text path and the assertions
      // below only passed through an unrelated double-init import race.
      codeToTokensBase: (text: string) =>
        text.split("\n").map((line: string) => [{ content: line, color: "#cccccc" }]),
    };
  });
});

describe("shiki host-loader theme resolution (#46)", () => {
  it("hands createHighlighter a resolved theme object, never a bare id string", async () => {
    configureHighlighting("dark-plus", true);
    await initHighlighting("dark-plus", true);

    expect(createHighlighterMock).toHaveBeenCalledTimes(1);
    const options = createHighlighterMock.mock.calls[0]?.[0] as {
      themes: unknown[];
      langs: unknown[];
    };
    const firstTheme = options.themes[0];
    expect(typeof firstTheme).toBe("object");
    expect((firstTheme as { name: string }).name).toBe("dark-plus");
    expect(options.langs).toHaveLength(10);
    expect(options.langs.every((language) => typeof language === "object")).toBe(true);
  });

  it("initializes a working highlighter under the host-loader failure mode", async () => {
    configureHighlighting("dark-plus", true);
    await initHighlighting("dark-plus", true);

    // With the theme resolved as an object, initialization must not fall into
    // the plain-text catch path, so previews render.
    const lines = highlightCode("const x = 1;", "typescript");
    expect(lines).not.toBeNull();
  });

  it("resolves a bundled theme id to its object from pi-fabric's module graph", async () => {
    const theme = await resolveShikiThemeObject("dark-plus");
    expect(theme).toBeDefined();
    expect(theme!.name).toBe("dark-plus");
  });

  it("returns undefined for an unknown theme id so callers fall back gracefully", async () => {
    expect(await resolveShikiThemeObject("not-a-real-theme")).toBeUndefined();
  });
});
