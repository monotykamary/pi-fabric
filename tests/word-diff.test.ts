import { describe, expect, it } from "vitest";
import {
  changedRanges,
  changedRangesWithConfidence,
} from "../src/ui/word-diff/emphasis.js";
import { indexedChangedLine } from "../src/ui/word-diff/changed-line.js";
import { matchChangedLines } from "../src/ui/word-diff/line-matching.js";

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

  it("expands changed ranges to complete extended grapheme clusters", () => {
    const cases = [
      { before: "👩‍💻Foo", after: "👩‍🔬Foo", end: 5 },
      { before: "👍🏻Foo", after: "👍🏽Foo", end: 4 },
      { before: "👨‍👩‍👧‍👦Foo", after: "👨‍👩‍👧‍👧Foo", end: 11 },
    ];
    for (const { before, after, end } of cases) {
      expect(changedRanges(before, after, "all")).toEqual({
        removed: [[0, end]],
        added: [[0, end]],
      });
    }
  });

  it("preserves separator-only and Unicode symbol changes in smart mode", () => {
    expect(changedRanges("snake_case", "snakecase", "all")).toEqual({
      removed: [[5, 6]],
      added: [],
    });
    expect(changedRanges("if (count ≤ limit)", "if (count ≥ limit)", "smart")).toEqual({
      removed: [[10, 11]],
      added: [[10, 11]],
    });
    expect(changedRanges("Status:", "Status: 👩🏽‍💻", "smart")).toEqual({
      removed: [],
      added: [[8, 15]],
    });
  });

  it("recovers reordered changed lines above the full-matrix cutoff", () => {
    const contents = Array.from(
      { length: 33 },
      (_, index) =>
        `const record${index}Checksum${1000 + index} = transform${index}(old${index});`,
    );
    const removed = contents.map((content, index) =>
      indexedChangedLine(index, { kind: "-", lineNumber: String(index + 1), content }),
    );
    const added = [...contents].reverse().map((content, index) =>
      indexedChangedLine(index + 33, {
        kind: "+",
        lineNumber: String(index + 1),
        content: content.replace("old", "new"),
      }),
    );

    expect(
      matchChangedLines(removed, added).map(({ removedIndex, addedIndex }) => [
        removedIndex,
        addedIndex,
      ]),
    ).toEqual(Array.from({ length: 33 }, (_, index) => [index, 65 - index]));
  });
});
