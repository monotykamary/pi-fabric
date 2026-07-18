import { createHash } from "node:crypto";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { initHighlighting } from "../src/ui/highlight.js";
import {
  compactProgressPreview,
  detectStringBackedWriteCalls,
  detectStringBackedWriteCallsFromArgs,
  modelReadHint,
  nestedCallTitle,
  nestedEditDiff,
  renderBoundedLines,
  renderFabricMulticallPartial,
  renderWriteCallPreviewBlock,
  renderWriteContentLines,
  restoreLegacyBashCommands,
  writeContentBodyLines,
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

  it("detects string-backed pi.write calls", () => {
    const calls = detectStringBackedWriteCalls(
      `return Promise.all([
  pi.write({ path: "README.md", text: π.readme }),
  pi.write({ file: 'docs/a.md', content: π.a }),
  pi.write({ dir: "x", contents: π["b"] }),
]);`,
    );
    expect(calls).toEqual([
      { path: "README.md", key: "readme" },
      { path: "docs/a.md", key: "a" },
      { path: "x", key: "b" },
    ]);
  });

  it("ignores computed paths or text in pi.write calls", () => {
    const calls = detectStringBackedWriteCalls(
      `pi.write({ path, text: π.x });
pi.write({ path: p, text: build() });
pi.write({ path: "y.md", text: "inline" });`,
    );
    expect(calls).toEqual([]);
  });

  it("caches detection by the fabric_exec args object", () => {
    const args = { code: `pi.write({ path: "a.md", text: π.a });` };
    expect(detectStringBackedWriteCallsFromArgs(args)).toEqual([{ path: "a.md", key: "a" }]);
    const first = detectStringBackedWriteCallsFromArgs(args);
    expect(detectStringBackedWriteCallsFromArgs(args)).toBe(first);
    expect(detectStringBackedWriteCallsFromArgs({})).toEqual([]);
  });

  it("returns null for write content with no resolvable language", () => {
    expect(renderWriteContentLines("hello", "notes.unknownext", 10, plainTheme)).toBeNull();
  });

  it("renders numbered highlighted write content for a known language", async () => {
    await initHighlighting("dark-plus", true);
    const rendered = renderWriteContentLines("# Title\nbody", "README.md", 10, plainTheme);
    expect(rendered).not.toBeNull();
    expect(rendered!.lines[0]!.startsWith("  1 ")).toBe(true);
    expect(rendered!.lines[0]).toContain("#");
    expect(rendered!.lines[0]).toContain("\x1b[38;2;");
    expect(rendered!.hidden).toBe(0);
  }, 15_000);

  it("falls back to plain toolOutput lines when highlighting is disabled", async () => {
    await initHighlighting("dark-plus", false);
    const rendered = renderWriteContentLines("# Title", "README.md", 10, plainTheme);
    expect(rendered).not.toBeNull();
    expect(rendered!.lines[0]!.startsWith("  1 ")).toBe(true);
    expect(rendered!.lines[0]).toContain("# Title");
    expect(rendered!.lines[0]).not.toContain("\x1b[38;2;");
    await initHighlighting("dark-plus", true);
  });

  it("limits write content lines and reports the hidden count", async () => {
    await initHighlighting("dark-plus", true);
    const content = Array.from({ length: 5 }, (_, i) => `line ${i + 1}`).join("\n");
    const rendered = renderWriteContentLines(content, "README.md", 2, plainTheme);
    expect(rendered).not.toBeNull();
    expect(rendered!.lines).toHaveLength(2);
    expect(rendered!.hidden).toBe(3);
  }, 15_000);

  it("renders a write call preview block with content and metadata", async () => {
    await initHighlighting("dark-plus", true);
    const block = renderWriteCallPreviewBlock("README.md", "# Hi\nbody line", true, 10, plainTheme);
    expect(block).toContain("write README.md");
    expect(block).toContain("2 lines");
    expect(block).toContain("markdown");
    expect(block.split("\n")[1]!.startsWith("  1 ")).toBe(true);
  }, 15_000);

  it("renders a write call preview header + hidden hint when content is disabled", () => {
    const block = renderWriteCallPreviewBlock("README.md", "# Hi", false, 10, plainTheme);
    expect(block).toContain("write README.md");
    expect(block).toContain("hidden");
    expect(block).not.toContain("  1 ");
  });

  it("returns body lines for write audits and empty for other tools", () => {
    const writeAudit = { ref: "pi.write", tool: "write", args: { path: "a.md", content: "# x\ny" } };
    const readAudit = { ref: "pi.read", tool: "read", args: { path: "a.md" } };
    expect(writeContentBodyLines(writeAudit as never, 10, plainTheme).length).toBeGreaterThan(0);
    expect(writeContentBodyLines(readAudit as never, 10, plainTheme)).toEqual([]);
  });

  it("shows nested write content during a multicall partial", async () => {
    await initHighlighting("dark-plus", true);
    const audits = [
      { ref: "pi.write", tool: "write", args: { path: "README.md", content: "# title\nbody" } },
      { ref: "pi.write", tool: "write", args: { path: "docs/a.md", content: "hello" } },
    ];
    const lines = renderFabricMulticallPartial(
      { audits, phases: [], expanded: false, writeContentPreview: true, writeCollapsedLines: 10 },
      plainTheme,
    ).render(120);
    expect(lines.some((l) => l.includes("write README.md"))).toBe(true);
    expect(lines.some((l) => l.includes("title"))).toBe(true);
    expect(lines.some((l) => l.includes("write docs/a.md"))).toBe(true);
  }, 15_000);
});
