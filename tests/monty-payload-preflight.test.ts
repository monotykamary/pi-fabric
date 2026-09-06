import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { MontyRuntime } from "../src/runtime/monty-runtime.js";
import { prepareMontySource } from "../src/runtime/monty-source.js";

const require = createRequire(import.meta.url);
let available = true;
try {
  const nativeRequire = createRequire(require.resolve("@pydantic/monty/node"));
  const triple = process.platform === "darwin" ? `darwin-${process.arch}` : process.platform === "linux" ? `linux-${process.arch}-gnu` : "win32-x64-msvc";
  nativeRequire.resolve(`@pydantic/monty-${triple}/${process.platform === "win32" ? "monty.exe" : "monty"}`);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error;
  available = false;
}
const options = { timeoutMs: 5000, memoryLimitBytes: 64 * 1024 * 1024 };
const missingExpressions = [
  'f"{π.missing}"',
  'f"{payloads[\'missing\']}"',
  'f"{payloads["missing"]}"',
  'f"{π[\'missing\']}"',
  'F"{π.missing!r}"',
  'rf"\\path {π.missing}"',
  'Fr"\\path {payloads[\'missing\']}"',
  'f"{{escaped}} {{{π.missing}}}"',
  'f"{f\'{π.missing}\'}"',
  'f"{f"{payloads["missing"]}"}"',
  'f"{\'x\':{π.missing}}"',
  'f"{\'x\':{payloads[\'missing\']}}"',
  'f"{\'x\':{f\'{π.missing}\'}}"',
  'f"{\'x\':{\'y\':{π.missing}}}"',
  'f"{ {\'k\': π.missing}[\'k\'] }"',
  'f"{[π.missing][0]}"',
  'f"{(π.missing != \'x\')}"',
  'f"{payloads[r\'missing\']}"',
  'f"{payloads[\'\'\'missing\'\'\']}"',
  'f"""first\n{π.missing}\nlast"""',
  'f"""{(\n# ignored π.other\nπ.missing\n)}"""',
  'rf"\\{π.missing}"',
];

describe("Monty lexical payload preflight", () => {
  it.each(missingExpressions)("extracts direct references in %s", (expression) => {
    expect(() => prepareMontySource(`await schema.status()\nreturn ${expression}`, {})).toThrow("Pre-execution check: missing payloads missing;");
    expect(() => prepareMontySource(`return ${expression}`, { missing: "ok" })).not.toThrow();
  });

  it.each([
    'f"π.missing payloads[\'missing\']"',
    'f"{{π.missing}} {{payloads[\'missing\']}}"',
    'rf"{{π.missing}}"',
    'f"{\'π.missing\'}"',
    'f"{\'x\':π.missing}"',
    'f"{\'x\':payloads[\'missing\']}"',
    'f"{\'x\':{\'π.missing\'}}"',
    'f"{f\'{{π.missing}}\'}"',
    'f"{obj.π.missing}"',
    'f"{payloads[key]}"',
    'f"{payloads[f\'missing\']}"',
    'f"{payloads[\'miss\' + \'ing\']}"',
    'f"{payloads[\'miss\\x69ng\']}"',
    'f"""{(1 # π.missing\n)}"""',
    'f"\\N{GREEK SMALL LETTER PI}"',
  ])("does not treat literal text or dynamic keys as direct references: %s", (expression) => {
    expect(() => prepareMontySource(`# π.missing\nreturn ${expression}`, {})).not.toThrow();
  });

  it("does not join tokens across replacement fields", () => {
    expect(() => prepareMontySource('return f"{π}{\'.\'}{missing}"', {})).not.toThrow();
  });

  it("sorts and deduplicates references across normal and nested expressions", () => {
    expect(() => prepareMontySource('return [π.z, f"{π.a} {f\'{π.z}\'}"]', {})).toThrow("missing payloads a, z;");
  });

  it("preserves multiline source, wrapping and original lines", () => {
    const code = 'text = rf"""first\n  {{π.missing}}\n{π.body}\nlast"""\nreturn text';
    const prepared = prepareMontySource(code, { body: "ok" });
    expect(prepared.lines).toEqual(code.split("\n"));
    expect(prepared.source).toBe('async def __fabric_program():\n    text = rf"""first\n  {{π.missing}}\n{π.body}\nlast"""\n    return text\n    pass\n\n__fabric_validate(await __fabric_program(), [], 0)');
  });

  it("bounds recursive f-string lexing instead of skipping deeper checks", () => {
    let expression = "π.missing";
    for (let depth = 0; depth < 1000; depth++) expression = `f"{${expression}}"`;
    expect(() => prepareMontySource(`return ${expression}`, {})).toThrow("f-string lexical nesting exceeds the depth limit (64)");
  });
});

describe.skipIf(!available)("Monty real-runtime f-string preflight", () => {
  it.each(missingExpressions)("prevents host effects for %s", async (expression) => {
    const host = vi.fn(async () => null);
    const result = await new MontyRuntime().execute(`await schema.status()\nreturn ${expression}`, host, options);
    expect(result.terminationReason).toBe("runtime_error");
    expect(result.error).toContain("Pre-execution check: missing payloads missing;");
    expect(host).toHaveBeenCalledTimes(0);
  });

  it.each([
    ['f"{π.body}"', "ok"],
    ['f"{payloads["body"]}"', "ok"],
    ['f"{f"{π.body}"}"', "ok"],
    ['rf"\\path {{π.missing}} {π.body}"', "\\path {π.missing} ok"],
    ['Fr"{π.body}"', "ok"],
    ['f"{\'x\':{π.width}}"', "x  "],
    ['f"{\'x\':{f\'{π.width}\'}}"', "x  "],
    ['f"{\'π.missing\'} {{π.missing}}"', "π.missing {π.missing}"],
    ['rf"""first\n  {{π.missing}}\n{π.body}\nlast"""', "first\n  {π.missing}\nok\nlast"],
  ])("executes supplied payloads and literal text unchanged: %s", async (expression, expected) => {
    const host = vi.fn(async () => null);
    const result = await new MontyRuntime().execute(`await schema.status()\nreturn ${expression}`, host, { ...options, strings: { body: "ok", width: "3" } });
    expect(result.error).toBeUndefined();
    expect(result.value).toBe(expected);
    expect(host).toHaveBeenCalledTimes(1);
  });

  it("leaves dynamic keys to runtime lookup after earlier effects", async () => {
    const host = vi.fn(async () => null);
    const result = await new MontyRuntime().execute('key = "missing"\nawait schema.status()\nreturn f"{payloads[key]}"', host, options);
    expect(result.error).toContain("KeyError");
    expect(result.error).not.toContain("Pre-execution check");
    expect(host).toHaveBeenCalledTimes(1);
  });

  it("leaves format literal validity and malformed syntax to the native parser/runtime", async () => {
    for (const expression of ['f"{\'x\':π.missing}"', 'f"{1 +}"']) {
      const result = await new MontyRuntime().execute(`return ${expression}`, async () => null, options);
      expect(result.terminationReason).toBe("runtime_error");
      expect(result.error).not.toContain("Pre-execution check");
      expect(result.error).toMatch(/ValueError|SyntaxError/);
    }
  });

  it("retains user line mapping after a multiline f-string", async () => {
    const result = await new MontyRuntime().execute('text = f"""first\n{π.body}\nlast"""\nraise ValueError("after literal")', async () => null, { ...options, strings: { body: "ok" } });
    expect(result.error).toContain('File "fabric-exec.py", line 4');
    expect(result.error).toContain('raise ValueError("after literal")');
  });
});
