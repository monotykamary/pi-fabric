export interface FabricWriteBinding {
  path: string;
  stringKey: string;
}

type Token = { kind: "identifier" | "string" | "punctuation"; text: string };

const identifierStart = (char: string): boolean => /[A-Za-z_$π]/u.test(char);
const identifierPart = (char: string): boolean => /[A-Za-z0-9_$π]/u.test(char);

const readEscape = (source: string, index: number): { value: string; next: number } => {
  const char = source[index];
  if (char === undefined) return { value: "", next: index };
  const simple: Record<string, string> = {
    n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", 0: "\0",
  };
  if (char in simple) return { value: simple[char]!, next: index + 1 };
  if (char === "\n") return { value: "", next: index + 1 };
  if (char === "\r") return { value: "", next: source[index + 1] === "\n" ? index + 2 : index + 1 };
  if (char === "x") {
    const digits = source.slice(index + 1, index + 3);
    if (/^[0-9a-f]{2}$/i.test(digits)) return { value: String.fromCharCode(Number.parseInt(digits, 16)), next: index + 3 };
  }
  if (char === "u") {
    if (source[index + 1] === "{") {
      const end = source.indexOf("}", index + 2);
      const digits = end < 0 ? "" : source.slice(index + 2, end);
      if (/^[0-9a-f]{1,6}$/i.test(digits)) {
        return { value: String.fromCodePoint(Number.parseInt(digits, 16)), next: end + 1 };
      }
    }
    const digits = source.slice(index + 1, index + 5);
    if (/^[0-9a-f]{4}$/i.test(digits)) return { value: String.fromCharCode(Number.parseInt(digits, 16)), next: index + 5 };
  }
  return { value: char, next: index + 1 };
};

const tokenize = (source: string): Token[] => {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (/\s/u.test(char)) { index++; continue; }
    if (char === "/" && source[index + 1] === "/") {
      index = source.indexOf("\n", index + 2);
      if (index < 0) break;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      const quote = char;
      let value = "";
      let dynamicTemplate = false;
      index++;
      while (index < source.length) {
        const current = source[index]!;
        if (current === quote) { index++; break; }
        if (quote === "`" && current === "$" && source[index + 1] === "{") dynamicTemplate = true;
        if (current === "\\") {
          const escaped = readEscape(source, index + 1);
          value += escaped.value;
          index = escaped.next;
          continue;
        }
        value += current;
        index++;
      }
      if (!dynamicTemplate) tokens.push({ kind: "string", text: value });
      continue;
    }
    if (identifierStart(char)) {
      const start = index++;
      while (index < source.length && identifierPart(source[index]!)) index++;
      tokens.push({ kind: "identifier", text: source.slice(start, index) });
      continue;
    }
    tokens.push({ kind: "punctuation", text: char });
    index++;
  }
  return tokens;
};

export const fabricStringLiterals = (code: string): string[] =>
  tokenize(code).filter((token) => token.kind === "string").map((token) => token.text);

const propertyName = (token: Token | undefined): string | undefined =>
  token?.kind === "identifier" || token?.kind === "string" ? token.text : undefined;

const namedStringKey = (tokens: Token[], start: number, end: number): string | undefined => {
  if (tokens[start]?.text !== "π") return undefined;
  if (tokens[start + 1]?.text === "." && tokens[start + 2]?.kind === "identifier" && start + 3 === end) {
    return tokens[start + 2]!.text;
  }
  if (tokens[start + 1]?.text === "[" && tokens[start + 2]?.kind === "string" && tokens[start + 3]?.text === "]" && start + 4 === end) {
    return tokens[start + 2]!.text;
  }
  return undefined;
};

const objectBinding = (tokens: Token[], start: number): { binding?: FabricWriteBinding; next: number } => {
  let depth = 1;
  let index = start + 1;
  let path: string | undefined;
  let stringKey: string | undefined;
  while (index < tokens.length && depth > 0) {
    if (tokens[index]?.text === "{") { depth++; index++; continue; }
    if (tokens[index]?.text === "}") { depth--; index++; continue; }
    if (depth !== 1) { index++; continue; }
    const name = propertyName(tokens[index]);
    if (!name || tokens[index + 1]?.text !== ":") { index++; continue; }
    const valueStart = index + 2;
    let valueEnd = valueStart;
    let nested = 0;
    while (valueEnd < tokens.length) {
      const text = tokens[valueEnd]!.text;
      if (nested === 0 && (text === "," || text === "}")) break;
      if (text === "(" || text === "[" || text === "{") nested++;
      else if (text === ")" || text === "]" || text === "}") nested--;
      valueEnd++;
    }
    if (["path", "file", "file_path"].includes(name) && valueEnd === valueStart + 1 && tokens[valueStart]?.kind === "string") {
      path = tokens[valueStart]!.text;
    } else if (["content", "text", "contents"].includes(name)) {
      stringKey = namedStringKey(tokens, valueStart, valueEnd);
    }
    index = valueEnd;
  }
  return path !== undefined && stringKey !== undefined
    ? { binding: { path, stringKey }, next: index }
    : { next: index };
};

