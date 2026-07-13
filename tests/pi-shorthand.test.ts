import { describe, expect, it, vi } from "vitest";
import { GUEST_TYPE_DECLARATIONS } from "../src/runtime/guest-types.js";
import { typeCheckFabricCode } from "../src/runtime/type-checker.js";
import { QuickJsRuntime } from "../src/runtime/quickjs-runtime.js";

const options = { timeoutMs: 5_000, memoryLimitBytes: 32 * 1024 * 1024 };

describe("pi bare-string shorthand", () => {
  it("type-checks bare-string calls for string-primary pi tools", () => {
    const result = typeCheckFabricCode(
      'const a = await pi.bash("echo hi"); const b = await pi.read("x"); const c = await pi.ls("y"); const d = await pi.grep("z"); const e = await pi.find("w"); return { a: a.output, b, c, d, e };',
      GUEST_TYPE_DECLARATIONS,
    );
    expect(result.errors).toEqual([]);
  });

  it("defers non-string scalars and bare strings to object-only tools to runtime", () => {
    // Functional-errors-only: wrong arg type and bare strings to object-only
    // tools are no longer type-check errors — they surface at runtime instead.
    const bad = typeCheckFabricCode('await pi.bash(123); return "never";', GUEST_TYPE_DECLARATIONS);
    expect(bad.errors).toEqual([]);

    const editBad = typeCheckFabricCode('await pi.edit("/x"); return "never";', GUEST_TYPE_DECLARATIONS);
    expect(editBad.errors).toEqual([]);
  });

  it("coerces bare-string calls at runtime and passes object form through", async () => {
    const hostCall = vi.fn(async (ref: string, args: Record<string, unknown>) => {
      if (ref === "pi.bash") return { ok: true, output: String(args.command), details: null };
      if (ref === "pi.read") return String(args.path);
      throw new Error("Unexpected call: " + ref);
    });
    const result = await new QuickJsRuntime().execute(
      'const a = await pi.bash("echo hi"); const b = await pi.bash({ command: "ls", timeout: 5 }); const c = await pi.read("/x"); return { a: a.output, b: b.output, c };',
      hostCall,
      options,
    );
    expect(result.error).toBeUndefined();
    expect(hostCall.mock.calls[0]?.[0]).toBe("pi.bash");
    expect(hostCall.mock.calls[0]?.[1]).toEqual({ command: "echo hi" });
    expect(hostCall.mock.calls[1]?.[0]).toBe("pi.bash");
    expect(hostCall.mock.calls[1]?.[1]).toEqual({ command: "ls", timeout: 5 });
    expect(hostCall.mock.calls[2]?.[0]).toBe("pi.read");
    expect(hostCall.mock.calls[2]?.[1]).toEqual({ path: "/x" });
    expect(result.value).toEqual({ a: "echo hi", b: "ls", c: "/x" });
  });
});

describe("pi argument alias flattening", () => {
  it("type-checks common alias keys and the flat edit shape", () => {
    const result = typeCheckFabricCode(
      'const a = await pi.bash({ cmd: "echo hi" });' +
        'const b = await pi.find({ query: "*.ts" });' +
        'const c = await pi.read({ file: "/x" });' +
        'const d = await pi.write({ file: "/y", content: "z" });' +
        'const e = await pi.edit({ file: "/x", oldText: "a", newText: "b" });' +
        'const f = await pi.ls({ dir: "/s" });' +
        'return { a: a.output, b, c, d: d.output, e: e.output, f };',
      GUEST_TYPE_DECLARATIONS,
    );
    expect(result.errors).toEqual([]);
  });

  it("normalizes alias keys and the flat edit shape at runtime", async () => {
    const hostCall = vi.fn(async (ref: string, args: Record<string, unknown>) => {
      if (ref === "pi.bash") return { ok: true, output: String(args.command), details: null };
      if (ref === "pi.find") return "found";
      if (ref === "pi.read") return "read";
      if (ref === "pi.write") return { ok: true, output: "wrote", details: null };
      if (ref === "pi.edit") return { ok: true, output: "edited", details: null };
      if (ref === "pi.ls") return "listed";
      throw new Error("Unexpected call: " + ref);
    });
    const result = await new QuickJsRuntime().execute(
      'const a = await pi.bash({ cmd: "echo hi" });' +
        'const b = await pi.find({ query: "*.ts" });' +
        'const c = await pi.read({ file: "/x" });' +
        'const d = await pi.write({ file: "/y", content: "z" });' +
        'const e = await pi.edit({ file: "/x", oldText: "a", newText: "b" });' +
        'const f = await pi.ls({ dir: "/s" });' +
        'return { a: a.output, b, c, d: d.output, e: e.output, f };',
      hostCall,
      options,
    );
    expect(result.error).toBeUndefined();
    expect(hostCall.mock.calls[0]?.[1]).toEqual({ command: "echo hi" });
    expect(hostCall.mock.calls[1]?.[1]).toEqual({ pattern: "*.ts" });
    expect(hostCall.mock.calls[2]?.[1]).toEqual({ path: "/x" });
    expect(hostCall.mock.calls[3]?.[1]).toEqual({ path: "/y", content: "z" });
    expect(hostCall.mock.calls[4]?.[1]).toEqual({ path: "/x", edits: [{ oldText: "a", newText: "b" }] });
    expect(hostCall.mock.calls[5]?.[1]).toEqual({ path: "/s" });
    expect(result.value).toEqual({ a: "echo hi", b: "found", c: "read", d: "wrote", e: "edited", f: "listed" });
  });
});

describe("agents.status debug fields", () => {
  it("type-checks text/value/error/logFile on the status union without narrowing", () => {
    const result = typeCheckFabricCode(
      'const s = await agents.status({ id: "x" });' +
        'return { error: s.error, text: s.text, value: s.value, log: s.logFile };',
      GUEST_TYPE_DECLARATIONS,
    );
    expect(result.errors).toEqual([]);
  });
});
