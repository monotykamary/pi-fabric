import {
  ExtensionRunner,
  type ToolCallEvent,
  type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  createFabricPersistedExecutionDetails,
  FabricExecutionTraceRecorder,
  type FabricExecutionOutcomeV1,
} from "../src/audit/index.js";
import { NESTED_TOOL_CALL_ID_PREFIX } from "../src/core/action-registry.js";
import {
  FabricToolLifecycle,
  ownsFabricToolSource,
  type FabricTopLevelToolAuthorizer,
} from "../src/core/tool-ownership.js";

const eventRunner = (
  handlers: Map<string, Array<(event: never, context: never) => unknown>>,
): ExtensionRunner => {
  const runner = Object.create(ExtensionRunner.prototype) as ExtensionRunner;
  Object.assign(runner as unknown as Record<string, unknown>, {
    extensions: [{ path: "/extensions/pi-fabric/index.ts", handlers }],
    createContext: () => ({}),
    errorListeners: new Set(),
  });
  return runner;
};

const failedDetails = (
  outcome: FabricExecutionOutcomeV1,
  failureStage?: "guard" | "invoke",
) => {
  const recorder = new FabricExecutionTraceRecorder();
  if (failureStage) {
    recorder.issueCall(failureStage === "guard" ? "pi.write" : "agents.run", {}).fail(
      failureStage,
      new Error(`${failureStage} failure`),
      outcome,
    );
  }
  return createFabricPersistedExecutionDetails({
    success: false,
    trace: recorder.seal(outcome, [], `${outcome} execution`),
  });
};

const executeThroughPiLifecycle = async (details: unknown) => {
  const toolErrors: Array<{ toolName: string; isError: boolean }> = [];
  const lifecycle = new FabricToolLifecycle(
    () => true,
    () => ({ authorize: async () => {} }),
  );
  const handlers = new Map<string, Array<(event: never, context: never) => unknown>>([
    ["tool_call", [(event) => lifecycle.toolCall(event as unknown as ToolCallEvent)]],
    ["tool_result", [(event) => lifecycle.toolResult(event as unknown as ToolResultEvent)]],
    ["tool_execution_end", [(event) => {
      const end = event as unknown as { toolName: string; isError: boolean };
      if (end.isError) toolErrors.push(end);
    }]],
  ]);
  const runner = eventRunner(handlers);
  const toolCallId = "call-outer";
  await runner.emitToolCall({
    type: "tool_call",
    toolCallId,
    toolName: "fabric_exec",
    input: { code: "return 1" },
  });

  const content = [{ type: "text" as const, text: "original output" }];
  // Pi 0.80.6 treats every returned custom-tool value as successful, even if
  // execute() included isError: true. The lifecycle event therefore starts at
  // false and middleware must repair it before tool_execution_end.
  const patch = await runner.emitToolResult({
    type: "tool_result",
    toolCallId,
    toolName: "fabric_exec",
    input: { code: "return 1" },
    content,
    details,
    isError: false,
  });
  const final = {
    content: patch?.content ?? content,
    details: patch?.details ?? details,
    isError: patch?.isError ?? false,
  };
  await runner.emit({
    type: "tool_execution_end",
    toolCallId,
    toolName: "fabric_exec",
    result: final,
    isError: final.isError,
  });
  return { final, toolErrors };
};

describe("Fabric outer tool lifecycle", () => {
  it.each([
    ["type error", failedDetails("failed")],
    ["runtime error", failedDetails("failed")],
    ["abort", failedDetails("aborted")],
    ["timeout", failedDetails("timed_out")],
    ["nested failure", failedDetails("failed", "invoke")],
    ["Schema guard failure", failedDetails("failed", "guard")],
    ["valid failed trace despite aggregate success", { ...failedDetails("failed"), success: true }],
    ["explicit aggregate failure", { success: false, trace: { invalid: true } }],
  ])("repairs %s through tool_result and triggers tool_error dispatch", async (_label, details) => {
    const { final, toolErrors } = await executeThroughPiLifecycle(details);
    expect(final.isError).toBe(true);
    expect(final.content).toEqual([{ type: "text", text: "original output" }]);
    expect(final.details).toBe(details);
    expect(toolErrors).toEqual([expect.objectContaining({
      toolName: "fabric_exec",
      isError: true,
    })]);
  });

  it("does not mark a valid succeeded trace as an error", async () => {
    const recorder = new FabricExecutionTraceRecorder();
    const details = createFabricPersistedExecutionDetails({
      success: true,
      trace: recorder.seal("succeeded", []),
    });
    const { final, toolErrors } = await executeThroughPiLifecycle(details);
    expect(final.isError).toBe(false);
    expect(toolErrors).toEqual([]);
  });

  it("leaves nested results and live partial update paths unaffected", async () => {
    const lifecycle = new FabricToolLifecycle(
      () => true,
      () => ({ authorize: async () => {} }),
    );
    await lifecycle.toolCall({
      type: "tool_call",
      toolCallId: "call-outer",
      toolName: "fabric_exec",
      input: {},
    });
    const nested = lifecycle.toolResult({
      type: "tool_result",
      toolCallId: `${NESTED_TOOL_CALL_ID_PREFIX}00000000-0000-4000-8000-000000000000`,
      toolName: "fabric_exec",
      input: {},
      content: [{ type: "text", text: "nested" }],
      details: { success: false },
      isError: false,
    });
    expect(nested).toBeUndefined();
    // Partial execute updates are tool_execution_update events, not
    // tool_result events, so this middleware has no partial-result surface.
  });
});