export const fabricWriteBindings = (code: string): FabricWriteBinding[] => {
  const tokens = tokenize(code);
  const bindings: FabricWriteBinding[] = [];
  for (let index = 0; index < tokens.length - 5; index++) {
    if (tokens[index]?.text !== "pi" || tokens[index + 1]?.text !== "." || tokens[index + 2]?.text !== "write" || tokens[index + 3]?.text !== "(" || tokens[index + 4]?.text !== "{") continue;
    const parsed = objectBinding(tokens, index + 4);
    if (parsed.binding) bindings.push(parsed.binding);
    index = parsed.next - 1;
  }
  return bindings;
};

const TITLE_MAX_CHARS = 80;
const TITLE_MAX_ANCHOR_CHARS = 40;
const TITLE_MAX_COMMAND_CHARS = 30;
const TITLE_MAX_TASK_CHARS = 40;
const TITLE_MAX_PATTERN_CHARS = 24;
const TITLE_MAX_KEY_CHARS = 24;
const TITLE_MAX_WINDOW_TOKENS = 96;
const TITLE_SAFE_ANCHOR = /^[A-Za-z0-9_./~@*+,-]+$/;
const TITLE_FILE_LIKE = /\.[A-Za-z0-9]{1,8}$/;

const PI_VERB_LABELS: Record<string, string> = {
  read: "Read",
  bash: "Shell",
  edit: "Edit",
  write: "Write",
  grep: "Search",
  find: "Search",
  ls: "Search",
};

const ROOT_VERB_LABELS: Record<string, string> = {
  agents: "Agent",
  memory: "Memory",
  state: "State",
  schema: "Schema",
  compact: "Compact",
  mesh: "Mesh",
  tools: "Tools",
};

const TITLE_PATH_KEYS = new Set(["path", "file", "file_path"]);

const humanizeIdentifier = (value: string): string =>
  value
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (char) => char.toUpperCase());

const titleAnchorPathLike = (value: string): boolean =>
  value.length > 0 &&
  value.length <= 64 &&
  TITLE_SAFE_ANCHOR.test(value) &&
  (value.includes("/") || TITLE_FILE_LIKE.test(value) || value.includes("*"));

const titleBasename = (value: string): string =>
  value.split("/").filter(Boolean).pop() ?? value;

const titleClip = (value: string, maxChars: number): string =>
  value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value;

const clipWords = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) return value;
  const cut = value.slice(0, maxChars - 1);
  const space = cut.lastIndexOf(" ");
  return `${space > 0 ? cut.slice(0, space) : cut}…`;
};

// Token range of one call's argument list: from just after the opening paren
// to the depth-matched close, capped so a malformed call cannot smear across
// the rest of the program.
const callWindow = (tokens: Token[], openIndex: number): { start: number; end: number } => {
  let depth = 0;
  let end = openIndex;
  while (end < tokens.length && end - openIndex < TITLE_MAX_WINDOW_TOKENS) {
    const text = tokens[end]!.text;
    if (text === "(" || text === "[" || text === "{") depth++;
    else if (text === ")" || text === "]" || text === "}") {
      depth--;
      if (depth <= 0) break;
    }
    end++;
  }
  return { start: openIndex + 1, end };
};

const isNamedStringToken = (tokens: Token[], index: number): boolean =>
  tokens[index]?.kind === "string" && tokens[index - 1]?.text === "[" && tokens[index - 2]?.text === "π";

const windowKeyedString = (
  tokens: Token[],
  start: number,
  end: number,
  keys: Set<string> | string,
): string | undefined => {
  for (let index = start; index < end; index++) {
    if (tokens[index]?.kind !== "string" || isNamedStringToken(tokens, index)) continue;
    if (tokens[index - 1]?.text !== ":") continue;
    const key = propertyName(tokens[index - 2]);
    if (key === undefined || !(typeof keys === "string" ? key === keys : keys.has(key))) continue;
    return tokens[index]!.text;
  }
  return undefined;
};

