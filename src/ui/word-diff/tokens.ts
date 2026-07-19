// Adapted from pi-code-previews; see THIRD_PARTY_NOTICES.md.
export type WordEmphasisToken = {
  value: string;
  start: number;
  end: number;
};

const WORD_TOKEN_PATTERN =
  /[$_\p{L}][$_\p{L}\p{N}\p{Mark}]*|\p{N}+(?:\.\p{N}+)?|===|!==|=>|==|!=|<=|>=|&&|\|\||[^\s]/gu;
const IDENTIFIER_TOKEN_PATTERN = /^[$_\p{L}][$_\p{L}\p{N}\p{Mark}]*$/u;
const NUMBER_TOKEN_PATTERN = /^\p{N}+(?:\.\p{N}+)?$/u;
const SYMBOL_TOKEN_PATTERN = /^\p{S}+$/u;
const MEANINGFUL_OPERATOR_TOKEN_PATTERN =
  /^(?:===|!==|=>|==|!=|<=|>=|&&|\|\||[+\-*\/%<>=!?:~&|^]+)$/;
const DOMAIN_SEPARATOR_TOKEN_PATTERN = /^[-/:@#]$/;
const STRUCTURAL_PUNCTUATION_TOKEN_PATTERN = /^[{}()[\].,;]$/;

export function wordEmphasisTokens(text: string): WordEmphasisToken[] {
  const tokens: WordEmphasisToken[] = [];
  for (const match of text.matchAll(WORD_TOKEN_PATTERN)) {
    const value = match[0];
    const start = match.index;
    tokens.push({ value, start, end: start + value.length });
  }
  return tokens;
}

export function wordTokenValues(text: string): string[] {
  return Array.from(text.matchAll(WORD_TOKEN_PATTERN), (match) => match[0]);
}

export function isIdentifierToken(value: string): boolean {
  return IDENTIFIER_TOKEN_PATTERN.test(value);
}

export function isNumberToken(value: string): boolean {
  return NUMBER_TOKEN_PATTERN.test(value);
}

export function isSymbolToken(value: string): boolean {
  return SYMBOL_TOKEN_PATTERN.test(value);
}

export function isMeaningfulOperatorToken(value: string): boolean {
  return MEANINGFUL_OPERATOR_TOKEN_PATTERN.test(value);
}

export function wordEmphasisTokenWeight(value: string): number {
  if (isIdentifierToken(value)) return 2;
  if (isNumberToken(value)) return 1.5;
  if (DOMAIN_SEPARATOR_TOKEN_PATTERN.test(value)) return 0.25;
  if (isMeaningfulOperatorToken(value)) return 1;
  if (STRUCTURAL_PUNCTUATION_TOKEN_PATTERN.test(value)) return 0.05;
  return 1;
}

export function splitIdentifierToken(value: string, start: number): WordEmphasisToken[] {
  const parts: WordEmphasisToken[] = [];
  const partPattern =
    /[$_]+|(?:\p{Lu}\p{Mark}*)+(?=(?:\p{Lu}\p{Mark}*)(?:\p{Ll}\p{Mark}*)|\p{N}|$)|(?:\p{Lu}\p{Mark}*)?(?:\p{Ll}\p{Mark}*)+|\p{N}+|(?:\p{Lu}\p{Mark}*)+|(?:\p{L}\p{Mark}*)+/gu;
  for (const match of value.matchAll(partPattern)) {
    const part = match[0];
    const offset = match.index;
    parts.push({ value: part, start: start + offset, end: start + offset + part.length });
  }
  return parts.length > 0 ? parts : [{ value, start, end: start + value.length }];
}

export function wordEmphasisSimilarityTokenValues(tokens: WordEmphasisToken[]): string[] {
  const values: string[] = [];
  for (const token of tokens) {
    if (!isIdentifierToken(token.value)) {
      values.push(token.value);
      continue;
    }
    const parts = splitIdentifierToken(token.value, 0)
      .map((part) => part.value)
      .filter(isIdentifierSimilarityPart);
    if (parts.length === 0) values.push(token.value.toLowerCase());
    else values.push(...parts.map((part) => part.toLowerCase()));
  }
  return values;
}

export function isIdentifierSimilarityPart(value: string): boolean {
  return !/^[$_]+$/.test(value);
}
