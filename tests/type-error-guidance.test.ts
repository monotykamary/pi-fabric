import { describe, expect, it } from "vitest";
import { GUEST_TYPE_DECLARATIONS } from "../src/runtime/guest-types.js";
import { typeCheckFabricCode } from "../src/runtime/type-checker.js";
import { typeErrorRecoveryHint } from "../src/type-error-guidance.js";

describe("typeErrorRecoveryHint", () => {
  it("guides unsupported pi.bash cwd toward an explicit directory change", () => {
    expect(typeErrorRecoveryHint(
      'await pi.bash({ command: "pnpm test", cwd: "apps/daemon" });',
      [{
        line: 1,
        column: 47,
        message:
          "Object literal may only specify known properties, and 'cwd' does not exist in type 'PiCommandArgument & PiBashOptions'.",
      }],
    )).toContain('pi.bash("cd <dir> && <command>")');
  });

  it("guides unsupported pi.bash stdin toward a file input", () => {
    expect(typeErrorRecoveryHint(
      'await pi.bash({ command: "gh issue create --body-file -", stdin: π.body });',
      [{
        line: 1,
        column: 61,
        message:
          "Object literal may only specify known properties, and 'stdin' does not exist in type 'PiCommandArgument & PiBashOptions'.",
      }],
    )).toContain("pi.write(path, content)");
  });

  it("recognizes the real TypeScript diagnostics for unsupported bash options", () => {
    const cases = [
      {
        code: 'await pi.bash({ command: "pnpm test", cwd: "apps/daemon" });',
        expected: 'pi.bash("cd <dir> && <command>")',
      },
      {
        code: 'await pi.bash({ command: "gh issue create --body-file -", stdin: π.body });',
        expected: "pi.write(path, content)",
      },
    ];

    for (const { code, expected } of cases) {
      const checked = typeCheckFabricCode(code, GUEST_TYPE_DECLARATIONS);
      expect(checked.errors.length).toBeGreaterThan(0);
      expect(typeErrorRecoveryHint(code, checked.errors)).toContain(expected);
    }
  });

  it("guides malformed edit payloads toward named strings", () => {
    expect(typeErrorRecoveryHint(
      'await pi.edit({ path: "x", oldText: "a", newText: "broken });',
      [{ line: 1, column: 55, message: "Unterminated string literal." }],
    )).toContain("top-level `strings`");
  });

  it("stays absent for semantic errors and unrelated code", () => {
    expect(typeErrorRecoveryHint(
      'await pi.edit({ path: "x", all: true });',
      [{ line: 1, column: 15, message: "Property oldText is missing." }],
    )).toBeUndefined();
    expect(typeErrorRecoveryHint(
      "return missingValue;",
      [{ line: 1, column: 8, message: "':' expected." }],
    )).toBeUndefined();
    expect(typeErrorRecoveryHint(
      'await pi.read({ path: "x", cwd: "y" });',
      [{
        line: 1,
        column: 28,
        message:
          "Object literal may only specify known properties, and 'cwd' does not exist in type 'PiReadArgument'.",
      }],
    )).toBeUndefined();
  });
});
