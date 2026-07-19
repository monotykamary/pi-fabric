import type { ParsedDiffLine } from "./parse.js";
import { analyzeChangedLineBlock } from "./change-block.js";
import { shouldEmphasizeChangedPair } from "./emphasis.js";
import type { DiffWordEmphasis } from "./types.js";

export const changedLineEmphasis = (
  block: ParsedDiffLine[],
  wordEmphasis: DiffWordEmphasis,
): Map<number, { ranges: Array<[number, number]>; kind: "add" | "remove" }> => {
  const emphasis = new Map<
    number,
    { ranges: Array<[number, number]>; kind: "add" | "remove" }
  >();
  if (wordEmphasis === "off") return emphasis;

  for (const { pair, ranges } of analyzeChangedLineBlock(block, wordEmphasis).ranges) {
    if (!shouldEmphasizeChangedPair(ranges, pair.confidence)) continue;
    emphasis.set(pair.removedIndex, { ranges: ranges.removed, kind: "remove" });
    emphasis.set(pair.addedIndex, { ranges: ranges.added, kind: "add" });
  }
  return emphasis;
};
