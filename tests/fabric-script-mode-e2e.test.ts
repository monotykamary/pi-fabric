import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ExtensionContext,
  ExtensionRunner,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { CapturedToolCatalog } from "../src/capture/catalog.js";
import { DEFAULT_FABRIC_CONFIG, type FabricConfig } from "../src/config.js";
import { ActionRegistry, type FabricCallAudit } from "../src/core/action-registry.js";
import type { FabricAutoApprovalClassifier } from "../src/core/auto-approval-classifier.js";
import type { FabricExecutionTraceV1 } from "../src/audit/trace.js";
import { FabricExecutionService } from "../src/execution-service.js";
import { PiToolsProvider } from "../src/providers/pi-tools-provider.js";
import {
  prepareFabricExecArguments,
  resolveFabricExecProgram,
} from "../src/fabric-exec-arguments.js";

const compile = (args: Record<string, unknown>) => {
  const program = resolveFabricExecProgram(prepareFabricExecArguments(args));
  if (program.kind !== "script") throw new Error("Expected a script program");
  return { code: program.code, strings: program.strings };
};

type RunOptions = {
  configure?: (config: FabricConfig) => void;
  classifier?: FabricAutoApprovalClassifier;
  runner?: ExtensionRunner;
  signal?: AbortSignal;
};

type RunResult = {
  success: boolean;
  value: unknown;
  audits: FabricCallAudit[];
  trace: FabricExecutionTraceV1;
  error?: string;
};

const runProgram = async (
  cwd: string,
  program: { code: string; strings?: Record<string, string> },
  options: RunOptions = {},
): Promise<RunResult> => {
  const registry = new ActionRegistry();
  let catalog: CapturedToolCatalog | undefined;
  if (options.runner) {
    catalog = new CapturedToolCatalog();
    catalog.replace([], options.runner, DEFAULT_FABRIC_CONFIG.capture, "/extensions/pi-fabric/index.ts");
  }
  registry.register(new PiToolsProvider(cwd, catalog, undefined));
  const config = structuredClone(DEFAULT_FABRIC_CONFIG);
  config.approvals.execute = "allow";
  options.configure?.(config);
  const service = new FabricExecutionService(
    registry,
    config,
    undefined,
    undefined,
    options.classifier,
  );
  const result = await service.execute({
    code: program.code,
    ...(program.strings ? { strings: program.strings } : {}),
    signal: options.signal,
    parentToolCallId: "script-probe",
    context: {
      cwd,
      hasUI: false,
      sessionManager: {
        getSessionId: () => "script-probe-session",
        getSessionFile: () => undefined,
      },
    } as unknown as ExtensionContext,
    onPartial() {},
  });
  return {
    success: result.success,
    value: result.value,
    audits: result.audits,
    trace: result.trace,
    ...(result.error ? { error: result.error } : {}),
  };
};

const runScript = async (
  cwd: string,
  args: Record<string, unknown>,
  options: RunOptions = {},
): Promise<RunResult> => runProgram(cwd, compile(args), options);

const withTempDir = async (run: (cwd: string) => Promise<void>): Promise<void> => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-script-"));
  try {
    await run(cwd);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
};

