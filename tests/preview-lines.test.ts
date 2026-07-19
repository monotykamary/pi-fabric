import { describe, expect, it } from "vitest";
import {
  countContentLines,
  selectPreviewTextLines,
} from "../src/ui/preview-lines.js";

describe("preview line handling", () => {
  it("counts mixed content terminators without allocating normalized copies", () => {
    expect(countContentLines("")).toBe(0);
    expect(countContentLines("\n\n")).toBe(2);
    expect(countContentLines("one\n")).toBe(1);
    expect(countContentLines("\r\n\r\n")).toBe(2);
    expect(countContentLines("one\rtwo\r")).toBe(2);
    expect(countContentLines("one\r\ntwo\nthree\rfour")).toBe(4);
  });

  it("preserves internal blanks while trimming trailing preview blanks", () => {
    expect(selectPreviewTextLines("one\n\ntwo\n\n", 10)).toEqual({
      entries: [
        { kind: "line", line: "one", index: 0 },
        { kind: "line", line: "", index: 1 },
        { kind: "line", line: "two", index: 2 },
      ],
      shown: 3,
      hidden: 0,
      total: 3,
    });
    expect(selectPreviewTextLines("\n\n", 10)).toEqual({
      entries: [{ kind: "line", line: "", index: 0 }],
      shown: 1,
      hidden: 0,
      total: 1,
    });
  });

  it("keeps head and tail windows for larger previews", () => {
    const text = Array.from({ length: 12 }, (_, index) => `line ${index}`).join("\n");
    expect(selectPreviewTextLines(text, 8)).toEqual({
      entries: [
        { kind: "line", line: "line 0", index: 0 },
        { kind: "line", line: "line 1", index: 1 },
        { kind: "line", line: "line 2", index: 2 },
        { kind: "line", line: "line 3", index: 3 },
        { kind: "line", line: "line 4", index: 4 },
        { kind: "line", line: "line 5", index: 5 },
        { kind: "hidden", hidden: 5 },
        { kind: "line", line: "line 11", index: 11 },
      ],
      shown: 7,
      hidden: 5,
      total: 12,
    });
  });
});
