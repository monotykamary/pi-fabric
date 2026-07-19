export type DiffWordEmphasis = "all" | "smart" | "off";

export type WordChangeRanges = {
  removed: Array<[number, number]>;
  added: Array<[number, number]>;
};

export type WordChangeConfidence = "high" | "medium" | "low";

export type ConfidentWordChangeRanges = WordChangeRanges & {
  confidence: WordChangeConfidence;
};
