import { describe, expect, it } from "vitest";
import {
  prepareFabricExecArguments,
  resolveFabricExecProgram,
} from "../src/fabric-exec-arguments.js";

describe("prepareFabricExecArguments", () => {
  it("keeps canonical arguments unchanged", () => {
    const input = { code: "return 1;", tokenBudget: 10 };
    expect(prepareFabricExecArguments(input)).toBe(input);
    const withPayloads = { code: "return 1;", payloads: { body: "ok" } };
    expect(prepareFabricExecArguments(withPayloads)).toBe(withPayloads);
  });

  it("wraps a root code string before schema validation", () => {
    expect(prepareFabricExecArguments("return 1;")).toEqual({ code: "return 1;" });
  });

  it("joins all-string code arrays and leaves malformed arrays invalid", () => {
    expect(prepareFabricExecArguments({ code: ["const x = 1;", "return x;"] })).toEqual({
      code: "const x = 1;\nreturn x;",
    });
    const malformed = { code: ["return ", 1] };
    expect(prepareFabricExecArguments(malformed)).toBe(malformed);
  });

  it("omits null optional fields but preserves a null required code", () => {
    expect(prepareFabricExecArguments({
      code: null,
      payloads: null,
      strings: null,
      resultFormat: null,
      tokenBudget: null,
      agentBudget: undefined,
      display: null,
    })).toEqual({ code: null });
  });

  it("canonicalizes display shorthands before execution", () => {
    expect(prepareFabricExecArguments({ code: "return 1;", display: "Probe" })).toEqual({
      code: "return 1;",
      display: { name: "Probe" },
    });
    expect(prepareFabricExecArguments({
      code: "return 1;",
      display: '{"name":"Probe","description":"check"}',
    })).toEqual({
      code: "return 1;",
      display: { name: "Probe", description: "check" },
    });
  });

  it("remaps the strings alias onto payloads", () => {
    expect(prepareFabricExecArguments({
      code: "return π.body;",
      strings: { body: "ok" },
    })).toEqual({
      code: "return π.body;",
      payloads: { body: "ok" },
    });
    expect(prepareFabricExecArguments({
      code: "return π.body;",
      payloads: { body: "canonical" },
      strings: { body: "alias" },
    })).toEqual({
      code: "return π.body;",
      payloads: { body: "canonical" },
    });
  });

  it("parses JSON-object payload maps before schema validation", () => {
    const payload = { lifecycle: "#!/bin/sh\n# inventory" };
    expect(prepareFabricExecArguments({
      code: "return π.lifecycle;",
      payloads: JSON.stringify(payload),
    })).toEqual({
      code: "return π.lifecycle;",
      payloads: payload,
    });
    expect(prepareFabricExecArguments({
      code: "return π.body;",
      strings: JSON.stringify(JSON.stringify({ body: "ok" })),
    })).toEqual({
      code: "return π.body;",
      payloads: { body: "ok" },
    });
  });

  it("leaves malformed payload maps invalid on the canonical key", () => {
    expect(prepareFabricExecArguments({
      code: "return 1;",
      strings: "not-json",
    })).toEqual({
      code: "return 1;",
      payloads: "not-json",
    });
    expect(prepareFabricExecArguments({
      code: "return 1;",
      payloads: '["lifecycle"]',
    })).toEqual({
      code: "return 1;",
      payloads: '["lifecycle"]',
    });
    expect(prepareFabricExecArguments({
      code: "return 1;",
      strings: '{"n":1}',
    })).toEqual({
      code: "return 1;",
      payloads: '{"n":1}',
    });
  });
});

