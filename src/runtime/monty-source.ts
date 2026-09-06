interface Token { text: string; string?: boolean }
interface PreparedSource { source: string; lines: string[] }

// Validate before native conversion: Monty otherwise renders recursive containers
// as strings such as "[...]", losing the evidence needed for host-side rejection.
export const MONTY_BOOTSTRAP_SOURCE = `import asyncio

def __fabric_validate(value, active, depth):
    if depth > 48:
        raise ValueError("Monty JSON value exceeds the depth limit")
    kind = type(value)
    if value is None or kind is str or kind is bool:
        return value
    if kind is int:
        if value < -9007199254740991 or value > 9007199254740991:
            raise ValueError("Monty JSON integers must be safe integers")
        return value
    if kind is float:
        if value != value or value == float("inf") or value == float("-inf"):
            raise ValueError("Monty JSON numbers must be finite")
        return value
    if kind is not list and kind is not tuple and kind is not dict:
        raise TypeError("Monty boundary requires JSON-compatible values")
    for previous in active:
        if value is previous:
            raise ValueError("Monty boundary cannot serialize cyclic values")
    active.append(value)
    if kind is dict:
        for key, item in value.items():
            if type(key) is not str:
                raise TypeError("Monty JSON dictionary keys must be strings")
            __fabric_validate(item, active, depth + 1)
    else:
        for item in value:
            __fabric_validate(item, active, depth + 1)
    active.pop()
    return value
`;

