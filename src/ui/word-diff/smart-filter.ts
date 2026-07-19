import type { WordChangeRanges } from "./types.js";
import {
  isIdentifierToken,
  isMeaningfulOperatorToken,
  isNumberToken,
  wordTokenValues,
} from "./tokens.js";

export function filterLowSignalWordEmphasis(
  before: string,
  after: string,
  ranges: WordChangeRanges,
): WordChangeRanges {
  const hasRemovedSignal = ranges.removed.some((range) => hasSmartRangeSignal(before, range));
  const hasAddedSignal = ranges.added.some((range) => hasSmartRangeSignal(after, range));
  return {
    removed: ranges.removed.filter((range) =>
      shouldKeepSmartRange(before.slice(range[0], range[1]), hasAddedSignal),
    ),
    added: ranges.added.filter((range) =>
      shouldKeepSmartRange(after.slice(range[0], range[1]), hasRemovedSignal),
    ),
  };
}

function hasSmartRangeSignal(content: string, range: [number, number]): boolean {
  const tokens = wordTokenValues(content.slice(range[0], range[1]));
  return tokens.some(isSmartSignalToken);
}

function shouldKeepSmartRange(text: string, oppositeSideHasSignal: boolean): boolean {
  const tokens = wordTokenValues(text);
  const signalTokens = tokens.filter(isSmartSignalToken);
  if (signalTokens.length === 0) return false;
  const wordTokens = signalTokens.filter(
    (token) => isIdentifierToken(token) || isNumberToken(token),
  );
  const hasOperatorSignal = signalTokens.some(isMeaningfulOperatorToken);
  if (
    !oppositeSideHasSignal &&
    !hasOperatorSignal &&
    wordTokens.every((token) => LOW_SIGNAL_SYNTAX_TOKENS.has(token))
  )
    return false;
  if (!oppositeSideHasSignal && !hasOperatorSignal && isWrapperCallNoise(text, wordTokens))
    return false;
  return true;
}

function isSmartSignalToken(token: string): boolean {
  return isIdentifierToken(token) || isNumberToken(token) || isMeaningfulOperatorToken(token);
}

const LOW_SIGNAL_SYNTAX_TOKENS = new Set([
  "as",
  "async",
  "await",
  "const",
  "else",
  "export",
  "from",
  "function",
  "if",
  "import",
  "let",
  "return",
  "var",
]);

const WRAPPER_CALL_TOKENS = new Set(["filter", "flatMap", "forEach", "map", "reduce"]);

function isWrapperCallNoise(text: string, tokens: string[]): boolean {
  return (
    tokens.length === 1 &&
    tokens[0] !== undefined &&
    WRAPPER_CALL_TOKENS.has(tokens[0]) &&
    /^[\s.()[\]{};,]*[$_\p{L}][$_\p{L}\p{N}\p{Mark}]*[\s.()[\]{};,]*$/u.test(text)
  );
}
