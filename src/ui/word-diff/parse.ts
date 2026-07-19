export type ParsedDiffLine = { kind: "+" | "-" | " "; lineNumber: string; content: string };
export type AddedDiffLine = ParsedDiffLine & { kind: "+" };
export type RemovedDiffLine = ParsedDiffLine & { kind: "-" };

export const isAddedDiffLine = (line: ParsedDiffLine | null): line is AddedDiffLine =>
  line?.kind === "+";

export const isRemovedDiffLine = (line: ParsedDiffLine | null): line is RemovedDiffLine =>
  line?.kind === "-";
