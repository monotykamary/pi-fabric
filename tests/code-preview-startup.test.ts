import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultCodePreviewSettings,
  withLightweightCodePreviewShell,
} from "../src/ui/code-preview.js";

describe("code preview startup", () => {
  it("keeps pi-code-previews off the default static import path", () => {
    const indexSource = fs.readFileSync(path.join(process.cwd(), "src", "index.ts"), "utf8");
    const toolSource = fs.readFileSync(
      path.join(process.cwd(), "src", "fabric-exec-tool.ts"),
      "utf8",
    );
    expect(indexSource).not.toMatch(/^import .* from ["']pi-code-previews["'];/m);
    expect(toolSource).not.toContain('from "pi-code-previews"');
    expect(indexSource).toContain('await import("pi-code-previews")');
  });

  it("uses environment-backed defaults without loading the preview package", () => {
    const previous = process.env.CODE_PREVIEW_TOOL_CALL_BACKGROUND;
    process.env.CODE_PREVIEW_TOOL_CALL_BACKGROUND = "off";
    try {
      expect(defaultCodePreviewSettings().toolCallBackground).toBe("off");
    } finally {
      if (previous === undefined) delete process.env.CODE_PREVIEW_TOOL_CALL_BACKGROUND;
      else process.env.CODE_PREVIEW_TOOL_CALL_BACKGROUND = previous;
    }
  });

  it("preserves shell mode and timing preferences", () => {
    const tool = {
      name: "sample",
      label: "Sample",
      renderCall: () => ({ render: () => ["call"], invalidate() {} }),
      renderResult: () => ({ render: () => ["result"], invalidate() {} }),
    } as any;
    const decorated = withLightweightCodePreviewShell(tool, {
      mode: "off",
      toolCallTiming: false,
    });
    expect(decorated.renderShell).toBe("self");
    const context = {
      state: {},
      executionStarted: true,
      isPartial: false,
    } as any;
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;
    decorated.renderCall({}, theme, context);
    const result = decorated.renderResult(
      { content: [] },
      { expanded: false, isPartial: false },
      theme,
      context,
    );
    expect(result.render(80)).toEqual(["result"]);
  });
});
