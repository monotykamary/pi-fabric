// Structural complexity for TS/JS/TSX/JSX is the number of lexical
// statement-decision keyword tokens: `if` (including the `if` in `else if`),
// `case`, `default`, `catch`, `for`, and `while`. Strings, template/JSX text,
// regular-expression literals, and comments are skipped; code inside `${...}`
// is tokenized. `case` and `default` count only in a switch body, `default`
// must be followed by `:`, and `if`/`for`/`while` must be followed by `(`
// (`catch` also supports optional catch binding). Ternaries, `&&`, `||`, `?.`,
// and `??` never count. This is intentionally a token fold, not an AST or a
// prose regex. Unsupported file extensions return undefined.

import fs from "node:fs";
import path from "node:path";

export interface LanguageComplexity {
  readonly language: string;
  readonly extensions: readonly string[];
  count(source: string): number;
}

export interface FileComplexity {
  file: string;
  language: string;
  count: number;
}

interface Token {
  value: string;
  kind: "word" | "punctuation";
}

const isWordStart = (character: string | undefined): boolean =>
  character !== undefined &&
  ((character >= "a" && character <= "z") ||
    (character >= "A" && character <= "Z") ||
    character === "_" ||
    character === "$");

const isWordPart = (character: string | undefined): boolean =>
  isWordStart(character) ||
  (character !== undefined && character >= "0" && character <= "9");

const regularExpressionPrefixWords = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

const canStartRegularExpression = (previous: Token | undefined): boolean => {
  if (!previous) return true;
  if (previous.kind === "punctuation") {
    return "([{=,:;!&|?+-*%^~<>".includes(previous.value);
  }
  return regularExpressionPrefixWords.has(previous.value);
};

const tokenize = (source: string): Token[] => {
  const tokens: Token[] = [];
  let scan: (start: number, stopAtClosingBrace: boolean) => number;

  const skipQuoted = (start: number): number => {
    const quote = source[start];
    let index = start + 1;
    while (index < source.length) {
      if (source[index] === "\\") {
        index += 2;
      } else if (source[index] === quote) {
        return index + 1;
      } else {
        index++;
      }
    }
    return index;
  };

  const scanJsx = (start: number): number => {
    let index = start + 1;
    let selfClosing = false;
    while (index < source.length) {
      if (source[index] === "'" || source[index] === '"') {
        index = skipQuoted(index);
      } else if (source[index] === "{") {
        tokens.push({ value: "{", kind: "punctuation" });
        index = scan(index + 1, true);
        tokens.push({ value: "}", kind: "punctuation" });
      } else if (source[index] === ">") {
        let previous = index - 1;
        while (previous > start && source[previous]?.trim().length === 0) previous--;
        selfClosing = source[previous] === "/";
        index++;
        break;
      } else {
        index++;
      }
    }
    if (selfClosing) return index;

    while (index < source.length) {
      if (source[index] === "{") {
        tokens.push({ value: "{", kind: "punctuation" });
        index = scan(index + 1, true);
        tokens.push({ value: "}", kind: "punctuation" });
      } else if (source[index] === "<" && source[index + 1] === "/") {
        index += 2;
        while (index < source.length && source[index] !== ">") index++;
        return Math.min(source.length, index + 1);
      } else if (source[index] === "<") {
        index = scanJsx(index);
      } else {
        index++;
      }
    }
    return index;
  };

  const canStartJsx = (next: string | undefined): boolean => {
    if (next !== ">" && !isWordStart(next)) return false;
    const previous = tokens[tokens.length - 1];
    if (!previous) return true;
    if (previous.kind === "word") return previous.value === "return";
    return ["(", "[", "{", "=", ",", ":", "?", "=>", "&&", "||"].includes(
      previous.value,
    );
  };

  scan = (start: number, stopAtClosingBrace: boolean): number => {
    let index = start;
    while (index < source.length) {
      const character = source[index];
      const next = source[index + 1];

      if (stopAtClosingBrace && character === "}") return index + 1;
      if (character === "<" && canStartJsx(next)) {
        index = scanJsx(index);
        continue;
      }
      if (character === "{") {
        tokens.push({ value: "{", kind: "punctuation" });
        index = scan(index + 1, true);
        tokens.push({ value: "}", kind: "punctuation" });
        continue;
      }
      if (character === "/" && next === "/") {
        index += 2;
        while (index < source.length && source[index] !== "\n") index++;
        continue;
      }
      if (character === "/" && next === "*") {
        index += 2;
        while (
          index < source.length &&
          !(source[index] === "*" && source[index + 1] === "/")
        ) {
          index++;
        }
        index = Math.min(source.length, index + 2);
        continue;
      }
      if (character === "'" || character === '"') {
        index = skipQuoted(index);
        continue;
      }
      if (character === "`") {
        index++;
        while (index < source.length) {
          if (source[index] === "\\") {
            index += 2;
          } else if (source[index] === "`") {
            index++;
            break;
          } else if (source[index] === "$" && source[index + 1] === "{") {
            tokens.push({ value: "{", kind: "punctuation" });
            index = scan(index + 2, true);
            tokens.push({ value: "}", kind: "punctuation" });
          } else {
            index++;
          }
        }
        continue;
      }
      if (
        character === "/" &&
        next !== "=" &&
        canStartRegularExpression(tokens[tokens.length - 1])
      ) {
        index++;
        let inCharacterClass = false;
        while (index < source.length) {
          if (source[index] === "\\") {
            index += 2;
          } else if (source[index] === "[") {
            inCharacterClass = true;
            index++;
          } else if (source[index] === "]") {
            inCharacterClass = false;
            index++;
          } else if (source[index] === "/" && !inCharacterClass) {
            index++;
            while (isWordPart(source[index])) index++;
            break;
          } else {
            index++;
          }
        }
        continue;
      }
      if (isWordStart(character)) {
        const wordStart = index;
        index++;
        while (isWordPart(source[index])) index++;
        tokens.push({ value: source.slice(wordStart, index), kind: "word" });
        continue;
      }
      if (character !== undefined && character.trim().length > 0) {
        const twoCharacters = `${character}${next ?? ""}`;
        if (["?.", "??", "&&", "||", "=>"].includes(twoCharacters)) {
          tokens.push({ value: twoCharacters, kind: "punctuation" });
          index += 2;
        } else {
          tokens.push({ value: character, kind: "punctuation" });
          index++;
        }
        continue;
      }
      index++;
    }
    return index;
  };

  scan(0, false);
  return tokens;
};

