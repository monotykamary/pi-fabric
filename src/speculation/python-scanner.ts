import { parser } from "@lezer/python";
import { TreeFragment, type SyntaxNode } from "@lezer/common";
import { stableJsonHash } from "../core/stable-hash.js";
import { pythonArgumentsFor } from "../runtime/python-arguments.js";
import type { FabricSpeculationCandidate } from "./types.js";

const ROOTS = new Set(["pi", "memory", "state", "schema", "compact", "components", "mcp"]);
const FAIL = Symbol("unsupported Python literal");
const children = (node: SyntaxNode): SyntaxNode[] => {
  const result: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) result.push(child);
  return result;
};

// Decode Python strings without evaluation. Unsupported prefixes/escapes fail
// closed rather than approximating Python with JavaScript string semantics.
function stringValue(text: string): string {
  const match = /^(r|u)?('''|\"\"\"|'|\")/i.exec(text);
  if (!match) throw FAIL;
  const quote = match[2]!;
  if (!text.endsWith(quote) || text.length < match[0].length + quote.length) throw FAIL;
  const body = text.slice(match[0].length, -quote.length);
  if (match[1]?.toLowerCase() === "r") return body;
  return body.replace(/\\(\r\n|\n|[\s\S])/g, (_whole, escape: string) => {
    const simple: Record<string, string> = { "\\": "\\", "'": "'", '\"': '\"', n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", a: "\x07", v: "\x0b", "\n": "", "\r\n": "" };
    if (!Object.hasOwn(simple, escape)) throw FAIL;
    return simple[escape]!;
  });
}

function literal(node: SyntaxNode, code: string, depth = 0): unknown {
  if (depth > 48) throw FAIL;
  const text = code.slice(node.from, node.to);
  const parts = children(node);
  switch (node.name) {
    case "String": return stringValue(text);
    case "Boolean": return text === "True";
    case "None": return null;
    case "Number": {
      if (!/^(?:0[xX][\da-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?[\d_]+)?)$/.test(text)) throw FAIL;
      const value = Number(text.replaceAll("_", ""));
      if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) throw FAIL;
      return value;
    }
    case "UnaryExpression": {
      if (parts.length !== 2 || !["+", "-"].includes(code.slice(parts[0]!.from, parts[0]!.to))) throw FAIL;
      const value = literal(parts[1]!, code, depth + 1);
      if (typeof value !== "number") throw FAIL;
      return text.startsWith("-") ? -value : value;
    }
    case "ArrayExpression":
    case "TupleExpression": {
      if (!["[", "("].includes(parts[0]?.name ?? "") || !["]", ")"].includes(parts.at(-1)?.name ?? "")) throw FAIL;
      return parts.slice(1, -1).filter((part) => part.name !== ",").map((part) => literal(part, code, depth + 1));
    }
    case "DictionaryExpression": {
      if (parts[0]?.name !== "{" || parts.at(-1)?.name !== "}") throw FAIL;
      const result: Record<string, unknown> = Object.create(null);
      const entries = parts.slice(1, -1);
      for (let index = 0; index < entries.length;) {
        const key = literal(entries[index++]!, code, depth + 1);
        if (typeof key !== "string" || entries[index++]?.name !== ":" || !entries[index]) throw FAIL;
        result[key] = literal(entries[index++]!, code, depth + 1);
        if (index < entries.length && entries[index++]?.name !== ",") throw FAIL;
      }
      return result;
    }
    default: throw FAIL;
  }
}

function callRef(node: SyntaxNode, code: string): string | undefined {
  if (node.name === "VariableName") return code.slice(node.from, node.to);
  const parts = children(node);
  if (node.name !== "MemberExpression" || parts.length !== 3 || parts[1]?.name !== ".") return;
  const base = callRef(parts[0]!, code);
  return base ? `${base}.${code.slice(parts[2]!.from, parts[2]!.to)}` : undefined;
}

/** Python grammar, incremental tree reuse, and conservative lexical tainting. */
export class PythonLiteralCallScanner {
  #code = "";
  #fragments: readonly TreeFragment[] = [];
  readonly #emitted = new Set<string>();
  readonly #tainted = new Set<string>();

  push(code: string): FabricSpeculationCandidate[] {
    if (code === this.#code) return [];
    if (!code.startsWith(this.#code)) {
      this.#fragments = [];
      this.#code = "";
      this.#emitted.clear();
      this.#tainted.clear();
    }
    if (!code.slice(this.#code.length).includes(")") && code.startsWith(this.#code)) return [];
    const fragments = TreeFragment.applyChanges(this.#fragments, [{ fromA: this.#code.length, toA: this.#code.length, fromB: this.#code.length, toB: code.length }]);
    const tree = parser.parse(code, fragments);
    this.#fragments = TreeFragment.addTree(tree, [], true);
    this.#code = code;
    const calls: SyntaxNode[] = [];
    let firstError = Infinity;
    const walk = (node: SyntaxNode, nested = false): void => {
      if (node.type.isError) firstError = Math.min(firstError, node.from);
      const scoped = nested || /FunctionDefinition|ClassDefinition|LambdaExpression|Comprehension/.test(node.name);
      if (node.name === "VariableName" && ROOTS.has(code.slice(node.from, node.to))) {
        let member = node;
        while (member.parent?.name === "MemberExpression" && member.parent.firstChild?.from === member.from) member = member.parent;
        // Only a direct capability callee is unambiguous. Assignments, imports,
        // parameters, destructuring, aliases and namespace mutation taint roots.
        if (member === node || member.parent?.name !== "CallExpression" || member.parent.firstChild?.from !== member.from) {
          this.#tainted.add(code.slice(node.from, node.to));
        }
      }
      if (!scoped && node.name === "CallExpression") calls.push(node);
      for (const child of children(node)) walk(child, scoped);
    };
    walk(tree.topNode);
    const result: FabricSpeculationCandidate[] = [];
    for (const call of calls) {
      if (firstError < call.to) continue;
      try {
        const ref = call.firstChild && callRef(call.firstChild, code);
        if (!ref) continue;
        const segments = ref.split(".");
        if (!ROOTS.has(segments[0]!) || this.#tainted.has(segments[0]!) || !(segments.length === 2 || (segments[0] === "mcp" && segments.length === 3))) continue;
        const argsNode = call.lastChild;
        if (argsNode?.name !== "ArgList") continue;
        const parts = children(argsNode);
        if (parts[0]?.name !== "(" || parts.at(-1)?.name !== ")") continue;
        let invalid = false;
        const check = (node: SyntaxNode): void => { if (node.type.isError) invalid = true; for (const child of children(node)) check(child); };
        check(call);
        if (invalid) continue;
        const positional: unknown[] = [];
        const keywords: Record<string, unknown> = Object.create(null);
        const entries = parts.slice(1, -1);
        for (let index = 0; index < entries.length;) {
          const part = entries[index++]!;
          if (part.name === "VariableName" && entries[index]?.name === "AssignOp") {
            index++;
            const key = code.slice(part.from, part.to);
            if (Object.hasOwn(keywords, key) || !entries[index]) throw FAIL;
            keywords[key] = literal(entries[index++]!, code);
          } else {
            if (Object.keys(keywords).length) throw FAIL;
            positional.push(literal(part, code));
          }
          if (index < entries.length && entries[index++]?.name !== ",") throw FAIL;
        }
        const args = pythonArgumentsFor(ref, positional, keywords);
        const key = `${ref}\n${stableJsonHash(args)}`;
        if (this.#emitted.has(key)) continue;
        this.#emitted.add(key);
        result.push({ ref, args });
      } catch {
        // Incomplete, dynamic, or unsupported Python must execute normally.
      }
    }
    return result;
  }
}