describe("script mode end to end", () => {
  // The whole point of the feature: this payload is what triple escaping
  // through JSON → a TypeScript string literal → shell gets wrong. It travels
  // as a plain string in `strings` and is never re-quoted by Fabric.
  it("runs shell metacharacters that would not survive a TypeScript literal", async () => {
    await withTempDir(async (cwd) => {
      const script = [
        "set -eu",
        "cat > sample.txt <<'EOF'",
        "alpha `backtick` ${NOT_EXPANDED} \"double\" 'single' \\backslash",
        "beta 2026-08-28",
        "EOF",
        "sed -E 's/([0-9]{4})-([0-9]{2})-([0-9]{2})/\\3\\/\\2\\/\\1/' sample.txt | tail -1",
        "printf '%s\\n' \"home=$(basename \"${HOME}\")\" >/dev/null",
      ].join("\n");

      const result = await runScript(cwd, { script });

      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
      expect(result.value).toBe("beta 28/08/2026\n");
      // The payload reaches pi.bash byte-for-byte as the command.
      expect(result.audits).toHaveLength(1);
      expect(result.audits[0]?.ref).toBe("pi.bash");
      expect(result.audits[0]?.args).toEqual({ command: script });
      // Written by the heredoc, so the literal text survived unexpanded.
      expect(fs.readFileSync(path.join(cwd, "sample.txt"), "utf8"))
        .toContain("`backtick` ${NOT_EXPANDED}");
    });
  });

  it("fails a nonzero exit without settle, the way any nested pi.bash does", async () => {
    await withTempDir(async (cwd) => {
      const result = await runScript(cwd, { script: "printf 'partial\\n'\nexit 7" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Command exited with code 7");
    });
  });

  it("returns the exit code alongside the output under settle", async () => {
    await withTempDir(async (cwd) => {
      const result = await runScript(cwd, {
        script: "printf 'partial\\n'\nexit 7",
        settle: true,
      });
      expect(result.success).toBe(true);
      // Not just the text: discarding exitCode here would defeat the option.
      expect(result.value).toMatchObject({ ok: false, exitCode: 7 });
      expect((result.value as { output: string }).output).toContain("partial");
    });
  });

  it("keeps the plain envelope for a successful settle run", async () => {
    await withTempDir(async (cwd) => {
      const result = await runScript(cwd, { script: "printf 'ok\\n'", settle: true });
      expect(result.value).toEqual({ ok: true, exitCode: 0, output: "ok\n" });
    });
  });

  it("passes timeout to the host in seconds", async () => {
    await withTempDir(async (cwd) => {
      // 2 seconds, not 2 milliseconds: a millisecond unit would abort this.
      const result = await runScript(cwd, {
        script: "sleep 0.3\nprintf 'slept\\n'",
        timeout: 2,
      });
      expect(result.success).toBe(true);
      expect(result.value).toBe("slept\n");
    });
  });
});

// A marker that appears only in the script *source* — carried in a comment so
// it never reaches stdout. That separation is the point: a failed pi.bash
// deliberately preserves its own output as the failure cause (trace.ts's
// preserveCause branch), for scripts exactly as for hand-written calls, so a
// canary that printed itself would test the wrong thing. What must not leak is
// the authored program text.
const CANARY = "SCRIPT_PAYLOAD_CANARY";
const canaryLine = `# ${CANARY}`;

// The payload legitimately appears once as the nested call's `command`, exactly
// as it would for a hand-written pi.bash. It must appear nowhere else in the
// durable record — not in an operation error, not in the run-level error, which
// is the field the trace contract keeps free of guest text.
const expectNoPayloadInErrorFields = (result: RunResult): void => {
  expect(result.trace.error ?? "").not.toContain(CANARY);
  for (const operation of result.trace.operations) {
    expect(operation.error ?? "").not.toContain(CANARY);
  }
  for (const audit of result.audits) {
    expect(audit.error ?? "").not.toContain(CANARY);
  }
  // Still recorded once, where a reviewer expects to find it.
  expect(JSON.stringify(result.trace.operations.map((operation) => operation.args)))
    .toContain(CANARY);
};

describe("script mode approval", () => {
  it("hands approval the exact script under the ordinary Bash risk", async () => {
    await withTempDir(async (cwd) => {
      const classified: { ref: string; risk: string; args: unknown }[] = [];
      const classifier = {
        async classify(action: { ref: string; risk: string }, args: unknown) {
          classified.push({ ref: action.ref, risk: action.risk, args });
          return {
            decision: "allow" as const,
            reason: "probe",
            model: "stub",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          };
        },
      } as unknown as FabricAutoApprovalClassifier;

      const script = `${canaryLine}\nprintf '%s\\n' 'approved'`;
      const result = await runScript(cwd, { script }, {
        classifier,
        configure: (config) => {
          config.approvals.execute = "auto";
        },
      });

      expect(result.success).toBe(true);
      expect(classified).toEqual([
        { ref: "pi.bash", risk: "execute", args: { command: script } },
      ]);
    });
  });

  it("fails at the approve stage under a deny policy, without leaking the payload", async () => {
    await withTempDir(async (cwd) => {
      const result = await runScript(cwd, { script: canaryLine }, {
        configure: (config) => {
          config.approvals.execute = "deny";
        },
      });

      expect(result.success).toBe(false);
      expect(result.trace.outcome).toBe("failed");
      expect(result.trace.operations[0]).toMatchObject({
        ref: "pi.bash",
        failureStage: "approve",
      });
      expect(result.trace.operations[0]?.error)
        .toContain("denied by the Fabric execute policy");
      expectNoPayloadInErrorFields(result);
    });
  });
});

describe("script mode failure outcomes", () => {
  it("records a host timeout in seconds without leaking the payload", async () => {
    await withTempDir(async (cwd) => {
      const result = await runScript(cwd, {
        script: `${canaryLine}\nsleep 5`,
        timeout: 1,
      });

      expect(result.success).toBe(false);
      expect(result.trace.operations[0]).toMatchObject({
        ref: "pi.bash",
        failureStage: "invoke",
      });
      // Seconds, not milliseconds: a millisecond reading would not have waited.
      expect(result.trace.operations[0]?.error).toContain("timed out after 1 seconds");
      expectNoPayloadInErrorFields(result);
    });
  });

  it("records cancellation as aborted without leaking the payload", async () => {
    // This probe writes no files. Reusing the system temp directory avoids
    // making Windows cleanup depend on when a cancelled shell descendant
    // releases its cwd handle.
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("cancelled by user")), 250);
    const result = await runScript(
      os.tmpdir(),
      { script: `${canaryLine}\nsleep 5` },
      { signal: controller.signal },
    );

    expect(result.success).toBe(false);
    expect(result.trace.outcome).toBe("aborted");
    expect(result.trace.operations[0]?.outcome).toBe("aborted");
    expectNoPayloadInErrorFields(result);
  });

  it("keeps the payload out of error fields on an ordinary nonzero exit", async () => {
    await withTempDir(async (cwd) => {
      const result = await runScript(cwd, { script: `${canaryLine}\nexit 3` });
      expect(result.success).toBe(false);
      expectNoPayloadInErrorFields(result);
    });
  });
});

