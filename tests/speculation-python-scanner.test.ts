import { describe, expect, it } from "vitest";
import { PythonLiteralCallScanner } from "../src/speculation/python-scanner.js";

const scan = (code: string) => new PythonLiteralCallScanner().push(code);
describe("Python speculation scanner", () => {
  it.each([
    ['await pi.read("x", 2, 5)', { path: "x", offset: 2, limit: 5 }],
    ['await pi.read(path="x", limit=5)', { path: "x", limit: 5 }],
    ['pi.read({"path": "x"}, limit=5)', { path: "x", limit: 5 }],
    ['pi.read("x", {"limit": 5})', { path: "x", limit: 5 }],
  ])("normalizes bridge arguments: %s", (code, args) => {
    expect(scan(code)).toEqual([{ ref: "pi.read", args }]);
  });
  it("handles Python values, nested literals, tuples, signs and trailing commas", () => {
    expect(scan('await memory.recall(query="x", extra={"a": [True, False, None, -2, +3.5, 0xff], "b": (1, 2),},)'))
      .toEqual([{ ref: "memory.recall", args: { query: "x", extra: { a: [true, false, null, -2, 3.5, 255], b: [1, 2] } } }]);
  });
  it("handles comments, raw/triple strings and escaped delimiters", () => {
    expect(scan('# pi.read("fake")\nawait pi.read(path=r"a\\b")')).toEqual([{ ref: "pi.read", args: { path: "a\\b" } }]);
    expect(scan('pi.read(path="""a\nb""")')).toEqual([{ ref: "pi.read", args: { path: "a\nb" } }]);
    expect(scan('pi.read(path="a\\\"b")')).toEqual([{ ref: "pi.read", args: { path: 'a"b' } }]);
  });
  it("emits only after a real closing delimiter, once across character deltas", () => {
    const scanner = new PythonLiteralCallScanner();
    const code = 'await pi.read(path="x)y")';
    const found = [];
    for (let i = 1; i <= code.length; i++) {
      const candidates = scanner.push(code.slice(0, i));
      if (i < code.length) expect(candidates).toEqual([]);
      found.push(...candidates);
    }
    expect(found).toEqual([{ ref: "pi.read", args: { path: "x)y" } }]);
    expect(scanner.push(code + '\nawait pi.read(path="x)y")')).toEqual([]);
    expect(scanner.push(code + '\nawait pi.read(path="x)y")\nawait compact.status()')).toEqual([{ ref: "compact.status", args: {} }]);
  });
  it.each([
    'pi.read(path=name)', 'pi.read(**{"path": "x"})', 'pi.read(*["x"])',
    'pi.read(path=f"{x}")', 'pi.read(path=b"x")', 'pi.read(path="\\N{SPACE}")',
    'pi.read({"path":"x"}, path="y")', 'pi.read(limit=9007199254740993)',
    'pi.read(limit=1j)', 'pi.read(path="x"', 'pi.read(path="x", limit=)',
    '"pi.read(path=123)"', '# pi.read(path="x")',
    'pi = other\npi.read("x")', 'pi, x = pair\npi.read("x")',
    'import x as pi\npi.read("x")', 'from x import pi\npi.read("x")',
    'for pi in xs:\n pi.read("x")', 'with other as pi:\n pi.read("x")',
    'def f(pi):\n return pi.read("x")', 'lambda pi: pi.read("x")',
    '[pi.read("x") for pi in xs]', 'pi.read = other\npi.read("x")',
    'alias = pi\npi.read("x")', 'pi["read"]("x")',
    'try:\n pass\nexcept Exception as pi:\n pi.read("x")',
    'match value:\n case pi:\n  pi.read("x")',
    '(pi := other).read("x")', 'def pi():\n pass\npi.read("x")',
  ])("fails closed: %s", (code) => { expect(scan(code)).toEqual([]); });
  it("resets incremental parse state when a prefix is replaced", () => {
    const scanner = new PythonLiteralCallScanner();
    expect(scanner.push('await pi.read(path="long-path")')).toHaveLength(1);
    expect(scanner.push("compact.status()")).toEqual([{ ref: "compact.status", args: {} }]);
  });
  it("supports MCP chains and does not taint unrelated namespace names", () => {
    expect(scan('other = 2\nawait mcp.demo.read(query="x")')).toEqual([{ ref: "mcp.demo.read", args: { query: "x" } }]);
  });
});