describe("Schema top-level tool gate", () => {
  const gate = (mode: "off" | "audit" | "enforce", ownsFabric = true) => {
    const decisions: string[] = [];
    const authorizer: FabricTopLevelToolAuthorizer = {
      async authorize(ref) {
        if (mode === "off") return;
        decisions.push(`${mode}:${ref}`);
        if (mode === "enforce") throw new Error(`blocked ${ref}`);
      },
    };
    return {
      lifecycle: new FabricToolLifecycle(() => ownsFabric, () => authorizer),
      decisions,
    };
  };

  it("uses canonical source provenance rather than SDK/extension metadata claims", () => {
    const entry = "/extensions/pi-fabric/index.ts";
    expect(ownsFabricToolSource([{
      name: "fabric_exec",
      sourceInfo: { path: entry },
    }], entry)).toBe(true);
    const sdkSpoof = [{
      name: "fabric_exec",
      sourceInfo: { path: "/sdk/custom-tools.ts" },
      risk: "read",
      source: "builtin",
      keepVisible: true,
    }];
    expect(ownsFabricToolSource(sdkSpoof, entry)).toBe(false);
    expect(ownsFabricToolSource([{
      name: "fabric_exec",
      sourceInfo: { path: "/extensions/external/index.ts" },
    }], entry)).toBe(false);
  });

  it("allows only this extension's exact top-level fabric_exec in enforce mode", async () => {
    const owned = gate("enforce", true);
    await expect(owned.lifecycle.toolCall({
      type: "tool_call",
      toolCallId: "call-owned",
      toolName: "fabric_exec",
      input: {},
    })).resolves.toBeUndefined();
    expect(owned.decisions).toEqual([]);

    const sdkCustomTool = gate("enforce");
    await expect(sdkCustomTool.lifecycle.toolCall({
      type: "tool_call",
      toolCallId: "call-sdk",
      toolName: "sdk_custom_tool",
      input: {},
    })).rejects.toThrow("blocked schema.top_level_tool.sdk_custom_tool");

    const externalFabricSpoof = gate("enforce", false);
    await expect(externalFabricSpoof.lifecycle.toolCall({
      type: "tool_call",
      toolCallId: "call-external",
      toolName: "fabric_exec",
      input: {},
    })).rejects.toThrow("blocked schema.top_level_tool.fabric_exec");
  });

  it.each([
    "external_extension_tool",
    "spoofed_read_risk",
    "spoofed_source_tool",
    "keep_visible_tool",
    "read",
  ])("blocks top-level %s regardless of descriptor metadata", async (toolName) => {
    const state = gate("enforce");
    await expect(state.lifecycle.toolCall({
      type: "tool_call",
      toolCallId: `call-${toolName}`,
      toolName,
      input: {},
    })).rejects.toThrow(`blocked schema.top_level_tool.${toolName}`);
  });

  it("allows generated nested ids only during an owned outer invocation", async () => {
    const fake = gate("enforce");
    await expect(fake.lifecycle.toolCall({
      type: "tool_call",
      toolCallId: `${NESTED_TOOL_CALL_ID_PREFIX}fake-top-level-id`,
      toolName: "read",
      input: {},
    })).rejects.toThrow("blocked schema.top_level_tool.read");

    const nested = gate("enforce");
    await nested.lifecycle.toolCall({
      type: "tool_call",
      toolCallId: "call-outer",
      toolName: "fabric_exec",
      input: {},
    });
    await expect(nested.lifecycle.toolCall({
      type: "tool_call",
      toolCallId: `${NESTED_TOOL_CALL_ID_PREFIX}nested`,
      toolName: "write",
      input: {},
    })).resolves.toBeUndefined();
    expect(nested.decisions).toEqual([]);
  });

  it("records would-block in audit mode and leaves off mode unchanged", async () => {
    const audit = gate("audit");
    await expect(audit.lifecycle.toolCall({
      type: "tool_call",
      toolCallId: "call-audit",
      toolName: "sdk_custom_tool",
      input: {},
    })).resolves.toBeUndefined();
    expect(audit.decisions).toEqual([
      "audit:schema.top_level_tool.sdk_custom_tool",
    ]);

    const off = gate("off");
    await expect(off.lifecycle.toolCall({
      type: "tool_call",
      toolCallId: "call-off",
      toolName: "external_extension_tool",
      input: {},
    })).resolves.toBeUndefined();
    expect(off.decisions).toEqual([]);
  });
});
