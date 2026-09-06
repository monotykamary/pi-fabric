import type { Theme } from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { FabricState } from "../src/fabric-state.js";
import { createFabricExecTool } from "../src/fabric-exec-tool.js";
import {
  prepareFabricExecArguments,
  resolveFabricExecProgram,
} from "../src/fabric-exec-arguments.js";
import { defaultCodePreviewSettings } from "../src/ui/code-preview.js";
import { fabricScriptTitleHint } from "../src/ui/fabric-code-parser.js";
import { GUEST_TYPE_DECLARATIONS } from "../src/runtime/guest-types.js";
import { typeCheckFabricCode } from "../src/runtime/type-checker.js";

const scriptArgs = (args: Record<string, unknown>): Record<string, unknown> =>
  prepareFabricExecArguments(args) as Record<string, unknown>;
const compile = (args: Record<string, unknown>): { code: string; strings: Record<string, string> } => {
  const program = resolveFabricExecProgram(scriptArgs(args));
  if (program.kind !== "script") throw new Error("Expected a script program");
  return { code: program.code, strings: program.strings };
};

describe("compiled script programs", () => {
  // Script mode forfeits the type check on the payload, not on the program it
  // is compiled into. Every template still has to pass the same gate an
  // ordinary `code` payload does and emit JavaScript, or script mode would
  // statically reject 100% of its own calls.
  it("passes the real type gate and emits JavaScript", () => {
    const programs = [
      compile({ script: "ls" }).code,
      compile({ script: "ls", timeout: 600 }).code,
      compile({ script: "ls", settle: true }).code,
      compile({ script: "ls", timeout: 600, settle: true }).code,
    ];
    for (const code of programs) {
      const checked = typeCheckFabricCode(code, GUEST_TYPE_DECLARATIONS);
      expect(checked.errors, code).toEqual([]);
      expect(checked.javascript, code).toBeTruthy();
    }
  });

  it("keeps the settle projection correct under ordinary tsc, not just the gate", () => {
    // The gate filters type-correctness diagnostics, so it would accept a flat
    // `result.exitCode ?? 0` even though the ok:true branch of the pi.bash
    // union has no exitCode. This asserts the template narrows anyway: the
    // repository typecheck is the checker that would catch the difference, and
    // this is the readable statement of the intent behind it.
    const settled = compile({ script: "ls", settle: true }).code;
    expect(settled).toContain("result.ok ?");
    expect(settled).not.toContain("result.exitCode ??");
  });
});

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const renderState = (toolDisplay: "full" | "compact") => ({
  bootstrapped: true,
  initialized: true,
  config: { ui: { showAgentToolPreview: true, toolDisplay } },
}) as unknown as FabricState;

const renderCall = (
  state: FabricState,
  args: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): string => {
  const tool = createFabricExecTool(state, defaultCodePreviewSettings(), new Map(), (t) => t);
  const context = {
    args,
    toolCallId: "fabric-call-1",
    invalidate: vi.fn(),
    lastComponent: undefined,
    state: {},
    cwd: process.cwd(),
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: true,
    isError: false,
    ...overrides,
  };
  return tool.renderCall!(args as never, plainTheme, context as never).render(120).join("\n");
};

describe("script-mode rendering", () => {
  const payload = "set -eu\npnpm test --filter core\nprintf 'done\\n'";

  it("renders the authored shell rather than the compiled program", () => {
    const rendered = renderCall(renderState("full"), scriptArgs({ script: payload }), {
      expanded: true,
    });
    expect(rendered).toContain("Shell · 3 lines");
    expect(rendered).not.toContain("TypeScript");
    expect(rendered).toContain("pnpm test --filter core");
    expect(rendered).not.toContain("pi.bash");
    expect(rendered).not.toContain("__fabric_script");
  });

  it("keeps TypeScript rendering for ordinary code calls", () => {
    const rendered = renderCall(renderState("full"), { code: "return 1;" }, { expanded: true });
    expect(rendered).toContain("TypeScript · 1 line");
    expect(rendered).not.toContain("Shell ·");
  });

  it("titles a compact card from the payload, skipping shell preamble", () => {
    const compact = renderCall(renderState("compact"), scriptArgs({ script: payload }));
    expect(compact).toContain("Shell pnpm");
    expect(compact).not.toContain("--filter core");
    expect(compact).not.toContain("set -eu");
  });

  it("keeps secret-bearing shell arguments out of compact and durable titles", () => {
    const secret = "supersecretvalue";
    const script = [
      `export API_TOKEN=${secret}`,
      `curl -H "Authorization: Bearer ${secret}" https://example.invalid`,
    ].join("\n");

    expect(fabricScriptTitleHint(script)).toBe("Shell curl");
    expect(fabricScriptTitleHint(`export API_TOKEN=${secret}`)).toBe("Shell export");
    expect(fabricScriptTitleHint(
      `API_TOKEN=${secret} curl https://example.invalid`,
    )).toBe("Shell curl");
    const compact = renderCall(renderState("compact"), scriptArgs({ script }));
    expect(compact).toContain("Shell curl");
    expect(compact).not.toContain(secret);
    expect(compact).not.toContain("Authorization");
  });

  it("renders the streaming script argument before execution starts", () => {
    const partial = renderCall(
      renderState("full"),
      { script: payload },
      { expanded: true, isPartial: true, argsComplete: false, executionStarted: false },
    );
    expect(partial).toContain("Shell · 3 lines");
    expect(partial).toContain("pnpm test --filter core");
  });

  it("does not throw when arguments carry no program yet", () => {
    expect(() => renderCall(renderState("full"), {})).not.toThrow();
    expect(() => renderCall(renderState("compact"), {})).not.toThrow();
  });

  it("does not treat a hand-written program that squats on the key as a script", () => {
    const rendered = renderCall(
      renderState("full"),
      { code: "return π.__fabric_script;", strings: { __fabric_script: payload } },
      { expanded: true },
    );
    expect(rendered).toContain("TypeScript · 1 line");
    expect(rendered).toContain("return π.__fabric_script;");
  });
});