describe("script mode nested-call parity", () => {
  type RunnerRecords = {
    events: string[];
    calls: Array<Record<string, unknown>>;
    results: Array<Record<string, unknown>>;
  };
  const makeRunner = (records: RunnerRecords): ExtensionRunner => ({
    createContext: () => ({ cwd: process.cwd() }),
    getActiveTools: () => [],
    emit: vi.fn(async (event: { type: string }) => {
      records.events.push(event.type);
    }),
    emitToolCall: vi.fn(async (event: Record<string, unknown>) => {
      records.calls.push(structuredClone(event));
      return undefined;
    }),
    emitToolResult: vi.fn(async (event: Record<string, unknown>) => {
      records.results.push(structuredClone(event));
      return {
        content: [{ type: "text", text: "patched-by-tool-result" }],
        details: { patched: true },
      };
    }),
  }) as unknown as ExtensionRunner;

  // The strongest available statement of "script mode is sugar": a compiled
  // script and the hand-written program it desugars to must be
  // indistinguishable everywhere downstream of preparation.
  it("matches a hand-written pi.bash program event for event and record for record", async () => {
    await withTempDir(async (cwd) => {
      const script = `printf '%s\\n' 'parity'`;
      const records = (): RunnerRecords => ({ events: [], calls: [], results: [] });
      const scriptRecords = records();
      const codeRecords = records();

      const scripted = await runScript(cwd, { script }, {
        runner: makeRunner(scriptRecords),
      });
      const handwritten = await runProgram(
        cwd,
        {
          code: "const result = await pi.bash(π.command); return result.output;",
          strings: { command: script },
        },
        { runner: makeRunner(codeRecords) },
      );

      expect(scriptRecords.events[0]).toBe("tool_execution_start");
      expect(scriptRecords.events.at(-1)).toBe("tool_execution_end");
      expect(scriptRecords.events).toEqual(codeRecords.events);
      const withoutCallId = ({ toolCallId: _toolCallId, ...event }: Record<string, unknown>) =>
        event;
      expect(scriptRecords.calls.map(withoutCallId)).toEqual(
        codeRecords.calls.map(withoutCallId),
      );
      expect(scriptRecords.calls).toHaveLength(1);
      expect(scriptRecords.calls[0]).toMatchObject({
        type: "tool_call",
        toolName: "bash",
        input: { command: script },
      });
      expect(scriptRecords.results.map(withoutCallId)).toEqual(
        codeRecords.results.map(withoutCallId),
      );
      expect(scriptRecords.results).toHaveLength(1);
      expect(scriptRecords.results[0]).toMatchObject({
        type: "tool_result",
        toolName: "bash",
        input: { command: script },
        isError: false,
      });
      expect(scripted.value).toBe("patched-by-tool-result");
      expect(scripted.value).toEqual(handwritten.value);
      expect(scripted.success).toBe(handwritten.success);

      const shape = (result: RunResult) => ({
        audits: result.audits.map((audit) => ({
          ref: audit.ref,
          tool: audit.tool,
          provider: audit.provider,
          args: audit.args,
          success: audit.success,
          preview: audit.preview,
        })),
        operations: result.trace.operations.map((operation) => ({
          ref: operation.ref,
          provider: operation.provider,
          action: operation.action,
          args: operation.args,
          outcome: operation.outcome,
          result: operation.result,
        })),
      });
      expect(shape(scripted)).toEqual(shape(handwritten));
    });
  });
});
