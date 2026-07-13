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

  it("rejects non-string scalars and keeps object-only tools rejecting bare strings", () => {
    const bad = typeCheckFabricCode('await pi.bash(123); return "never";', GUEST_TYPE_DECLARATIONS);
    expect(bad.errors.length).toBeGreaterThan(0);
    expect(bad.errors[0]?.message).toContain("number");

    const editBad = typeCheckFabricCode('await pi.edit("/x"); return "never";', GUEST_TYPE_DECLARATIONS);
    expect(editBad.errors.length).toBeGreaterThan(0);
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