const windowFirstString = (tokens: Token[], start: number, end: number): string | undefined => {
  for (let index = start; index < end; index++) {
    if (tokens[index]?.kind === "string" && !isNamedStringToken(tokens, index)) return tokens[index]!.text;
  }
  return undefined;
};

const windowPathLike = (tokens: Token[], start: number, end: number): string | undefined => {
  for (let index = start; index < end; index++) {
    if (tokens[index]?.kind === "string" && !isNamedStringToken(tokens, index) && titleAnchorPathLike(tokens[index]!.text)) {
      return tokens[index]!.text;
    }
  }
  return undefined;
};

const dirQualifier = (value: string): string | undefined =>
  TITLE_FILE_LIKE.test(titleBasename(value))
    ? titleClip(titleBasename(value), TITLE_MAX_ANCHOR_CHARS)
    : TITLE_SAFE_ANCHOR.test(value) && value !== "." && value.length <= TITLE_MAX_ANCHOR_CHARS
      ? value
      : undefined;

const searchTarget = (tokens: Token[], start: number, end: number): string | undefined => {
  const pattern = windowKeyedString(tokens, start, end, "pattern");
  let head: string | undefined;
  if (pattern !== undefined) {
    if (titleAnchorPathLike(pattern)) head = titleClip(titleBasename(pattern), TITLE_MAX_ANCHOR_CHARS);
    else if (TITLE_SAFE_ANCHOR.test(pattern) && pattern.length <= TITLE_MAX_PATTERN_CHARS) head = `"${pattern}"`;
  }
  const pathValue = windowKeyedString(tokens, start, end, TITLE_PATH_KEYS);
  let tail: string | undefined = pathValue !== undefined ? dirQualifier(pathValue) : undefined;
  if (tail === undefined && pathValue === undefined) {
    // ls-style positional: the first bare string argument.
    const positional = windowFirstString(tokens, start, end);
    if (positional !== undefined && TITLE_SAFE_ANCHOR.test(positional) && positional.length <= TITLE_MAX_ANCHOR_CHARS) {
      tail = titleAnchorPathLike(positional) ? titleClip(titleBasename(positional), TITLE_MAX_ANCHOR_CHARS) : positional;
    }
  }
  if (head !== undefined && tail !== undefined) return `${head} in ${tail}`;
  return head ?? tail;
};

const pathTarget = (tokens: Token[], start: number, end: number): string | undefined => {
  const keyed = windowKeyedString(tokens, start, end, TITLE_PATH_KEYS);
  if (keyed !== undefined && TITLE_FILE_LIKE.test(titleBasename(keyed))) {
    return titleClip(titleBasename(keyed), TITLE_MAX_ANCHOR_CHARS);
  }
  const loose = windowPathLike(tokens, start, end);
  if (loose !== undefined) return titleClip(titleBasename(loose), TITLE_MAX_ANCHOR_CHARS);
  return keyed !== undefined ? dirQualifier(keyed) : undefined;
};

// Deterministic title for a script-mode payload. The compiled program is a
// constant, so tokenizing it yields a bare "Shell" for every script ever run.
// Only the command identity is retained: arguments may contain credentials,
// headers, URLs, or other payload text, and this title is reused by the compact
// card, activity, and durable compaction intent. Leading shebangs, comments,
// and shell-option preamble are skipped because they identify no work.
const SCRIPT_TITLE_PREAMBLE = /^(?:set|shopt|export|cd|source|\.)\b/;
const SCRIPT_TITLE_ASSIGNMENT =
  /^[A-Za-z_][A-Za-z0-9_]*=(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s]+)\s*/;

const scriptCommandName = (line: string): string | undefined => {
  let remaining = line.trimStart();
  while (true) {
    const assignment = SCRIPT_TITLE_ASSIGNMENT.exec(remaining);
    if (!assignment) break;
    remaining = remaining.slice(assignment[0].length);
  }
  const command = /^[A-Za-z0-9_./@+-]+/.exec(remaining)?.[0];
  return command ? titleBasename(command) : undefined;
};

