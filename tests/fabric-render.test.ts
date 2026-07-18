import { createHash } from "node:crypto";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { initHighlighting } from "../src/ui/highlight.js";
import {
  captureFabricWritePreviews,
  compactProgressPreview,
  fabricWriteBindings,
  modelReadHint,
  nestedCallBody,
  nestedCallCode,
  nestedCallTitle,
  nestedEditDiff,
  renderBoundedLines,
  renderFabricMulticallPartial,
  renderFabricWriteArgumentPreview,
  restoreFabricWritePreviews,
  restoreLegacyBashCommands,
} from "../src/ui/fabric-render.js";

const theme = {
  fg: (color: string, text: string) => `\x1b[${color}]${text}\x1b[0m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
} as unknown as Theme;

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

describe("fabric nested rendering", () => {
  it("renders a bash title with a $ prompt and a highlighted command", async () => {
    await initHighlighting("dark-plus", true);
    const title = nestedCallTitle(
      { ref: "pi.bash", tool: "bash", args: { command: "ls -la src/" } },
      theme,
    );
    expect(title).toContain("$");
    expect(title).toContain("src/");
    // shiki truecolor escapes wrap the command tokens
    expect(title).toContain("\x1b[38;2;");
  }, 15_000);

  it("restores legacy digest-only bash previews from visible Fabric arguments", () => {
    const literalCommand = "pnpm vitest run tests/fabric-render.test.ts";
    const namedCommand = "git status --short";
    const digest = (command: string): string =>
      `sha256:${createHash("sha256").update(command).digest("hex")}`;
    const restored = restoreLegacyBashCommands(
      [literalCommand, namedCommand].map((command) => ({
        ref: "pi.bash",
        provider: "pi",
        tool: "bash",
        args: { commandDigest: digest(command) },
      })),
      {
        code: `await pi.bash({ cmd: "${literalCommand}" });\nawait pi.bash({ cmd: π.script });`,
        strings: { script: namedCommand },
      },
    );

    expect(restored.map((audit) => audit.args)).toEqual([
      { command: literalCommand },
      { command: namedCommand },
    ]);
  });

  it("never renders an unrecoverable legacy command digest", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const [restored] = restoreLegacyBashCommands(
      [{ ref: "pi.bash", provider: "pi", tool: "bash", args: { commandDigest: digest } }],
      { code: "return true;" },
    );

    expect(restored?.args).toEqual({});
    const title = nestedCallTitle(restored!, plainTheme);
    expect(title).toBe("bash");
    expect(title).not.toContain("sha256:");
  });

  it("extracts π write bindings in source order", () => {
    const bindings = fabricWriteBindings(`
return Promise.all([
  pi.write({ path: "README.md", text: π.readme }),
  pi.write({ file: "docs/configuration.md", contents: π.configuration }),
  pi.write({ file_path: "docs/interface.md", content: π["interface"] }),
]);
`);

    expect(bindings).toEqual([
      { path: "README.md", stringKey: "readme" },
      { path: "docs/configuration.md", stringKey: "configuration" },
      { path: "docs/interface.md", stringKey: "interface" },
    ]);
  });

  it("renders a growing single π value during argument composition", () => {
    const streaming = renderFabricWriteArgumentPreview(
      {
        bindings: [{ path: "preview.unknown", stringKey: "preview" }],
        strings: { preview: "first line\nsecond line" },
        expanded: false,
      },
      plainTheme,
    )!.render(100);

    expect(streaming).toContain("first line");
    expect(streaming).toContain("second line");
  });

  it("streams only the latest π value in a multicall", () => {
    const composing = renderFabricWriteArgumentPreview(
      {
        bindings: [
          { path: "one.unknown", stringKey: "one" },
          { path: "two.unknown", stringKey: "two" },
          { path: "three.unknown", stringKey: "three" },
        ],
        strings: { one: "one complete", two: "two growing" },
        expanded: false,
      },
      plainTheme,
    )!.render(100);

    expect(composing[0]).toContain("Fabric composing · 1/3 writes");
    expect(composing).toContain("  two growing");
    expect(composing).not.toContain("one complete");
  });

  it("exposes in-flight write content for single-call previews", () => {
    const audit = {
      ref: "pi.write",
      provider: "pi",
      tool: "write",
      args: { path: "README.md", content: "# Fabric\n\nLive preview" },
    };

    expect(nestedCallBody(audit)).toBe("# Fabric\n\nLive preview");
    expect(nestedCallCode(audit)).toEqual({
      code: "# Fabric\n\nLive preview",
      lang: "markdown",
    });
  });

  it("falls back to plain in-flight write content for unknown file types", () => {
    const audit = {
      ref: "pi.write",
      provider: "pi",
      tool: "write",
      args: { path: "fixture.unknown", content: "first\nsecond" },
    };

    expect(nestedCallCode(audit)).toBeNull();
    expect(nestedCallBody(audit)).toBe("first\nsecond");
  });

  it("restores ephemeral write content after final trace projection", () => {
    const live = [
      {
        ref: "pi.write",
        provider: "pi",
        tool: "write",
        args: { path: "README.md", content: "# Cached preview" },
        success: true,
      },
    ];
    const previews = captureFabricWritePreviews(live);
    const restored = restoreFabricWritePreviews(
      [
        {
          ref: "pi.write",
          provider: "pi",
          tool: "write",
          args: { path: "README.md" },
          success: true,
        },
      ],
      previews,
    );

    expect(nestedCallBody(restored[0]!)).toBe("# Cached preview");
  });

  it("renders a write body while a multicall remains partial", () => {
    const lines = renderFabricMulticallPartial(
      {
        audits: [
          {
            ref: "pi.write",
            provider: "pi",
            tool: "write",
            args: { path: "one.md" },
            success: true,
          },
          {
            ref: "pi.write",
            provider: "pi",
            tool: "write",
            args: { path: "two.md" },
            success: true,
          },
          { ref: "pi.bash", provider: "pi", tool: "bash", args: { command: "sleep 1" } },
        ],
        phases: [],
        progress: "bash: waiting",
        expanded: false,
        preview: { auditIndex: 1, body: "# Two\nPreview body", hidden: 4 },
      },
      plainTheme,
    ).render(100);

    expect(lines).toContain("  # Two");
    expect(lines).toContain("  Preview body");
    expect(lines).toContain("  … 4 more lines");
  });

  it("renders in-flight agent names from invocation arguments", () => {
    const title = nestedCallTitle(
      {
        ref: "agents.run",
        provider: "agents",
        tool: "run",
        args: { name: "dashboard reviewer", task: "Review the dashboard" },
      },
      theme,
    );
    expect(title).toContain("dashboard reviewer");
  });

  it("returns null for non-edit calls and edits without operations", () => {
    expect(nestedEditDiff({ ref: "pi.read", tool: "read" }, theme)).toBeNull();
    expect(nestedEditDiff({ ref: "pi.edit", tool: "edit", args: { path: "a.ts" } }, theme)).toBeNull();
  });

  it("renders a plain +/- diff with context for unknown languages", () => {
    const lines = nestedEditDiff(
      {
        ref: "pi.edit",
        tool: "edit",
        args: {
          path: "notes.txt",
          edits: [
            { oldText: "const a = 1;\nconst b = 2;", newText: "const a = 1;\nconst b = 3;" },
          ],
        },
      },
      theme,
    );
    expect(lines).not.toBeNull();
    const joined = lines!.join("\n");
    expect(joined).toContain("const a = 1;");
    expect(joined).toContain("const b = 2;");
    expect(joined).toContain("const b = 3;");
    expect(joined).toContain("toolDiffContext");
    expect(joined).toContain("toolDiffRemoved");
    expect(joined).toContain("toolDiffAdded");
  });

  it("syntax-highlights edit diff content for known languages", async () => {
    await initHighlighting("dark-plus", true);
    const lines = nestedEditDiff(
      {
        ref: "pi.edit",
        tool: "edit",
        args: {
          path: "src/index.ts",
          edits: [{ oldText: "const x = 1;", newText: "const x = 2;" }],
        },
      },
      theme,
    );
    expect(lines).not.toBeNull();
    const joined = lines!.join("\n");
    expect(joined).toContain("toolDiffRemoved");
    expect(joined).toContain("toolDiffAdded");
    // shiki truecolor escapes on the highlighted code content
    expect(joined).toContain("\x1b[38;2;");
  }, 15_000);

  it("modelReadHint reports model lines vs read lines for a sliced read", () => {
    expect(
      modelReadHint(
        [{ ref: "pi.read", tool: "read", result: `a
b
c
d
e
f
g
h` }],
        `b
c
d`,
        theme,
      ),
    ).toContain("→ 3 of 8 lines to model");
  });

  it("modelReadHint is empty when the full read went to the model", () => {
    expect(modelReadHint([{ ref: "pi.read", tool: "read", result: `a
b
c` }], `x
y
z`, theme)).toBe("");
  });

  it("modelReadHint ignores non-read audits", () => {
    expect(modelReadHint([{ ref: "pi.bash", tool: "bash", result: `a
b
c
d
e
f` }], `a
b`, theme)).toBe("");
  });

  it("renders a generic extension tool's query argument", () => {
    const title = nestedCallTitle(
      { ref: "extensions.vcc_recall", provider: "extensions", tool: "vcc_recall", args: { query: "how do I recall X" } },
      theme,
    );
    expect(title).toContain("vcc_recall");
    expect(title).toContain("how do I recall X");
  });

  it("falls back to the first string arg for tools with unfamiliar keys", () => {
    const title = nestedCallTitle(
      { ref: "extensions.custom_search", provider: "extensions", tool: "custom_search", args: { haystack: "needle" } },
      theme,
    );
    expect(title).toContain("custom_search");
    expect(title).toContain("needle");
  });

  it("renders just the tool name when there is no string arg", () => {
    const title = nestedCallTitle(
      { ref: "extensions.no_args", provider: "extensions", tool: "no_args", args: { count: 3 } },
      theme,
    );
    expect(title).toContain("no_args");
    expect(title).not.toContain("3");
  });

  it("preserves the enclosing Box background when bounded rows are truncated", () => {
    const box = new Box(1, 0, (text) => "\x1b[42m" + text + "\x1b[49m");
    box.addChild(renderBoundedLines(["x".repeat(40)]));

    const line = box.render(20)[0]!;
    expect(line).toBe(
      "\x1b[42m " + "x".repeat(18) + "\x1b[22;23;24;27;29;39m \x1b[49m",
    );
    expect(visibleWidth(line)).toBe(20);
  });

  it("keeps multicall progress inline without adding completion-only rows", () => {
    const audits = [
      {
        ref: "pi.read",
        provider: "pi",
        tool: "read",
        args: { path: "src/index.ts" },
        success: true,
      },
      {
        ref: "pi.ls",
        provider: "pi",
        tool: "ls",
        args: { path: "src" },
      },
    ];
    const component = renderFabricMulticallPartial(
      {
        audits,
        phases: ["Inspect"],
        progress: "bash: one\ntwo\nthree\nfour",
        expanded: false,
      },
      plainTheme,
    );

    const wide = component.render(120);
    expect(wide).toHaveLength(4); // header + phase + two calls
    expect(wide[0]).toContain("… 3 lines · four");
    expect(wide.slice(1)).not.toContain("four");

    const narrow = component.render(24);
    expect(narrow).toHaveLength(wide.length);
    expect(narrow.every((line) => visibleWidth(line) <= 24)).toBe(true);
  });

  it("uses the completed-render call cap while a multicall is partial", () => {
    const audits = Array.from({ length: 12 }, (_, index) => ({
      ref: "pi.read",
      provider: "pi",
      tool: "read",
      args: { path: `file-${index}.ts` },
    }));
    const lines = renderFabricMulticallPartial(
      { audits, phases: [], progress: "Calling pi.read", expanded: false },
      plainTheme,
    ).render(100);

    expect(lines).toHaveLength(10); // header + eight calls + hidden marker
    expect(lines.at(-1)).toContain("4 nested calls hidden");
  });

  it("compacts multiline progress to its latest line", () => {
    expect(compactProgressPreview("one\ntwo\nthree")).toBe("… 2 lines · three");
  });
});
