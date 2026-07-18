export const compareLexical = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/** Canonical Unicode-aware lexical tokens with no semantic classification. */
export const tokenizeLexical = (text: string): string[] =>
  [...text.normalize("NFKC").matchAll(/[\p{L}\p{N}_]+/gu)].map((match) =>
    match[0].toLowerCase(),
  );

export const lexicalTermCounts = (text: string): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const term of tokenizeLexical(text)) counts.set(term, (counts.get(term) ?? 0) + 1);
  return counts;
};

export type MemoryQueryPlan =
  | { kind: "browse" }
  | { kind: "terms"; terms: string[] }
  | { kind: "regex"; regex: RegExp };

const tryCompileRegex = (query: string): RegExp | null => {
  try {
    return new RegExp(query, "iu");
  } catch {
    return null;
  }
};

/** Preserve the existing regex syntax while centralizing lexical query planning. */
export const planMemoryQuery = (query: string | undefined): MemoryQueryPlan => {
  const trimmed = query?.trim();
  if (!trimmed) return { kind: "browse" };
  if (/[|*+?{}()[\]\\^$.]/.test(trimmed)) {
    const regex = tryCompileRegex(trimmed);
    if (regex) return { kind: "regex", regex };
  }
  return { kind: "terms", terms: [...new Set(tokenizeLexical(trimmed))] };
};
