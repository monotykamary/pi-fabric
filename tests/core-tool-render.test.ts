import type { Theme } from "@earendil-works/pi-coding-agent";
import type { CodePreviewSettings } from "pi-code-previews";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { configureHighlighting } from "../src/ui/highlight.js";
import {
  coreToolPreviewEnabled,
  coreToolRendererEnabled,
  coreToolTitle,
  renderCoreToolBody,
  type CoreToolRenderOptions,
} from "../src/ui/core-tool-render.js";
import {
  inheritComponentBackground,
  renderBoundedLines,
  type FabricRenderAudit,
} from "../src/ui/fabric-render.js";

const settings: CodePreviewSettings = {
  shikiTheme: "dark-plus",
  diffIntensity: "subtle",
  wordEmphasis: "all",
  toolCallBackground: "on",
  toolCallTiming: true,
  readCollapsedLines: 10,
  readContentPreview: true,
  writeContentPreview: true,
  writeCollapsedLines: 10,
  editDiffPreview: true,
  editCollapsedLines: 160,
  grepCollapsedLines: 15,
  grepResultPreview: true,
  findResultPreview: true,
  lsResultPreview: true,
  pathListCollapsedLines: 20,
  readLineNumbers: true,
  bashResultPreview: true,
  bashWarnings: true,
  syntaxHighlighting: true,
  secretWarnings: true,
  pathIcons: "unicode",
  tools: ["bash", "read", "write", "edit", "grep", "find", "ls"],
};

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  getFgAnsi: (color: string) =>
    color === "toolDiffAdded" ? "\x1b[38;2;80;200;120m" : "\x1b[38;2;220;90;100m",
  getBgAnsi: () => "\x1b[48;2;0;0;0m",
} as unknown as Theme;

const options = (
  overrides: Partial<CoreToolRenderOptions> = {},
): CoreToolRenderOptions => ({
  cwd: process.cwd(),
  settings,
  expanded: false,
  maxLines: 200,
  ...overrides,
});

const audit = (
  tool: string,
  values: Omit<FabricRenderAudit, "ref" | "provider" | "tool">,
): FabricRenderAudit => ({ ref: `pi.${tool}`, provider: "pi", tool, ...values });