const followedBy = (tokens: Token[], index: number, value: string): boolean =>
  tokens[index + 1]?.value === value;

const countTypeScriptJavaScript = (source: string): number => {
  const tokens = tokenize(source);
  const switchBodies: boolean[] = [];
  let waitingForSwitchBody = false;
  let count = 0;

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]?.value;
    if (token === "switch") waitingForSwitchBody = true;
    if (token === "{") {
      switchBodies.push(waitingForSwitchBody);
      waitingForSwitchBody = false;
      continue;
    }
    if (token === "}") {
      switchBodies.pop();
      continue;
    }

    if (
      (token === "if" || token === "for" || token === "while") &&
      followedBy(tokens, index, "(")
    ) {
      count++;
      continue;
    }
    if (
      token === "catch" &&
      (followedBy(tokens, index, "(") || followedBy(tokens, index, "{"))
    ) {
      count++;
      continue;
    }
    if (switchBodies[switchBodies.length - 1] === true) {
      if (token === "default" && followedBy(tokens, index, ":")) {
        count++;
      } else if (token === "case") {
        count++;
      }
    }
  }
  return count;
};

export const typeScriptJavaScriptComplexity: LanguageComplexity = {
  language: "typescript/javascript",
  extensions: [".ts", ".js", ".tsx", ".jsx"],
  count: countTypeScriptJavaScript,
};

const languageComplexities: readonly LanguageComplexity[] = [
  typeScriptJavaScriptComplexity,
];

const complexityForFile = (
  file: string,
  languages: readonly LanguageComplexity[] = languageComplexities,
): LanguageComplexity | undefined => {
  const extension = path.extname(file).toLowerCase();
  return languages.find((language) => language.extensions.includes(extension));
};

export const countFileComplexity = (
  file: string,
): FileComplexity | undefined => {
  const language = complexityForFile(file);
  if (!language) return undefined;
  return {
    file,
    language: language.language,
    count: language.count(fs.readFileSync(file, "utf8")),
  };
};
