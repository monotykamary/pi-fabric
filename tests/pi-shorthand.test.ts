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

describe("pi positional args", () => {
  it("type-checks multi-arg positional calls", () => {
    const result = typeCheckFabricCode(
      'const a = await pi.grep("TODO", "src");' +
        'const b = await pi.find("*.ts", "src", 10);' +
        'const c = await pi.write("/x", "content");' +
        'const d = await pi.edit("/y", "old", "new");' +
        'return { a, b, c: c.output, d: d.output };',
      GUEST_TYPE_DECLARATIONS,
    );
    expect(result.errors).toEqual([]);
  });

  it("maps positional args to canonical object form at runtime", async () => {
    const hostCall = vi.fn(async (ref: string, args: Record<string, unknown>) => {
      if (ref === "pi.grep") return "g";
      if (ref === "pi.find") return "f";
      if (ref === "pi.write") return { ok: true, output: "w", details: null };
      if (ref === "pi.edit") return { ok: true, output: "e", details: null };
      throw new Error("Unexpected call: " + ref);
    });
    const result = await new QuickJsRuntime().execute(
      'const a = await pi.grep("TODO", "src");' +
        'const b = await pi.find("*.ts", "src", 10);' +
        'const c = await pi.write("/x", "content");' +
        'const d = await pi.edit("/y", "old", "new");' +
        'return { a, b, c: c.output, d: d.output };',
      hostCall,
      options,
    );
    expect(result.error).toBeUndefined();
    expect(hostCall.mock.calls[0]?.[1]).toEqual({ pattern: "TODO", path: "src" });
    expect(hostCall.mock.calls[1]?.[1]).toEqual({ pattern: "*.ts", path: "src", limit: 10 });
    expect(hostCall.mock.calls[2]?.[1]).toEqual({ path: "/x", content: "content" });
    expect(hostCall.mock.calls[3]?.[1]).toEqual({ path: "/y", edits: [{ oldText: "old", newText: "new" }] });
    expect(result.value).toEqual({ a: "g", b: "f", c: "w", d: "e" });
  });

  it("type-check-rejects 2-arg calls to one-field tools so the extra arg is not silently dropped", () => {
    const result = typeCheckFabricCode('await pi.read("/x", 10); return "never";', GUEST_TYPE_DECLARATIONS);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => /argument/i.test(e.message))).toBe(true);
  });
});

describe("pi expanded argument aliases", () => {
  it("type-checks expanded alias keys", () => {
    const result = typeCheckFabricCode(
      'const a = await pi.bash({ shell: "ls", timeoutMs: 5 });' +
        'const b = await pi.grep({ regex: "TODO", ic: true, ctx: 2, max: 5, globPattern: "*.ts" });' +
        'const c = await pi.find({ search: "*.ts", max: 3 });' +
        'const d = await pi.read({ path: "/x", start: 0, max: 10 });' +
        'const e = await pi.write({ path: "/y", text: "z" });' +
        'const f = await pi.edit({ path: "/x", old: "a", new: "b" });' +
        'const g = await pi.ls({ file: "/s", max: 2 });' +
        'return { a: a.output, b, c, d, e: e.output, f: f.output, g };',
      GUEST_TYPE_DECLARATIONS,
    );
    expect(result.errors).toEqual([]);
  });

  it("normalizes expanded alias keys at runtime", async () => {
    const hostCall = vi.fn(async (ref: string, args: Record<string, unknown>) => {
      if (ref === "pi.bash") return { ok: true, output: String(args.command), details: null };
      if (ref === "pi.grep") return "g";
      if (ref === "pi.find") return "f";
      if (ref === "pi.read") return "r";
      if (ref === "pi.write") return { ok: true, output: "w", details: null };
      if (ref === "pi.edit") return { ok: true, output: "e", details: null };
      if (ref === "pi.ls") return "l";
      throw new Error("Unexpected call: " + ref);
    });
    const result = await new QuickJsRuntime().execute(
      'const a = await pi.bash({ shell: "ls", timeoutMs: 5 });' +
        'const b = await pi.grep({ regex: "TODO", ic: true, ctx: 2, max: 5, globPattern: "*.ts" });' +
        'const c = await pi.find({ search: "*.ts", max: 3 });' +
        'const d = await pi.read({ path: "/x", start: 0, max: 10 });' +
        'const e = await pi.write({ path: "/y", text: "z" });' +
        'const f = await pi.edit({ path: "/x", old: "a", new: "b" });' +
        'const g = await pi.ls({ file: "/s", max: 2 });' +
        'return { a: a.output, b, c, d, e: e.output, f: f.output, g };',
      hostCall,
      options,
    );
    expect(result.error).toBeUndefined();
    expect(hostCall.mock.calls[0]?.[1]).toEqual({ command: "ls", timeout: 5 });
    expect(hostCall.mock.calls[1]?.[1]).toEqual({ pattern: "TODO", ignoreCase: true, context: 2, limit: 5, glob: "*.ts" });
    expect(hostCall.mock.calls[2]?.[1]).toEqual({ pattern: "*.ts", limit: 3 });
    expect(hostCall.mock.calls[3]?.[1]).toEqual({ path: "/x", offset: 0, limit: 10 });
    expect(hostCall.mock.calls[4]?.[1]).toEqual({ path: "/y", content: "z" });
    expect(hostCall.mock.calls[5]?.[1]).toEqual({ path: "/x", edits: [{ oldText: "a", newText: "b" }] });
    expect(hostCall.mock.calls[6]?.[1]).toEqual({ path: "/s", limit: 2 });
    expect(result.value).toEqual({ a: "ls", b: "g", c: "f", d: "r", e: "w", f: "e", g: "l" });
  });
});

describe("tools discovery proxy", () => {
  it("routes discovery methods to the host and rejects core-tool names with a pi hint", async () => {
    const hostCall = vi.fn(async (ref: string, args: Record<string, unknown>) => {
      if (ref === "fabric.$providers") return [{ name: "pi", description: "Pi core" }];
      if (ref === "fabric.$list") return [];
      throw new Error("Unexpected call: " + ref);
    });
    const result = await new QuickJsRuntime().execute(
      'const p = await tools.providers();' +
        'const l = await tools.list({});' +
        'let err = ""; try { tools.read({ path: "/x" }); } catch (e) { err = String(e); }' +
        'return { providers: p.length, list: l.length, err };',
      hostCall,
      options,
    );
    expect(result.error).toBeUndefined();
    expect(hostCall.mock.calls[0]?.[0]).toBe("fabric.$providers");
    expect(hostCall.mock.calls[1]?.[0]).toBe("fabric.$list");
    const value = result.value as { providers: number; list: number; err: string };
    expect(value.providers).toBe(1);
    expect(value.list).toBe(0);
    expect(value.err).toContain("tools.read is not available");
    expect(value.err).toContain("pi.read");
  });
});