describe("Fabric core tool parity rendering", () => {
  it("renders offset-aware read gutters and secret warnings", () => {
    const rendered = renderCoreToolBody(
      audit("read", {
        args: { path: "src/example.ts", offset: 20 },
        result: "const value = 1;\nOPENAI_API_KEY=abcdefghijklmnop",
        success: true,
      }),
      theme,
      options(),
    );

    expect(rendered).not.toBeNull();
    expect(rendered!.lines[0]).toContain("possible API key");
    expect(rendered!.lines.join("\n")).toContain("20 │");
    expect(rendered!.lines.join("\n")).toContain("21 │");
  });

  it.each([
    {
      tool: "read",
      args: { path: "src/transcript.ts" },
      output: "export const transcriptBody = true;",
      expected: "transcriptBody",
    },
    {
      tool: "grep",
      args: { pattern: "transcriptBody", path: "src", literal: true },
      output: "src/transcript.ts:1: export const transcriptBody = true;",
      expected: "transcriptBody",
    },
    {
      tool: "find",
      args: { pattern: "*.ts", path: "src" },
      output: "src/transcript.ts",
      expected: "transcript.ts",
    },
    {
      tool: "ls",
      args: { path: "src" },
      output: "transcript.ts",
      expected: "transcript.ts",
    },
    {
      tool: "bash",
      args: { command: "printf transcript-body" },
      output: "transcript-body",
      expected: "transcript-body",
    },
  ])("renders $tool transcript content blocks through the regular core UI", ({
    tool,
    args,
    output,
    expected,
  }) => {
    const rendered = renderCoreToolBody(
      audit(tool, {
        args,
        result: {
          content: [
            { type: "text", text: output },
            { type: "image", data: "ignored" },
          ],
          details: {},
        },
        success: true,
      }),
      theme,
      options({ expanded: true }),
    );

    expect(rendered).not.toBeNull();
    expect(rendered!.lines.join("\n")).toContain(expected);
    expect(rendered!.lines.join("\n")).not.toContain("No matches found");
  });

  it("joins multiple transcript text blocks in their original order", () => {
    const rendered = renderCoreToolBody(
      audit("read", {
        args: { path: "src/blocks.ts" },
        result: {
          content: [
            { type: "text", text: "const firstBlock = 1;" },
            { type: "text", text: "const secondBlock = 2;" },
          ],
        },
        success: true,
      }),
      theme,
      options({ expanded: true }),
    );

    const text = rendered!.lines.join("\n");
    expect(text.indexOf("firstBlock")).toBeLessThan(text.indexOf("secondBlock"));
  });

  it("renders write result diffs with summaries, gutters, word emphasis, and full-row backgrounds", () => {
    const rendered = renderCoreToolBody(
      audit("write", {
        args: {
          path: "src/example.ts",
          content: `const value = "${"new".repeat(40)}";`,
        },
        preview: {
          details: {
            codePreviewBeforeWrite: {
              kind: "content",
              content: `const value = "${"old".repeat(40)}";`,
            },
          },
          writeBeforeCaptured: true,
        },
        success: true,
      }),
      theme,
      options(),
    );

    expect(rendered).not.toBeNull();
    expect(rendered!.lines[0]).toContain("Write applied");
    expect(rendered!.lines.join("\n")).toContain("replacement");
    expect(rendered!.lines.join("\n")).toContain("│");
    expect(rendered!.lines.join("\n")).toContain("\x1b[48;2;148;62;70m");
    expect(rendered!.lines.join("\n")).toContain("\x1b[48;2;64;132;82m");

    const component = renderBoundedLines(rendered!.lines, theme, settings.diffIntensity);
    const rows = component.render(32);
    expect(inheritComponentBackground(component).render(32)).toEqual(rows);
    const changedRows = rows.filter((line) => line.includes("\x1b[48;2;"));
    expect(changedRows).toHaveLength(6);
    expect(changedRows.every((line) => visibleWidth(line) === 32)).toBe(true);
    const plainRows = changedRows.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
    expect(plainRows.filter((line) => line.startsWith("     ")).length).toBe(4);
  });

  it("groups grep matches by file, distinguishes context, and emphasizes literal matches", () => {
    const rendered = renderCoreToolBody(
      audit("grep", {
        args: { pattern: "value", path: "src", literal: true },
        result: [
          "src/a.ts:3: const value = 1;",
          "src/a.ts-4- return value;",
          "src/b.ts:9: const value = 2;",
        ].join("\n"),
        success: true,
      }),
      theme,
      options(),
    );

    const text = rendered!.lines.join("\n");
    expect(text.match(/src\/a\.ts/g)).toHaveLength(1);
    expect(text.match(/src\/b\.ts/g)).toHaveLength(1);
    expect(text).toContain("│");
    expect(text).toContain("┆");
    expect(text).toContain("\x1b[48;2;90;74;28m");
  });

  it.each([
    ["find", "src/a.ts\nsrc/lib/b.ts"],
    ["ls", "src/\nREADME.md"],
  ])("renders %s output as an iconized path tree", (tool, result) => {
    const rendered = renderCoreToolBody(
      audit(tool, { args: { path: ".", pattern: "*.ts" }, result, success: true }),
      theme,
      options(),
    );

    expect(rendered!.lines.join("\n")).toMatch(/[▸•]/);
    expect(rendered!.lines.join("\n")).toContain("src/");
  });

  it("lets Pi's no-output sentinel inherit the enclosing tool background", () => {
    const rendered = renderCoreToolBody(
      audit("bash", {
        args: { command: "git status --short" },
        result: { ok: true, output: "(no output)", details: {} },
        success: true,
      }),
      theme,
      options(),
    );

    expect(rendered!.lines).toEqual(["(no output)"]);
  });

  it("leaves nested bash output background ownership to the enclosing tool", () => {
    const rendered = renderCoreToolBody(
      audit("bash", {
        args: { command: "printf output" },
        result: { ok: true, output: "output", details: {} },
        success: true,
      }),
      theme,
      options(),
    );

    expect(rendered!.lines.join("\n")).not.toContain("\x1b[48;2;0;0;0m");
  });

  it("renders bash warnings, timeout metadata, output limits, and full output details", () => {
    const call = audit("bash", {
      args: { command: "sudo rm -rf build", timeout: 30 },
      preview: { bashCommand: "sudo rm -rf build\necho complete" },
      result: {
        ok: true,
        output: Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"),
        details: { fullOutputPath: "/tmp/bash.log", truncation: { truncated: true } },
      },
      success: true,
      startedAt: 1_000,
      endedAt: 2_250,
    });
    const title = coreToolTitle(call, theme, {
      cwd: process.cwd(),
      settings,
    });
    const rendered = renderCoreToolBody(call, theme, options());

    expect(title).toContain("timeout 30s");
    expect(title).toContain("1.3s");
    expect(title).toContain("recursive delete");
    expect(title).toContain("elevated privileges");
    expect(rendered!.hidden).toBe(5);
    expect(rendered!.lines.join("\n")).toContain("echo complete");
    expect(rendered!.lines.join("\n")).toContain("Output truncated by bash");
    expect(rendered!.lines.join("\n")).toContain("Full output: /tmp/bash.log");
  });

  it("honors collapsed preview visibility while allowing expanded output", () => {
    const read = audit("read", { args: { path: "a.txt" }, result: "hidden", success: true });
    const hiddenSettings = { ...settings, readContentPreview: false };
    expect(coreToolPreviewEnabled(read, hiddenSettings)).toBe(false);
    expect(renderCoreToolBody(read, theme, options({ settings: hiddenSettings }))).toBeNull();
    expect(
      renderCoreToolBody(
        read,
        theme,
        options({ settings: hiddenSettings, expanded: true }),
      )?.lines.join("\n"),
    ).toContain("hidden");
  });

  it("falls back when a tool is excluded from the configured renderer list", () => {
    const read = audit("read", { args: { path: "a.txt" }, result: "generic", success: true });
    const disabled = { ...settings, tools: settings.tools.filter((tool) => tool !== "read") };
    expect(coreToolRendererEnabled(read, disabled)).toBe(false);
    expect(coreToolPreviewEnabled(read, disabled)).toBe(true);
    expect(renderCoreToolBody(read, theme, options({ settings: disabled }))).toBeNull();
    expect(coreToolTitle(read, theme, { cwd: process.cwd(), settings: disabled })).toBeNull();
  });

  it("renders standard unnumbered edit diffs without treating file headers as code", () => {
    const rendered = renderCoreToolBody(
      audit("edit", {
        args: { path: "src/example.ts" },
        result: {
          ok: true,
          output: "edited",
          details: { diff: "--- a/src/example.ts\n+++ b/src/example.ts\n-old\n+new" },
        },
        success: true,
      }),
      theme,
      options(),
    );

    const text = rendered!.lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(text).toContain("- │ old");
    expect(text).toContain("+ │ new");
    expect(text).toContain("--- a/src/example.ts");

    const component = renderBoundedLines(rendered!.lines, theme, settings.diffIntensity);
    const rows = component.render(32);
    expect(inheritComponentBackground(component).render(32)).toEqual(rows);
    expect(rows.filter((line) => line.startsWith("\x1b[48;2;"))).toHaveLength(2);
  });

  it("separates bounded-read continuation metadata from file content", () => {
    const rendered = renderCoreToolBody(
      audit("read", {
        args: { path: "notes.txt", limit: 2 },
        result: "alpha\nbeta\n\n[Showing lines 1-2 of 8. Use offset=3 to continue.]",
        success: true,
      }),
      theme,
      options(),
    );

    const text = rendered!.lines.join("\n");
    expect(text).toContain("1 │ alpha");
    expect(text).toContain("2 │ beta");
    expect(text).toContain("Showing lines 1-2 of 8. Use offset=3 to continue.");
    expect(text).not.toContain("3 │ [Showing");
  });

  it("renders blank-only files and escapes C1 controls", () => {
    const blank = renderCoreToolBody(
      audit("read", { args: { path: "blank.txt" }, result: "\n\n", success: true }),
      theme,
      options(),
    );
    const controlled = renderCoreToolBody(
      audit("read", { args: { path: "control.txt" }, result: "safe\x80text", success: true }),
      theme,
      options(),
    );

    expect(blank!.lines.join("\n")).not.toContain("Empty file");
    expect(controlled!.lines.join("\n")).toContain("safe�text");
    expect(controlled!.lines.join("\n")).not.toContain("\x80");
  });

  it("skips complex write rewrites before invoking the quadratic diff", () => {
    const before = Array.from({ length: 1_001 }, (_, index) => `before ${index}`).join("\n");
    const content = Array.from({ length: 1_001 }, (_, index) => `after ${index}`).join("\n");
    const rendered = renderCoreToolBody(
      audit("write", {
        args: { path: "rewrite.txt", content },
        preview: {
          details: { codePreviewBeforeWrite: { kind: "content", content: before } },
          writeBeforeCaptured: true,
        },
        success: true,
      }),
      theme,
      options(),
    );

    expect(rendered!.lines.join("\n")).toContain("diff skipped for complex rewrite");
  });

  it("reports a redacted prior write snapshot without calling it a new file", () => {
    const rendered = renderCoreToolBody(
      audit("write", {
        args: { path: "existing.txt", content: "after" },
        preview: {
          details: { codePreviewBeforeWrite: { kind: "content", byteLength: 6 } },
          writeBeforeCaptured: true,
        },
        success: true,
      }),
      theme,
      options(),
    );

    expect(rendered!.lines.join("\n")).toContain("previous content unavailable");
  });

  it("lazily invalidates and highlights every syntax-aware core preview", async () => {
    configureHighlighting("dark-plus", false);
    configureHighlighting("dark-plus", true);
    const invalidate = vi.fn();
    const previews = [
      () => renderCoreToolBody(
        audit("read", {
          args: { path: "src/lazy-read.ts" },
          result: "export const lazyRead = true;",
          success: true,
        }),
        theme,
        options({ invalidate }),
      )!.lines.join("\n"),
      () => renderCoreToolBody(
        audit("write", {
          args: { path: "src/lazy-write.ts", content: "export const lazyWrite = true;" },
          preview: { writeBeforeCaptured: true },
          success: true,
        }),
        theme,
        options({ invalidate }),
      )!.lines.join("\n"),
      () => renderCoreToolBody(
        audit("edit", {
          args: { path: "src/lazy-edit.ts" },
          result: { details: { diff: "-1 const lazyEdit = false;\n+1 const lazyEdit = true;" } },
          success: true,
        }),
        theme,
        options({ invalidate }),
      )!.lines.join("\n"),
      () => renderCoreToolBody(
        audit("grep", {
          args: { path: "src", pattern: "lazyGrep", literal: true },
          result: "src/lazy-grep.ts:1: export const lazyGrep = true;",
          success: true,
        }),
        theme,
        options({ invalidate }),
      )!.lines.join("\n"),
      () => {
        const call = audit("bash", {
          args: { command: "printf '%s\n' lazy-bash" },
          result: "lazy-bash",
          success: true,
        });
        return [
          coreToolTitle(call, theme, { cwd: process.cwd(), settings, invalidate }),
          ...renderCoreToolBody(call, theme, options({ invalidate }))!.lines,
        ].join("\n");
      },
    ];

    expect(previews.map((render) => render()).every((text) => !text.includes("\x1b[38;2;"))).toBe(true);
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalled(), { timeout: 15_000 });
    expect(previews.map((render) => render()).every((text) => text.includes("\x1b[38;2;"))).toBe(true);
  }, 20_000);

  it("does not apply core rendering to another provider with a colliding action name", () => {
    const other = {
      ref: "mcp.files.read",
      provider: "mcp",
      tool: "read",
      args: { path: "remote.txt" },
      result: "remote",
    };
    expect(renderCoreToolBody(other, theme, options())).toBeNull();
    expect(coreToolTitle(other, theme, { cwd: process.cwd(), settings })).toBeNull();
  });
});
