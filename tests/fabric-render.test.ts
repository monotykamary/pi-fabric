import { createHash } from "node:crypto";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { CodePreviewSettings } from "pi-code-previews";
import { Box, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { initHighlighting } from "../src/ui/highlight.js";
import {
  HiddenRowBorrowingComponent,
  observeResultRows,
  resultRowDeficit,
  type ResultRowBalance,
} from "../src/ui/row-balance.js";
import {
  captureFabricCallHeadlinePreviews,
  captureFabricCoreToolPreviews,
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
  restoreFabricCallHeadlinePreviews,
  restoreFabricCoreToolPreviews,
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

  it("restores rich core arguments, results, and renderer metadata after final projection", () => {
    const live = [
      {
        ref: "pi.grep",
        provider: "pi",
        tool: "grep",
        args: { path: "src", pattern: "needle", literal: true },
        result: "src/a.ts:1: needle",
        preview: { details: { truncation: { truncated: false } } },
        success: true,
      },
      {
        ref: "pi.edit",
        provider: "pi",
        tool: "edit",
        args: { path: "src/a.ts", edits: [{ oldText: "old", newText: "new" }] },
        result: { ok: true, output: "edited", details: { diff: "-1 old\n+1 new" } },
        success: true,
      },
    ];
    const previews = captureFabricCoreToolPreviews(live);
    const restored = restoreFabricCoreToolPreviews(
      [
        { ref: "pi.grep", provider: "pi", tool: "grep", args: { path: "src" }, success: true },
        { ref: "pi.edit", provider: "pi", tool: "edit", args: { path: "src/a.ts" }, success: true },
      ],
      previews,
    );

    expect(restored[0]?.args).toMatchObject({ pattern: "needle", literal: true });
    expect(restored[0]?.result).toBe("src/a.ts:1: needle");
    expect(restored[0]?.preview).toEqual({ details: { truncation: { truncated: false } } });
    expect(restored[1]?.args?.edits).toEqual([{ oldText: "old", newText: "new" }]);
    expect(restored[1]?.result).toMatchObject({ details: { diff: "-1 old\n+1 new" } });
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

  it("renders child-agent edit activity beneath its parent call", () => {
    const settings = {
      tools: ["edit"],
      editDiffPreview: true,
      editCollapsedLines: 160,
      syntaxHighlighting: false,
      secretWarnings: true,
      diffIntensity: "subtle",
      wordEmphasis: "all",
      toolCallBackground: "off",
    } as CodePreviewSettings;
    const lines = renderFabricMulticallPartial(
      {
        audits: [
          {
            ref: "agents.run",
            provider: "agents",
            tool: "run",
            args: { task: "implement" },
            preview: {
              kind: "fabric-agent-tools",
              id: "agent-child-123",
              name: "implementor",
              status: "running",
              runner: "pi",
              owner: "agent",
              tools: [
                {
                  id: "child-edit",
                  kind: "tool",
                  label: "edit",
                  toolName: "edit",
                  status: "running",
                  args: {
                    path: "src/child.ts",
                    edits: [{ oldText: "const before = 1;", newText: "const after = 2;" }],
                  },
                },
              ],
            },
          },
        ],
        phases: [],
        expanded: false,
        showNestedToolCalls: true,
        core: { cwd: process.cwd(), settings },
      },
      plainTheme,
    ).render(120).join("\n");

    const visible = lines.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    expect(visible).toContain("src/child.ts");
    expect(visible).toContain("[agent · implementor · pi · agent-ch]");
    expect(visible).toContain("const before = 1;");
    expect(visible).toContain("const after = 2;");
  });

  it("renders agent narrative while nested tool rows are hidden", () => {
    const lines = renderFabricMulticallPartial(
      {
        audits: [
          {
            ref: "agents.run",
            provider: "agents",
            tool: "run",
            args: { task: "implement" },
            preview: {
              kind: "fabric-agent-tools",
              id: "agent-child-123",
              name: "implementor",
              status: "running",
              runner: "pi",
              owner: "agent",
              text: "Inspecting the routing configuration now.",
              tools: [
                {
                  id: "child-read",
                  kind: "tool",
                  label: "read",
                  toolName: "read",
                  status: "running",
                  args: { path: "src/private.ts" },
                },
              ],
            },
          },
        ],
        phases: [],
        expanded: false,
        showNestedToolCalls: false,
      },
      plainTheme,
    ).render(120).join("\n");

    const visible = lines.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    expect(visible).toContain("Inspecting the routing configuration now.");
    expect(visible).toContain("[agent · implementor · pi · agent-ch]");
    expect(visible).not.toContain("src/private.ts");
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

  it("keeps generic MCP headlines after final trace projection", () => {
    const live = [
      {
        ref: "mcp.fal-ai.submit_job",
        provider: "mcp",
        tool: "fal-ai.submit_job",
        args: { endpoint: "fal-ai/hunyuan3d-v3/image-to-3d", arguments: { image_url: "one" } },
      },
      {
        ref: "mcp.fal-ai.submit_job",
        provider: "mcp",
        tool: "fal-ai.submit_job",
        args: { endpoint: "fal-ai/hunyuan3d-v3/image-to-3d/two", arguments: { image_url: "two" } },
      },
    ];
    const previews = captureFabricCallHeadlinePreviews(live);
    const restored = restoreFabricCallHeadlinePreviews(
      [
        { ref: "fabric.workflow.parallel", provider: "fabric", tool: "workflow.parallel", args: { itemCount: 2 } },
        ...live.map(({ args: _args, ...audit }) => ({ ...audit, args: {}, success: true })),
      ],
      previews,
    );

    expect(previews).toEqual([
      { ref: "mcp.fal-ai.submit_job", headline: "fal-ai/hunyuan3d-v3/image-to-3d" },
      { ref: "mcp.fal-ai.submit_job", headline: "fal-ai/hunyuan3d-v3/image-to-3d/two" },
    ]);
    expect(nestedCallTitle(restored[1]!, plainTheme)).toBe(
      "fal-ai.submit_job fal-ai/hunyuan3d-v3/image-to-3d",
    );
    expect(nestedCallTitle(restored[2]!, plainTheme)).toBe(
      "fal-ai.submit_job fal-ai/hunyuan3d-v3/image-to-3d/two",
    );
  });

  it("keeps restored headline occurrences aligned when final args already have a preview", () => {
    const restored = restoreFabricCallHeadlinePreviews(
      [
        { ref: "mcp.server.lookup", provider: "mcp", tool: "server.lookup", args: { query: "durable first" } },
        { ref: "mcp.server.lookup", provider: "mcp", tool: "server.lookup", args: {} },
      ],
      [
        { ref: "mcp.server.lookup", headline: "live first" },
        { ref: "mcp.server.lookup", headline: "live second" },
      ],
    );

    expect(nestedCallTitle(restored[0]!, plainTheme)).toBe("server.lookup durable first");
    expect(nestedCallTitle(restored[1]!, plainTheme)).toBe("server.lookup live second");
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

  it("reuses bounded row layout until its width or content is invalidated", () => {
    const component = renderBoundedLines(["x".repeat(40)]);
    const first = component.render(20);

    expect(component.render(20)).toBe(first);
    expect(component.render(24)).not.toBe(first);

    const resized = component.render(20);
    expect(resized).not.toBe(first);
    component.invalidate?.();
    expect(component.render(20)).not.toBe(resized);
  });

  it("reuses stable source-row balancing between animation frames", () => {
    const balance: ResultRowBalance = {};
    let renders = 0;
    const code = new HiddenRowBorrowingComponent(
      2,
      4,
      (limit) => {
        renders++;
        return Array.from({ length: limit }, (_, index) => "code-" + (index + 1));
      },
      balance,
    );

    const first = code.render(80);
    expect(code.render(80)).toBe(first);
    expect(renders).toBe(1);

    code.invalidate();
    expect(code.render(80)).not.toBe(first);
    expect(renders).toBe(2);
  });

  it("replaces lost result rows with hidden source lines", () => {
    const balance: ResultRowBalance = {};
    const partial = observeResultRows(
      renderBoundedLines(["running", "call one", "call two", "detail", "progress"]),
      balance,
      { expanded: false, isPartial: true },
    );
    expect(partial.render(80)).toHaveLength(5);

    const final = observeResultRows(
      renderBoundedLines(["complete", "calls"]),
      balance,
      { expanded: false, isPartial: false },
    );
    expect(final.render(80)).toEqual(["complete", "calls"]);
    expect(resultRowDeficit(balance, 80)).toBe(3);

    const code = new HiddenRowBorrowingComponent(
      8,
      20,
      (limit) => [
        "title",
        ...Array.from({ length: limit }, (_, index) => `code-${index + 1}`),
        ...(limit < 20 ? [`${20 - limit} hidden`] : []),
      ],
      balance,
    );
    const rendered = code.render(80);
    expect(rendered).toHaveLength(13);
    expect(rendered).toContain("code-11");
    expect(rendered).not.toContain("code-12");
    expect(rendered.length + final.render(80).length).toBe(15);
  });

  it("does not reveal a source line that would overshoot the result deficit", () => {
    const balance: ResultRowBalance = {};
    observeResultRows(
      renderBoundedLines(["one", "two", "three"]),
      balance,
      { expanded: false, isPartial: true },
    ).render(20);
    observeResultRows(
      renderBoundedLines(["done"]),
      balance,
      { expanded: false, isPartial: false },
    );

    const code = new HiddenRowBorrowingComponent(
      1,
      2,
      (limit) =>
        limit === 1 ? ["base"] : ["base", "wrapped", "source", "line"],
      balance,
    );
    expect(code.render(20)).toEqual(["base"]);
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
