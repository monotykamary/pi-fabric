import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { initHighlighting } from "../src/ui/highlight.js";
import { modelReadHint, nestedCallTitle, nestedEditDiff } from "../src/ui/fabric-render.js";

const theme = {
  fg: (color: string, text: string) => `\x1b[${color}]${text}\x1b[0m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
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
});