describe("prepareFabricExecArguments script mode", () => {
  const scriptOf = (args: unknown): unknown =>
    resolveFabricExecProgram(prepareFabricExecArguments(args)).strings;

  it("keeps the authored script through preparation and compiles at the execution seam", () => {
    const input = { script: "set -eu\nprintf 'done\\n'" };
    const prepared = prepareFabricExecArguments(input);
    expect(prepared).toBe(input);
    expect(resolveFabricExecProgram(prepared)).toEqual({
      kind: "script",
      code: "const result = await pi.bash(π.__fabric_script); return result.output;",
      strings: { __fabric_script: input.script },
    });
  });

  it("preserves the payload byte-for-byte", () => {
    const payload = "grep -oE '\\$\\{HOME\\}' <<'EOF'\n`x` \"y\" 'z' \\\\n\nEOF";
    expect(scriptOf({ script: payload })).toEqual({ __fabric_script: payload });
  });

  it("compiles execution options into the nested option object", () => {
    expect(resolveFabricExecProgram(
      prepareFabricExecArguments({ script: "ls", timeout: 600 }),
    )).toMatchObject({
      kind: "script",
      code: "const result = await pi.bash(π.__fabric_script, { timeout: 600 }); return result.output;",
      strings: { __fabric_script: "ls" },
    });
    expect(resolveFabricExecProgram(
      prepareFabricExecArguments({ script: "ls", settle: true }),
    )).toMatchObject({
      kind: "script",
      code:
        "const result = await pi.bash(π.__fabric_script, { settle: true }); "
        + "return result.ok ? { ok: true, exitCode: 0, output: result.output } : "
        + "{ ok: false, exitCode: result.exitCode, output: result.output };",
      strings: { __fabric_script: "ls" },
    });
    expect(resolveFabricExecProgram(
      prepareFabricExecArguments({ script: "ls", timeout: 600, settle: true }),
    )).toMatchObject({
      kind: "script",
      code:
        "const result = await pi.bash(π.__fabric_script, { timeout: 600, settle: true }); "
        + "return result.ok ? { ok: true, exitCode: 0, output: result.output } : "
        + "{ ok: false, exitCode: result.exitCode, output: result.output };",
      strings: { __fabric_script: "ls" },
    });
  });

  it("keeps display and resultFormat on the outer call", () => {
    expect(prepareFabricExecArguments({
      script: "ls",
      resultFormat: "json",
      display: "List",
    })).toEqual({
      script: "ls",
      resultFormat: "json",
      display: { name: "List" },
    });
  });

  it("is idempotent over already prepared authored arguments", () => {
    const input = { script: "ls", timeout: 30, settle: true };
    const once = prepareFabricExecArguments(input);
    expect(once).toBe(input);
    expect(prepareFabricExecArguments(once)).toBe(once);
  });

  it("rejects code and script together", () => {
    expect(() => prepareFabricExecArguments({ code: "return 1;", script: "ls" }))
      .toThrow(/`code` or `script`, not both/);
  });

  it("rejects an argument object with no program", () => {
    expect(() => prepareFabricExecArguments({})).toThrow(/either `code`.*or.*`script`/s);
    expect(() => prepareFabricExecArguments({ display: "Probe" }))
      .toThrow(/either `code`.*or.*`script`/s);
  });

  it("rejects a non-string script", () => {
    expect(() => prepareFabricExecArguments({ script: 12 })).toThrow(/`script` must be a string/);
    expect(() => prepareFabricExecArguments({ script: ["ls"] }))
      .toThrow(/`script` must be a string/);
  });

  it("rejects keys a shell payload cannot reach", () => {
    expect(() => prepareFabricExecArguments({ script: "ls", payloads: { a: "b" } }))
      .toThrow(/`payloads` cannot be used with `script`/);
    expect(() => prepareFabricExecArguments({ script: "ls", strings: { a: "b" } }))
      .toThrow(/`payloads` cannot be used with `script`/);
    expect(() => prepareFabricExecArguments({ script: "ls", tokenBudget: 10 }))
      .toThrow(/`tokenBudget` cannot be used with `script`/);
    expect(() => prepareFabricExecArguments({ script: "ls", agentBudget: 2 }))
      .toThrow(/`agentBudget` cannot be used with `script`/);
  });

  it("rejects script options without a script", () => {
    expect(() => prepareFabricExecArguments({ code: "return 1;", timeout: 60 }))
      .toThrow(/`timeout` is a script-mode option and requires `script`/);
    expect(() => prepareFabricExecArguments({ code: "return 1;", settle: true }))
      .toThrow(/`settle` is a script-mode option and requires `script`/);
  });

  it("rejects malformed script option values", () => {
    expect(() => prepareFabricExecArguments({ script: "ls", timeout: 0 }))
      .toThrow(/whole number of seconds between 1 and 86400/);
    expect(() => prepareFabricExecArguments({ script: "ls", timeout: 1.5 }))
      .toThrow(/whole number of seconds between 1 and 86400/);
    expect(() => prepareFabricExecArguments({ script: "ls", timeout: "600" }))
      .toThrow(/whole number of seconds between 1 and 86400/);
    expect(() => prepareFabricExecArguments({ script: "ls", settle: "true" }))
      .toThrow(/`settle` must be a boolean/);
  });

  it("canonicalizes legacy strings without inferring script authorship", () => {
    const input = {
      code: "return π.__fabric_script;",
      strings: { __fabric_script: "ls" },
    };
    const prepared = prepareFabricExecArguments(input);
    expect(prepared).toEqual({
      code: input.code,
      payloads: input.strings,
    });
    expect(resolveFabricExecProgram(prepared)).toMatchObject({
      kind: "code",
      strings: input.strings,
    });
  });

  it("treats null script options as absent", () => {
    expect(prepareFabricExecArguments({ code: "return 1;", timeout: null, settle: null }))
      .toEqual({ code: "return 1;" });
  });
});

describe("resolveFabricExecProgram", () => {
  it("maps canonical code payloads onto the internal guest bindings", () => {
    expect(resolveFabricExecProgram({
      code: "return π.body;",
      payloads: { body: "ok" },
    })).toEqual({
      kind: "code",
      code: "return π.body;",
      strings: { body: "ok" },
    });
  });

  it("keeps authorship explicit instead of inferring it from code and a magic key", () => {
    expect(resolveFabricExecProgram({ script: "ls -la" })).toMatchObject({
      kind: "script",
    });
    expect(resolveFabricExecProgram({
      code: "return π.__fabric_script;",
      strings: { __fabric_script: "ls" },
    })).toMatchObject({
      kind: "code",
    });
  });
});