export const fabricScriptTitleHint = (script: string): string | undefined => {
  const lines = script.split("\n");
  let fallback: string | undefined;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const command = scriptCommandName(trimmed);
    if (!command) continue;
    if (SCRIPT_TITLE_PREAMBLE.test(trimmed)) {
      fallback ??= command;
      continue;
    }
    return `Shell ${command}`;
  }
  return fallback === undefined ? undefined : `Shell ${fallback}`;
};

const piCallTarget = (
  label: string,
  tokens: Token[],
  start: number,
  end: number,
): string | undefined => {
  if (label === "Shell") {
    const command = windowFirstString(tokens, start, end);
    return command !== undefined ? titleClip(command.split("\n")[0]!, TITLE_MAX_COMMAND_CHARS) : undefined;
  }
  if (label === "Search") return searchTarget(tokens, start, end);
  return pathTarget(tokens, start, end);
};

// Deterministic lexical title for a fabric_exec program, derived without
// executing it. Every recognized call contributes "Verb target" — target is
// a basename, glob, quoted literal search head, command head, mcp ref, or
// task/key clip — and segments join in first-occurrence order under a char
// budget. π payload keys are skipped so named strings never surface in
// titles. Returns undefined when the program holds no recognizable Fabric
// call, letting callers keep a neutral fallback.
export const fabricExecTitleHint = (code: string): string | undefined => {
  const tokens = tokenize(code);
  const groups = new Map<string, (string | undefined)[]>();
  const record = (verb: string, target: string | undefined): void => {
    const list = groups.get(verb);
    if (list) list.push(target);
    else groups.set(verb, [target]);
  };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.kind !== "identifier") continue;
    if ((token.text === "agents" || token.text === "compact") && tokens[index + 1]?.text === "(") {
      const window = callWindow(tokens, index + 1);
      const target = token.text === "agents"
        ? (() => {
            const task = windowKeyedString(tokens, window.start, window.end, "task");
            return task !== undefined ? clipWords(task.split("\n")[0]!, TITLE_MAX_TASK_CHARS) : undefined;
          })()
        : undefined;
      record(ROOT_VERB_LABELS[token.text]!, target);
      continue;
    }
    const dot = tokens[index + 1];
    const leaf = tokens[index + 2];
    if (dot?.text !== "." || leaf?.kind !== "identifier") continue;
    if (token.text === "pi" && tokens[index + 3]?.text === "(") {
      const label = PI_VERB_LABELS[leaf.text] ?? humanizeIdentifier(leaf.text);
      const window = callWindow(tokens, index + 3);
      record(label, piCallTarget(label, tokens, window.start, window.end));
      continue;
    }
    if (
      token.text === "mcp" &&
      tokens[index + 3]?.text === "." &&
      tokens[index + 4]?.kind === "identifier" &&
      tokens[index + 5]?.text === "("
    ) {
      record("Mcp", `${leaf.text}.${tokens[index + 4]!.text}`);
      continue;
    }
    if (tokens[index + 3]?.text === "(") {
      const label = ROOT_VERB_LABELS[token.text];
      if (!label) continue;
      if (token.text === "memory" || token.text === "state") {
        const window = callWindow(tokens, index + 3);
        const key = windowKeyedString(tokens, window.start, window.end, "key");
        record(label, key !== undefined ? clipWords(key.split("\n")[0]!, TITLE_MAX_KEY_CHARS) : undefined);
      } else {
        record(label, undefined);
      }
    }
  }
  if (groups.size === 0) return undefined;
  const segments: string[] = [];
  for (const [verb, targets] of groups) {
    const first = targets.find((target) => target !== undefined);
    let segment = verb;
    if (first !== undefined) {
      segment = `${verb} ${first}`;
      if (targets.length > 1) {
        segment += targets.every((target) => target === first) ? ` ×${targets.length}` : ` +${targets.length - 1}`;
      }
    } else if (targets.length > 1) {
      segment += ` ×${targets.length}`;
    }
    segments.push(segment);
  }
  let title: string | undefined;
  let overflow = false;
  for (const segment of segments) {
    if (title === undefined) {
      title = segment.length <= TITLE_MAX_CHARS ? segment : clipWords(segment, TITLE_MAX_CHARS);
      continue;
    }
    const candidate = `${title} + ${segment}`;
    if (candidate.length <= TITLE_MAX_CHARS) {
      title = candidate;
      continue;
    }
    overflow = true;
    break;
  }
  if (overflow && title !== undefined && title.length + 3 <= TITLE_MAX_CHARS) title = `${title} +…`;
  return title;
};
