import { describe, expect, it } from "vitest";
import {
  changedRanges,
  changedRangesWithConfidence,
} from "../src/ui/word-diff/emphasis.js";

const slices = (text: string, ranges: Array<[number, number]>): string[] =>
  ranges.map(([start, end]) => text.slice(start, end));

describe("Fabric word-level diff emphasis", () => {
  it("narrows similar single-token edits", () => {
    expect(changedRanges("value1000", "value1001", "all")).toEqual({
      removed: [[8, 9]],
      added: [[8, 9]],
    });
  });

  it("uses compound identifier parts", () => {
    const before = "const limit = readCollapsedLines;";
    const after = "const limit = editCollapsedLines;";
    const ranges = changedRanges(before, after, "all");
    expect(slices(before, ranges.removed)).toEqual(["read"]);
    expect(slices(after, ranges.added)).toEqual(["edit"]);
  });

  it("suppresses low-signal wrapper syntax in smart mode", () => {
    const before = "  .map((item) => item.title)";
    const after = "  (item) => item.title";
    expect(changedRanges(before, after, "smart")).toEqual({ removed: [], added: [] });
    expect(
      slices(before, changedRanges(before, after, "all").removed).some((text) => text.includes(".map")),
    ).toBe(true);
  });

  it("keeps Unicode range boundaries intact", () => {
    const before = "const icon = '👩‍💻-old';";
    const after = "const icon = '👩‍💻-new';";
    const ranges = changedRangesWithConfidence(before, after, "all");
    expect(slices(before, ranges.removed)).toContain("old");
    expect(slices(after, ranges.added)).toContain("new");
    expect(ranges.confidence).not.toBe("low");
  });
});