/** A lexical pass only: Monty's parser remains authoritative for Python syntax. */
export function prepareMontySource(code: string, payloads: Record<string, string>): PreparedSource {
  code = code.replace(/\r\n?/g, "\n");
  const tokens: Token[] = [];
  const stringContinuations = new Set<number>();
  let line = 0;
  let index = 0;
  let stringDepth = 0;
  const boundary = (): void => { tokens.push({ text: "" }); };
  const advance = (): void => {
    if (code[index++] === "\n") {
      line++;
      if (stringDepth) stringContinuations.add(line);
    }
  };
  const checkDepth = (depth: number): void => {
    // Fail closed rather than silently omitting deeply nested replacement fields.
    if (depth > 64) throw new Error("Pre-execution check: f-string lexical nesting exceeds the depth limit (64)");
  };
  const scanFormat = (depth: number): void => {
    checkDepth(depth);
    while (index < code.length) {
      if (code[index] === "}") { advance(); return; }
      if (code[index] === "{") {
        advance();
        boundary();
        scanCode(true, depth + 1);
        boundary();
      } else advance();
    }
  };
  const scanString = (prefix: string, depth: number): void => {
    checkDepth(depth);
    const start = index;
    const char = code[index]!;
    const quote = code.slice(index, index + 3) === char.repeat(3) ? char.repeat(3) : char;
    const formatted = /f/i.test(prefix);
    const raw = /r/i.test(prefix);
    if (formatted) boundary();
    stringDepth++;
    index += quote.length;
    while (index < code.length) {
      if (code.startsWith(quote, index)) { index += quote.length; break; }
      if (formatted && code[index] === "{") {
        advance();
        if (code[index] === "{") { advance(); continue; }
        boundary();
        scanCode(true, depth + 1);
        boundary();
      } else if (formatted && code[index] === "}" && code[index + 1] === "}") {
        index += 2;
      } else if (code[index] === "\\") {
        advance();
        // Backslashes never escape replacement braces. Named Unicode escapes
        // are literal text, however, and may themselves contain braces.
        if (formatted && !raw && code.startsWith("N{", index)) {
          index += 2;
          while (index < code.length && code[index] !== "}") advance();
          if (index < code.length) advance();
        } else if (index < code.length && (!formatted || !["{", "}"].includes(code[index]!))) advance();
      } else advance();
    }
    stringDepth--;
    if (formatted) boundary();
    else tokens.push({ text: prefix + code.slice(start, index), string: true });
  };
  const scanCode = (field: boolean, depth: number): void => {
    checkDepth(depth);
    const brackets: string[] = [];
    while (index < code.length) {
      const start = index;
      const char = code[index]!;
      if (/\s/.test(char)) { advance(); continue; }
      if (char === "#") { while (index < code.length && code[index] !== "\n") advance(); continue; }
      if (field && brackets.length === 0) {
        if (char === "}") { advance(); return; }
        if (char === ":") { advance(); boundary(); scanFormat(depth + 1); return; }
        if (char === "!" && code[index + 1] !== "=") {
          // Conversion flags are not expressions; leave validity to Monty.
          while (index < code.length && ![":", "}"].includes(code[index]!)) advance();
          continue;
        }
      }
      if (char === "'" || char === '"') { scanString("", depth + 1); continue; }
      if (/[\p{L}_]/u.test(char)) {
        advance();
        while (index < code.length && /[\p{L}\p{N}_]/u.test(code[index]!)) advance();
        const name = code.slice(start, index);
        if (/^(?:r|u|b|f|br|rb|fr|rf)$/i.test(name) && ["'", '"'].includes(code[index] ?? "")) {
          scanString(name, depth + 1);
          continue;
        }
      } else {
        if ("([{".includes(char)) brackets.push(char);
        else if (")]}".includes(char)) brackets.pop();
        advance();
      }
      tokens.push({ text: code.slice(start, index) });
    }
  };
  scanCode(false, 0);
  const missing = new Set<string>();
  for (let index = 0; index < tokens.length; index++) {
    const root = tokens[index]!;
    if (root.string || !["π", "payloads"].includes(root.text) || tokens[index - 1]?.text === ".") continue;
    const next = tokens[index + 1];
    const key = tokens[index + 2];
    if (root.text === "π" && next?.text === "." && key && /^[\p{L}_][\p{L}\p{N}_]*$/u.test(key.text)) {
      if (!Object.hasOwn(payloads, key.text)) missing.add(key.text);
    } else if (next?.text === "[" && key?.string && tokens[index + 3]?.text === "]") {
      // Escaped/dynamic keys are checked by the guest dictionary at runtime.
      const match = /^(?:r|u)?('''|"""|'|")([^\\\n]*?)\1$/i.exec(key.text);
      if (match && !Object.hasOwn(payloads, match[2]!)) missing.add(match[2]!);
    }
  }
  if (missing.size) throw new Error("Pre-execution check: missing payloads " + [...missing].sort().join(", ") + "; pass these keys in fabric_exec.payloads");
  const lines = code.split("\n");
  const indented = lines.map((_, index) => !stringContinuations.has(index));
  const body = code.split("\n").map((text, index) => (indented[index] ? "    " : "") + text).join("\n");
  // A trailing pass permits empty/comment-only bodies without shifting user lines.
  return { source: "async def __fabric_program():\n" + body + "\n    pass\n\n__fabric_validate(await __fabric_program(), [], 0)", lines };
}

export function montyErrorText(error: unknown, prepared?: PreparedSource): string {
  const bound = (text: string): string => text.length <= 16000 ? text : text.slice(0, 7900) + "\n[Python traceback truncated]\n" + text.slice(-8000);
  if (!(error instanceof Error)) return bound(String(error));
  const native = error as Error & {
    exception?: { typeName: string; message: string };
    display?: (format: "traceback") => string;
    traceback?: () => { filename: string; line: number; column: number; functionName?: string }[];
  };
  if (!prepared) return bound(error.message);
  const summary = native.exception ? native.exception.typeName + ": " + native.exception.message : error.message;
  if (native.traceback) {
    const frames = native.traceback().filter((frame) => frame.filename === "<python-input-1>" && frame.line >= 2 && frame.line <= prepared.lines.length + 1).slice(-24);
    return bound(frames.length ? "Traceback (most recent call last):\n" + frames.map((frame) => {
      const line = frame.line - 1;
      const name = frame.functionName === "__fabric_program" ? "<fabric_exec>" : frame.functionName ?? "<fabric_exec>";
      return `  File "fabric-exec.py", line ${line}, in ${name}\n    ${prepared.lines[line - 1]!.trimStart().slice(0, 240)}`;
    }).join("\n") + "\n" + summary : summary);
  }
  if (native.display) {
    try {
      return bound(native.display("traceback").replace(/File "[^"]+", line (\d+)/g, (_text, number: string) => {
        const line = Math.max(1, Math.min(prepared.lines.length, Number(number) - 1));
        return `File "fabric-exec.py", line ${line}`;
      }));
    } catch { /* Base/crash errors do not accept traceback formatting. */ }
  }
  return bound(summary);
}
