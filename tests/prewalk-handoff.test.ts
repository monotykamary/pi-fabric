import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { FabricExecutionResult } from "../src/execution-service.js";
import { PrewalkController } from "../src/prewalk/controller.js";
import {
  claimFabricHandoff,
  runFabricHandoffAtBoundary,
} from "../src/prewalk/handoff.js";
import type { SubagentToolResultMessage } from "../src/subagents/types.js";

const execution = (): FabricExecutionResult => ({
  success: true,
  value: "complete outer result",
  logs: [],
  audits: [
    {
      ref: "pi.read",
      nestedToolCallId: "read",
      startedAt: 1,
      endedAt: 2,
      success: true,
      args: { path: "src/a.ts" },
      result: "source",
    },
    {
      ref: "pi.edit",
      nestedToolCallId: "edit-one",
      startedAt: 3,
      endedAt: 4,
      success: true,
      args: { path: "src/a.ts" },
      result: { ok: true },
    },
    {
      ref: "pi.write",
      nestedToolCallId: "edit-two",
      startedAt: 5,
      endedAt: 6,
      success: true,
      args: { path: "src/b.ts" },
      result: { ok: true },
    },
  ],
  phases: [],
  trace: {
    kind: "pi-fabric.execution",
    version: 1,
    outcome: "succeeded",
    counts: {
      droppedValues: 0,
      truncatedValues: 0,
      redactedValues: 0,
      droppedOperations: 0,
    },
    operations: [],
    phases: [],
  },
  elapsedMs: 1,
});

const outerResult = (): SubagentToolResultMessage => ({
  role: "toolResult",
  toolCallId: "outer",
  toolName: "fabric_exec",
  content: [{ type: "text", text: "complete outer result" }],
  details: { success: true },
  isError: false,
  timestamp: 10,
});

const context = () => {
  const source = SessionManager.inMemory();
  source.appendMessage({ role: "user", content: "Implement everything", timestamp: 1 });
  source.appendMessage({
    role: "assistant",
    content: [{
      type: "toolCall",
      id: "outer",
      name: "fabric_exec",
      arguments: {
        code: "await pi.edit(...); await pi.write(...); return 'complete outer result';",
      },
    }],
    api: "anthropic",
    provider: "anthropic",
    model: "frontier",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 2,
  });
  const setStatus = vi.fn();
  return {
    value: {
      cwd: process.cwd(),
      signal: undefined,
      model: { provider: "anthropic", id: "frontier" },
      sessionManager: source,
      ui: { setStatus },
    } as unknown as ExtensionContext,
    setStatus,
  };
};

describe("outer-boundary Prewalk handoff", () => {
  it("claims after the complete execution and forks the native outer result", async () => {
    const controller = new PrewalkController();
    controller.arm({
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement the guard",
    });
    const run = execution();
    const pending = claimFabricHandoff(controller, run, "session-1", "json");

    expect(run.audits.map((audit) => audit.ref)).toEqual([
      "pi.read",
      "pi.edit",
      "pi.write",
      "agents.handoff",
    ]);
    expect(pending).toMatchObject({
      kind: "prewalk",
      args: { model: "anthropic/executor", task: "Implement the guard" },
      triggerRef: "pi.edit",
      resultFormat: "json",
    });
    expect(controller.status()).toMatchObject({ state: "handing_off" });

    const ctx = context();
    let transferredSeed: unknown;
    const runner = {
      executeHandoff: vi.fn(async (_args, invocation, seed) => {
        transferredSeed = seed;
        invocation.attachPreview?.({ kind: "fabric-agent-tools", name: "Prewalk executor" });
        return {
          handedOff: true,
          completed: true,
          status: "completed",
          implementation: "implemented",
          agent: { id: "child-1" },
        };
      }),
    };
    const result = await runFabricHandoffAtBoundary(
      controller,
      runner,
      pending!,
      outerResult(),
      ctx.value,
    );

    expect(runner.executeHandoff).toHaveBeenCalledWith(
      {
        model: "anthropic/executor",
        name: "Prewalk executor",
        task: "Implement the guard",
      },
      expect.objectContaining({ parentToolCallId: "outer" }),
      expect.any(Object),
    );
    expect(transferredSeed).toMatchObject({
      sourceBranchLeafId: expect.any(String),
      sourceBranch: [
        { type: "message", message: { role: "user" } },
        {
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "outer", name: "fabric_exec" }],
          },
        },
      ],
      outerToolResult: {
        role: "toolResult",
        toolCallId: "outer",
        toolName: "fabric_exec",
        content: [{ type: "text", text: "complete outer result" }],
      },
    });
    expect(result).toMatchObject({
      prewalk: true,
      handedOff: true,
      completed: true,
      trigger: { ref: "pi.edit" },
      implementation: "implemented",
    });
    expect(controller.status()).toEqual({ state: "idle" });
    expect(ctx.setStatus).toHaveBeenLastCalledWith("fabric-prewalk", "handoff implemented");
  });

  it("re-arms after a handoff when always re-arm is enabled", async () => {
    const controller = new PrewalkController();
    controller.arm({
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement the guard",
      alwaysRearm: true,
    });
    const pending = claimFabricHandoff(controller, execution(), "session-1", "auto");
    const ctx = context();

    await runFabricHandoffAtBoundary(
      controller,
      {
        executeHandoff: vi.fn(async () => ({
          handedOff: true,
          completed: true,
          status: "completed",
        })),
      },
      pending!,
      outerResult(),
      ctx.value,
    );

    expect(controller.status()).toMatchObject({
      state: "armed",
      model: "anthropic/executor",
      alwaysRearm: true,
    });
    expect(controller.status()).not.toHaveProperty("task");
    expect(ctx.setStatus).toHaveBeenLastCalledWith(
      "fabric-prewalk",
      "armed → anthropic/executor",
    );
  });

  it("gives an explicit deferred request precedence over automatic Prewalk", () => {
    const controller = new PrewalkController();
    controller.arm({ model: "anthropic/automatic", sessionId: "session-1" });
    const run = execution();
    run.audits.push({
      ref: "agents.handoff",
      nestedToolCallId: "explicit",
      startedAt: 7,
      endedAt: 8,
      success: true,
      args: { model: "anthropic/explicit" },
      result: { status: "deferred" },
    });
    run.handoffRequest = {
      model: "anthropic/explicit",
      task: "Use explicit executor",
    };

    expect(claimFabricHandoff(controller, run, "session-1", "auto")).toMatchObject({
      kind: "explicit",
      args: { model: "anthropic/explicit", task: "Use explicit executor" },
      audit: { nestedToolCallId: "explicit" },
    });
    expect(controller.status()).toEqual({ state: "idle" });
  });

  it("does not claim an automatic handoff when the complete execution had no mutation", () => {
    const controller = new PrewalkController();
    controller.arm({ model: "anthropic/executor", sessionId: "session-1" });
    const run = execution();
    run.audits = run.audits.slice(0, 1);

    expect(claimFabricHandoff(controller, run, "session-1", "auto")).toBeUndefined();
    expect(controller.isArmed("session-1")).toBe(true);
  });
});