const EXECUTED = new Error("reached the executor");

const executeState = (config: {
  fullCodeMode: boolean;
  schemaMode: "off" | "audit" | "enforce";
}) => {
  const execute = vi.fn((_options: { code: string; strings?: Record<string, string> }) => {
    throw EXECUTED;
  });
  const state = {
    bootstrapped: true,
    initialized: true,
    ensure: vi.fn(async () => {}),
    execution: { execute },
    config: {
      fullCodeMode: config.fullCodeMode,
      schema: { mode: config.schemaMode },
      ui: { showAgentToolPreview: true, toolDisplay: "full" },
      executor: { resultFormat: "yaml", maxOutputChars: 20_000 },
    },
  } as unknown as FabricState;
  return { state, execute };
};

const runExecute = async (
  state: FabricState,
  args: Record<string, unknown>,
): Promise<unknown> => {
  const tool = createFabricExecTool(state, defaultCodePreviewSettings(), new Map(), (t) => t);
  return tool.execute("fabric-call-1", args as never, undefined, undefined, {} as never);
};

describe("script-mode gates", () => {
  it("passes raw script through the real Pi prepare then schema-validation order", async () => {
    const { state, execute } = executeState({ fullCodeMode: true, schemaMode: "off" });
    const tool = createFabricExecTool(
      state,
      defaultCodePreviewSettings(),
      new Map(),
      (definition) => definition,
    );
    const raw = { script: "printf 'host-order\\n'" };
    const prepared = tool.prepareArguments!(raw);
    expect(prepared).toBe(raw);
    const validated = validateToolArguments(tool, {
      type: "toolCall",
      id: "fabric-host-order",
      name: "fabric_exec",
      arguments: prepared as Record<string, unknown>,
    });
    expect(validated).toEqual(raw);

    await expect(tool.execute(
      "fabric-host-order",
      validated as never,
      undefined,
      undefined,
      {} as never,
    )).rejects.toBe(EXECUTED);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]![0]).toMatchObject(compile(raw));
  });

  it("keeps payloads canonical through Pi validation and maps them at execute", async () => {
    const { state, execute } = executeState({ fullCodeMode: true, schemaMode: "off" });
    const tool = createFabricExecTool(
      state,
      defaultCodePreviewSettings(),
      new Map(),
      (definition) => definition,
    );
    const raw = { code: "return π.body;", payloads: { body: "ok" } };
    const prepared = tool.prepareArguments!(raw);
    expect(prepared).toBe(raw);
    const validated = validateToolArguments(tool, {
      type: "toolCall",
      id: "fabric-payload-order",
      name: "fabric_exec",
      arguments: prepared as Record<string, unknown>,
    });
    expect(validated).toEqual(raw);

    await expect(tool.execute(
      "fabric-payload-order",
      validated as never,
      undefined,
      undefined,
      {} as never,
    )).rejects.toBe(EXECUTED);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]![0]).toMatchObject({
      code: raw.code,
      strings: raw.payloads,
    });
  });

  it("executes in full code mode with schema off or audit", async () => {
    for (const schemaMode of ["off", "audit"] as const) {
      const { state, execute } = executeState({ fullCodeMode: true, schemaMode });
      await expect(runExecute(state, { script: "ls" })).rejects.toBe(EXECUTED);
      expect(execute).toHaveBeenCalledOnce();
      const options = execute.mock.calls[0]![0];
      expect(options.code).toBe(compile({ script: "ls" }).code);
      expect(options.strings).toEqual({ __fabric_script: "ls" });
    }
  });

  it("rejects orchestration-only mode before the executor", async () => {
    const { state, execute } = executeState({ fullCodeMode: false, schemaMode: "off" });
    await expect(runExecute(state, { script: "ls" })).rejects.toThrow(/requires full code mode/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects schema enforce mode before the executor", async () => {
    const { state, execute } = executeState({ fullCodeMode: true, schemaMode: "enforce" });
    await expect(runExecute(state, { script: "ls" }))
      .rejects.toThrow(/unavailable in Schema enforce mode/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("leaves ordinary code calls reachable in every gated mode", async () => {
    for (const config of [
      { fullCodeMode: false, schemaMode: "off" as const },
      { fullCodeMode: true, schemaMode: "enforce" as const },
    ]) {
      const { state, execute } = executeState(config);
      await expect(runExecute(state, { code: "return 1;" })).rejects.toBe(EXECUTED);
      expect(execute).toHaveBeenCalledOnce();
    }
  });

  it("re-enforces the argument contract for direct internal invocations", async () => {
    const { state, execute } = executeState({ fullCodeMode: true, schemaMode: "off" });
    await expect(runExecute(state, {})).rejects.toThrow(/either `code`.*`script`/s);
    await expect(runExecute(state, { code: "return 1;", script: "ls" }))
      .rejects.toThrow(/not both/);
    await expect(runExecute(state, { code: "return 1;", timeout: 5 }))
      .rejects.toThrow(/requires `script`/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("reads the gate from live state on every call", async () => {
    const { state, execute } = executeState({ fullCodeMode: true, schemaMode: "off" });
    await expect(runExecute(state, { script: "ls" })).rejects.toBe(EXECUTED);
    (state.config as { fullCodeMode: boolean }).fullCodeMode = false;
    await expect(runExecute(state, { script: "ls" })).rejects.toThrow(/requires full code mode/);
    expect(execute).toHaveBeenCalledOnce();
  });
});

const renderResult = (
  state: FabricState,
  args: Record<string, unknown>,
  details: Record<string, unknown>,
  output: string,
  overrides: Record<string, unknown> = {},
): string => {
  const tool = createFabricExecTool(state, defaultCodePreviewSettings(), new Map(), (t) => t);
  const context = {
    args,
    toolCallId: "fabric-call-1",
    invalidate: vi.fn(),
    lastComponent: undefined,
    state: {},
    cwd: process.cwd(),
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: true,
    isError: false,
    ...overrides,
  };
  return tool.renderResult!(
    { content: output ? [{ type: "text", text: output }] : [], details } as never,
    {
      expanded: Boolean(overrides.expanded),
      isPartial: Boolean(overrides.isPartial),
    },
    plainTheme,
    context as never,
  ).render(120).join("\n");
};

describe("script-mode result cards", () => {
  const payload = "set -eu\npnpm test --filter core";
  const args = scriptArgs({ script: payload });
  const auditFor = (success: boolean) => ({
    ref: "pi.bash",
    provider: "pi",
    tool: "bash",
    args: { command: payload },
    preview: { bashCommand: payload, result: success ? "3 passed\n" : "" },
    success,
    ...(success ? { result: "3 passed\n" } : { error: "Command exited with code 1" }),
  });
  const occurrences = (haystack: string, needle: string): number =>
    haystack.split(needle).length - 1;

  it("renders a success card once, without the compiled program", () => {
    for (const expanded of [false, true]) {
      const rendered = renderResult(
        renderState("full"),
        args,
        { success: true, audits: [auditFor(true)], phases: [] },
        "3 passed\n",
        { expanded },
      );
      expect(occurrences(rendered, "pnpm test --filter core")).toBe(1);
      expect(rendered).not.toContain("__fabric_script");
      expect(rendered).not.toContain("pi.bash(π.");
    }
  });

  // A failed nested call collapses to its command headline, the same as any
  // hand-written pi.bash failure, so the assertion is on that headline rather
  // than on the whole payload.
  it("renders a failure card once, without the compiled program", () => {
    const oneLine = "pnpm test --filter core";
    const rendered = renderResult(
      renderState("full"),
      scriptArgs({ script: oneLine }),
      {
        success: false,
        audits: [{
          ref: "pi.bash",
          provider: "pi",
          tool: "bash",
          args: { command: oneLine },
          preview: { bashCommand: oneLine, result: "" },
          success: false,
          error: "Command exited with code 1",
        }],
        phases: [],
      },
      "Runtime error: Command exited with code 1",
      { expanded: true, isError: true },
    );
    expect(occurrences(rendered, oneLine)).toBe(1);
    expect(rendered).toContain("Command exited with code 1");
    expect(rendered).not.toContain("__fabric_script");
    expect(rendered).not.toContain("pi.bash(π.");
  });

  // A resumed card is complete (isPartial false) but never had executionStarted
  // flipped, which is the combination that double-rendered previews before.
  it("renders a resumed card without duplicating the payload", () => {
    const rendered = renderResult(
      renderState("full"),
      args,
      { success: true, audits: [auditFor(true)], phases: [] },
      "3 passed\n",
      { expanded: true, executionStarted: false },
    );
    expect(occurrences(rendered, "pnpm test --filter core")).toBe(1);
  });

  it("renders a partial card without throwing while arguments stream", () => {
    expect(() => renderResult(
      renderState("full"),
      { script: payload },
      { audits: [], phases: [] },
      "",
      { isPartial: true, argsComplete: false, executionStarted: false },
    )).not.toThrow();
  });
});
