import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { AgentToolResultMessage } from "../src/agents/types.js";
import type { FabricExecutionResult } from "../src/execution-service.js";
import { PrewalkController } from "../src/prewalk/controller.js";
import {
  PREWALK_ARMED_MESSAGE_TYPE,
  claimFabricHandoff,
  filterPrewalkContinuationMessages,
  hasPrewalkArmedPrompt,
  prewalkArmedPrompt,
  runFabricHandoffAtBoundary,
  settleInPlacePrewalk,
  withTrajectoryRearmDirective,
} from "../src/prewalk/handoff.js";

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

const outerResult = (): AgentToolResultMessage => ({
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
  vi.spyOn(source, "getSessionId").mockReturnValue("session-1");
  source.appendMessage({ role: "user", content: "Implement everything", timestamp: 1 });
  source.appendMessage({
    role: "assistant",
    content: [{
      type: "toolCall",
      id: "outer",
      name: "fabric_exec",
      arguments: { code: "await pi.edit(...); return 'complete outer result';" },
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
  const target = { provider: "anthropic", id: "executor" };
  const sourceModel = { provider: "anthropic", id: "frontier" };
  const nextMainModel = { provider: "anthropic", id: "main-next" };
  const setStatus = vi.fn();
  return {
    value: {
      cwd: process.cwd(),
      signal: undefined,
      model: sourceModel,
      modelRegistry: {
        find: (provider: string, id: string) => {
          if (provider === target.provider && id === target.id) return target;
          if (provider === sourceModel.provider && id === sourceModel.id) return sourceModel;
          if (provider === nextMainModel.provider && id === nextMainModel.id) {
            return nextMainModel;
          }
          return undefined;
        },
      },
      sessionManager: source,
      ui: { setStatus, notify: vi.fn() },
    } as unknown as ExtensionContext,
    setStatus,
    target,
    sourceModel,
    nextMainModel,
  };
};

const extension = () => {
  const setModel = vi.fn().mockResolvedValue(true);
  const sendMessage = vi.fn();
  return {
    value: { setModel, sendMessage } as unknown as ExtensionAPI,
    setModel,
    sendMessage,
  };
};

const unusedRunner = () => ({ executeHandoff: vi.fn() });

describe("outer-boundary Prewalk", () => {
  it("switches Main in place and queues a hidden follow-up by default", async () => {
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
      "fabric.prewalk",
    ]);
    expect(pending).toMatchObject({
      kind: "prewalk-in-place",
      args: { model: "anthropic/executor", task: "Implement the guard" },
      triggerRef: "pi.edit",
    });

    const ctx = context();
    const ext = extension();
    const runner = unusedRunner();
    const activity = vi.fn();
    const result = await runFabricHandoffAtBoundary(
      controller,
      runner,
      ext.value,
      pending!,
      outerResult(),
      ctx.value,
      activity,
    );

    expect(runner.executeHandoff).not.toHaveBeenCalled();
    expect(ext.setModel).toHaveBeenCalledWith(ctx.target);
    expect(ctx.value.ui.notify).toHaveBeenCalledWith(
      "Prewalk is continuing in Main with anthropic/executor, then returning to anthropic/frontier.",
      "info",
    );
    expect(ext.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "pi-fabric-prewalk-continue",
        display: false,
        content: expect.stringContaining("Continue the existing task"),
        details: expect.objectContaining({
          continuationId: expect.any(String),
          returnModel: "anthropic/frontier",
        }),
      }),
      { deliverAs: "followUp", triggerTurn: true },
    );
    expect(result).toMatchObject({
      prewalk: true,
      mode: "in-place",
      continued: true,
      status: "continued",
      trigger: { ref: "pi.edit" },
    });
    expect(activity).toHaveBeenCalledWith(expect.objectContaining({ type: "progress" }));
    expect(controller.status()).toMatchObject({
      state: "continuation_pending",
      model: "anthropic/executor",
      returnModel: "anthropic/frontier",
      accepted: false,
    });
    expect(ctx.setStatus).toHaveBeenLastCalledWith(
      "fabric-prewalk",
      "continuing Main → anthropic/executor",
    );
  });


  it("returns Main to its boundary model and re-arms only after the matching continuation settles", async () => {
    const controller = new PrewalkController();
    controller.arm({
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement the guard",
      alwaysRearm: true,
    });
    const pending = claimFabricHandoff(controller, execution(), "session-1", "json");
    const ctx = context();
    const ext = extension();

    await runFabricHandoffAtBoundary(
      controller,
      unusedRunner(),
      ext.value,
      pending!,
      outerResult(),
      ctx.value,
    );
    const continuation = ext.sendMessage.mock.calls.find(
      ([message]) => message.customType === "pi-fabric-prewalk-continue",
    )?.[0] as { details: { continuationId: string } };

    expect(controller.acceptContinuation("session-1", "stale-id")).toBe(false);
    expect(await settleInPlacePrewalk(controller, ext.value, ctx.value)).toBe(false);
    expect(ext.setModel).toHaveBeenCalledTimes(1);

    expect(controller.acceptContinuation(
      "session-1",
      continuation.details.continuationId,
    )).toBe(true);
    ctx.value.model = ctx.target as typeof ctx.value.model;
    expect(await settleInPlacePrewalk(controller, ext.value, ctx.value)).toBe(true);

    expect(ext.setModel.mock.calls).toEqual([[ctx.target], [ctx.sourceModel]]);
    expect(controller.status()).toMatchObject({
      state: "armed",
      model: "anthropic/executor",
      alwaysRearm: true,
    });
    expect(controller.status()).not.toHaveProperty("task");
    expect(ctx.value.ui.notify).toHaveBeenLastCalledWith(
      "Prewalk complete. Main returned to anthropic/frontier and re-armed for the next task.",
      "info",
    );

    expect(await settleInPlacePrewalk(controller, ext.value, ctx.value)).toBe(false);
    expect(ext.setModel).toHaveBeenCalledTimes(2);
  });

  it("filters stale continuation messages and accepts only the pending identity", async () => {
    const controller = new PrewalkController();
    controller.arm({
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement the guard",
    });
    const pending = claimFabricHandoff(controller, execution(), "session-1", "json");
    const ctx = context();
    const ext = extension();
    await runFabricHandoffAtBoundary(
      controller,
      unusedRunner(),
      ext.value,
      pending!,
      outerResult(),
      ctx.value,
    );
    const continuation = ext.sendMessage.mock.calls.find(
      ([message]) => message.customType === "pi-fabric-prewalk-continue",
    )?.[0] as { details: { continuationId: string } };
    const stale = {
      role: "custom",
      customType: "pi-fabric-prewalk-continue",
      content: "stale",
      details: { mode: "in-place", continuationId: "stale-id" },
    };
    const current = { ...continuation, role: "custom" };
    const ordinary = { role: "user", content: "keep me" };

    const filtered = filterPrewalkContinuationMessages(
      [stale, current, ordinary],
      (continuationId) => controller.acceptContinuation("session-1", continuationId),
    );

    expect(filtered).toEqual({ messages: [current, ordinary], changed: true });
    expect(controller.status()).toMatchObject({ accepted: true });
  });

  it("keeps trajectory continuation prompts out of the in-place identity filter", () => {
    const trajectory = {
      role: "custom",
      customType: "pi-fabric-prewalk-continue",
      content: "Prewalk trajectory handoff complete: verify and summarize.",
      details: { mode: "trajectory", model: "anthropic/executor", trigger: "pi.edit" },
    };

    const result = filterPrewalkContinuationMessages([trajectory], () => {
      throw new Error("trajectory prompts must never reach the acceptance gate");
    });

    expect(result).toEqual({ messages: [trajectory], changed: false });
  });

  it("compacts before restoring Main when compactOnReturn is enabled", async () => {
    const controller = new PrewalkController();
    controller.arm({
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement the guard",
    });
    const pending = claimFabricHandoff(controller, execution(), "session-1", "json");
    const ctx = context();
    const ext = extension();

    await runFabricHandoffAtBoundary(
      controller,
      unusedRunner(),
      ext.value,
      pending!,
      outerResult(),
      ctx.value,
    );
    const continuation = ext.sendMessage.mock.calls.find(
      ([message]) => message.customType === "pi-fabric-prewalk-continue",
    )?.[0] as { details: { continuationId: string } };
    controller.acceptContinuation("session-1", continuation.details.continuationId);
    ctx.value.model = ctx.target as typeof ctx.value.model;

    const compact = {
      request: vi.fn(),
      maybeCommit: vi.fn(async () => {}),
    };
    expect(
      await settleInPlacePrewalk(controller, ext.value, ctx.value, {
        compactOnReturn: true,
        compact,
      }),
    ).toBe(true);

    expect(compact.request).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "in-place prewalk return",
        requestedBy: "prewalk",
      }),
    );
    expect(compact.maybeCommit).toHaveBeenCalledWith(ctx.value);
    const compactionOrder = compact.maybeCommit.mock.invocationCallOrder[0]!;
    const switchOrder = ext.setModel.mock.invocationCallOrder;
    expect(compactionOrder).toBeGreaterThan(switchOrder[0]!);
    expect(compactionOrder).toBeLessThan(switchOrder[1]!);
    expect(ext.setModel.mock.calls).toEqual([[ctx.target], [ctx.sourceModel]]);
    expect(controller.status()).toEqual({ state: "idle" });
  });

  it("restores Main without compacting when compactOnReturn is disabled", async () => {
    const controller = new PrewalkController();
    controller.arm({
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement the guard",
    });
    const pending = claimFabricHandoff(controller, execution(), "session-1", "json");
    const ctx = context();
    const ext = extension();

    await runFabricHandoffAtBoundary(
      controller,
      unusedRunner(),
      ext.value,
      pending!,
      outerResult(),
      ctx.value,
    );
    const continuation = ext.sendMessage.mock.calls.find(
      ([message]) => message.customType === "pi-fabric-prewalk-continue",
    )?.[0] as { details: { continuationId: string } };
    controller.acceptContinuation("session-1", continuation.details.continuationId);
    ctx.value.model = ctx.target as typeof ctx.value.model;

    const compact = {
      request: vi.fn(),
      maybeCommit: vi.fn(async () => {}),
    };
    expect(
      await settleInPlacePrewalk(controller, ext.value, ctx.value, {
        compactOnReturn: false,
        compact,
      }),
    ).toBe(true);

    expect(compact.request).not.toHaveBeenCalled();
    expect(compact.maybeCommit).not.toHaveBeenCalled();
    expect(ext.setModel.mock.calls).toEqual([[ctx.target], [ctx.sourceModel]]);
  });



  it("automatically returns Main and becomes idle after a one-shot in-place continuation", async () => {
    const controller = new PrewalkController();
    controller.arm({
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement the guard",
    });
    const pending = claimFabricHandoff(controller, execution(), "session-1", "json");
    const ctx = context();
    const ext = extension();

    await runFabricHandoffAtBoundary(
      controller,
      unusedRunner(),
      ext.value,
      pending!,
      outerResult(),
      ctx.value,
    );
    const continuation = ext.sendMessage.mock.calls.find(
      ([message]) => message.customType === "pi-fabric-prewalk-continue",
    )?.[0] as { details: { continuationId: string } };
    controller.acceptContinuation("session-1", continuation.details.continuationId);
    ctx.value.model = ctx.target as typeof ctx.value.model;

    expect(await settleInPlacePrewalk(controller, ext.value, ctx.value)).toBe(true);
    expect(ext.setModel.mock.calls).toEqual([[ctx.target], [ctx.sourceModel]]);
    expect(controller.status()).toEqual({ state: "idle" });
    expect(ctx.setStatus).toHaveBeenLastCalledWith("fabric-prewalk", undefined);
  });
  it("automatically repeats Main → executor → Main with a freshly captured Main model", async () => {
    const controller = new PrewalkController();
    controller.arm({
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "First task",
      alwaysRearm: true,
    });
    const ctx = context();
    const ext = extension();

    const runCycle = async () => {
      const pending = claimFabricHandoff(controller, execution(), "session-1", "json");
      await runFabricHandoffAtBoundary(
        controller,
        unusedRunner(),
        ext.value,
        pending!,
        outerResult(),
        ctx.value,
      );
      const continuation = ext.sendMessage.mock.calls
        .filter(([message]) => message.customType === "pi-fabric-prewalk-continue")
        .at(-1)?.[0] as { details: { continuationId: string; returnModel: string } };
      expect(controller.acceptContinuation(
        "session-1",
        continuation.details.continuationId,
      )).toBe(true);
      ctx.value.model = ctx.target as typeof ctx.value.model;
      expect(await settleInPlacePrewalk(controller, ext.value, ctx.value)).toBe(true);
      expect(controller.status()).toMatchObject({
        state: "armed",
        model: "anthropic/executor",
        alwaysRearm: true,
      });
      expect(controller.status()).not.toHaveProperty("task");
      return continuation.details.returnModel;
    };

    expect(await runCycle()).toBe("anthropic/frontier");

    ctx.value.model = ctx.nextMainModel as typeof ctx.value.model;
    controller.observeTask("session-1", "Second task");
    expect(await runCycle()).toBe("anthropic/main-next");

    expect(ext.setModel.mock.calls).toEqual([
      [ctx.target],
      [ctx.sourceModel],
      [ctx.target],
      [ctx.nextMainModel],
    ]);
    expect(ext.sendMessage.mock.calls.filter(
      ([message]) => message.customType === "pi-fabric-prewalk-continue",
    )).toHaveLength(2);
  });

  it("returns Main and keeps the task armed when queuing the continuation fails", async () => {
    const controller = new PrewalkController();
    controller.arm({
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement the guard",
      alwaysRearm: true,
    });
    const pending = claimFabricHandoff(controller, execution(), "session-1", "json");
    const ctx = context();
    const ext = extension();
    ext.sendMessage.mockImplementationOnce(() => {
      throw new Error("queue unavailable");
    });

    const result = await runFabricHandoffAtBoundary(
      controller,
      unusedRunner(),
      ext.value,
      pending!,
      outerResult(),
      ctx.value,
    );

    expect(result).toMatchObject({
      status: "failed",
      continued: false,
      error: "queue unavailable",
    });
    expect(ext.setModel.mock.calls).toEqual([[ctx.target], [ctx.sourceModel]]);
    expect(controller.status()).toMatchObject({
      state: "armed",
      task: "Implement the guard",
      alwaysRearm: true,
    });
  });
  it("reports restoration failure once and re-arms without retrying automatically", async () => {
    const controller = new PrewalkController();
    controller.arm({
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement the guard",
      alwaysRearm: true,
    });
    const pending = claimFabricHandoff(controller, execution(), "session-1", "json");
    const ctx = context();
    const ext = extension();
    await runFabricHandoffAtBoundary(
      controller,
      unusedRunner(),
      ext.value,
      pending!,
      outerResult(),
      ctx.value,
    );
    const continuation = ext.sendMessage.mock.calls.find(
      ([message]) => message.customType === "pi-fabric-prewalk-continue",
    )?.[0] as { details: { continuationId: string } };
    controller.acceptContinuation("session-1", continuation.details.continuationId);
    ctx.value.model = ctx.target as typeof ctx.value.model;
    ext.setModel.mockResolvedValueOnce(false);

    expect(await settleInPlacePrewalk(controller, ext.value, ctx.value)).toBe(false);
    expect(controller.status()).toMatchObject({
      state: "armed",
      model: "anthropic/executor",
      alwaysRearm: true,
    });
    expect(ctx.setStatus).toHaveBeenLastCalledWith(
      "fabric-prewalk",
      "return failed → anthropic/frontier",
    );
    expect(await settleInPlacePrewalk(controller, ext.value, ctx.value)).toBe(false);
    expect(ext.setModel).toHaveBeenCalledTimes(2);
  });
  it("keeps the armed task when the executor model cannot be selected", async () => {
    const controller = new PrewalkController();
    controller.arm({
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement the guard",
      alwaysRearm: true,
    });
    const pending = claimFabricHandoff(controller, execution(), "session-1", "json");
    const ctx = context();
    const ext = extension();
    ext.setModel.mockResolvedValueOnce(false);

    const result = await runFabricHandoffAtBoundary(
      controller,
      unusedRunner(),
      ext.value,
      pending!,
      outerResult(),
      ctx.value,
    );

    expect(result).toMatchObject({ status: "failed", continued: false });
    expect(ext.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ customType: "pi-fabric-prewalk-continue" }),
      expect.anything(),
    );
    expect(controller.status()).toMatchObject({
      state: "armed",
      task: "Implement the guard",
      alwaysRearm: true,
    });
  });

  it("sends a bounded thinking digest ahead of the in-place continuation for foreign channels", async () => {
    const controller = new PrewalkController();
    controller.arm({
      model: "neuralwatt/kimi-k3",
      sessionId: "session-1",
      task: "Implement the guard",
    });
    const run = execution();
    const pending = claimFabricHandoff(controller, run, "session-1", "json");
    expect(pending).toMatchObject({ kind: "prewalk-in-place" });

    const kimiModel = {
      provider: "neuralwatt",
      id: "kimi-k3",
      api: "openai-completions",
      reasoning: true,
      compat: { requiresReasoningContentOnAssistantMessages: true },
    };
    const codexModel = {
      provider: "openai-codex",
      id: "gpt-5.6-sol",
      api: "openai-responses",
      reasoning: true,
    };
    const source = SessionManager.inMemory();
    source.appendMessage({ role: "user", content: "Implement everything", timestamp: 1 });
    const thinkingEntryId = source.appendMessage({
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "**Plan the guard**\n\nsteps",
          thinkingSignature: '{"id":"rs_x","type":"reasoning","encrypted_content":"gAAA"}',
        },
        {
          type: "toolCall",
          id: "outer",
          name: "fabric_exec",
          arguments: { code: "await pi.edit(...); return 'complete outer result';" },
        },
      ],
      api: "openai-responses",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
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
    const ctx = {
      cwd: process.cwd(),
      signal: undefined,
      model: { provider: "openai-codex", id: "gpt-5.6-sol" },
      modelRegistry: {
        find: (provider: string, id: string) =>
          provider === "neuralwatt" && id === "kimi-k3"
            ? kimiModel
            : provider === "openai-codex" && id === "gpt-5.6-sol"
              ? codexModel
              : undefined,
      },
      sessionManager: source,
      ui: { setStatus: vi.fn(), notify: vi.fn() },
    } as unknown as ExtensionContext;
    const ext = extension();

    const result = await runFabricHandoffAtBoundary(
      controller,
      unusedRunner(),
      ext.value,
      pending!,
      outerResult(),
      ctx,
      vi.fn(),
    );

    expect(ext.setModel).toHaveBeenCalledWith(kimiModel);
    expect(ext.sendMessage).toHaveBeenCalledTimes(2);
    const digestCall = ext.sendMessage.mock.calls[0];
    expect(digestCall?.[0]).toMatchObject({
      customType: "pi-fabric-handoff-thinking",
      display: false,
      details: expect.objectContaining({
        mode: "in-place",
        policy: "re-signed",
        citedBlocks: 1,
        target: "neuralwatt/kimi-k3",
      }),
    });
    expect(String(digestCall?.[0].content)).toContain(`[entry ${thinkingEntryId}]`);
    expect(String(digestCall?.[0].content)).toContain("Plan the guard");
    expect(digestCall?.[1]).toEqual({ deliverAs: "followUp" });
    expect(ext.sendMessage.mock.calls[1]?.[0]).toMatchObject({
      customType: "pi-fabric-prewalk-continue",
    });
    expect(result).toMatchObject({ mode: "in-place", status: "continued" });
    // The digest is context-only: Pi's ground-truth log above is untouched.
    expect(
      JSON.stringify(source.getBranch()).includes("reasoning_content"),
    ).toBe(false);
  });

  it("keeps trajectory handoff opt-in and exposes child activity", async () => {
    const controller = new PrewalkController();
    controller.arm({
      mode: "trajectory",
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement the guard",
    });
    const pending = claimFabricHandoff(controller, execution(), "session-1", "auto");
    expect(pending).toMatchObject({
      kind: "prewalk-trajectory",
      audit: { ref: "agents.handoff" },
    });

    const ctx = context();
    const ext = extension();
    let transferredSeed: unknown;
    const runner = {
      executeHandoff: vi.fn(async (_args, invocation, seed) => {
        transferredSeed = seed;
        invocation.activity?.({
          type: "entity",
          id: "child-1",
          kind: "agent",
          name: "Prewalk trajectory executor",
        });
        invocation.update("Agent Prewalk trajectory executor: running · edit");
        invocation.attachPreview?.({ kind: "fabric-agent-tools" });
        return {
          handedOff: true,
          completed: true,
          status: "completed",
          implementation: "implemented",
          agent: { id: "child-1" },
        };
      }),
    };
    const activity = vi.fn();
    const result = await runFabricHandoffAtBoundary(
      controller,
      runner,
      ext.value,
      pending!,
      outerResult(),
      ctx.value,
      activity,
    );

    expect(ext.setModel).not.toHaveBeenCalled();
    expect(runner.executeHandoff).toHaveBeenCalledWith(
      {
        model: "anthropic/executor",
        name: "Prewalk trajectory executor",
        task: "Implement the guard",
      },
      expect.objectContaining({ parentToolCallId: "outer", activity: expect.any(Function) }),
      expect.any(Object),
    );
    expect(transferredSeed).toMatchObject({
      sourceBranch: [
        { type: "message", message: { role: "user" } },
        { type: "message", message: { role: "assistant" } },
      ],
      outerToolResult: { toolCallId: "outer", toolName: "fabric_exec" },
    });
    expect(activity).toHaveBeenCalledWith(expect.objectContaining({ type: "entity", id: "child-1" }));
    expect(activity).toHaveBeenCalledWith(expect.objectContaining({ type: "progress" }));
    expect(result).toMatchObject({
      prewalk: true,
      mode: "trajectory",
      handedOff: true,
      completed: true,
      implementation: "implemented",
    });
    expect(ext.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "pi-fabric-prewalk-continue",
        display: false,
        content: expect.stringContaining("do not redo it"),
        details: expect.objectContaining({ mode: "trajectory" }),
      }),
      { deliverAs: "followUp", triggerTurn: true },
    );
    expect(ctx.setStatus).toHaveBeenLastCalledWith(
      "fabric-prewalk",
      "trajectory executor implemented",
    );
  });

  it("does not queue the verify continuation after a failed trajectory handoff", async () => {
    const controller = new PrewalkController();
    controller.arm({
      mode: "trajectory",
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement the guard",
    });
    const pending = claimFabricHandoff(controller, execution(), "session-1", "auto");
    const ctx = context();
    const ext = extension();
    const runner = {
      executeHandoff: vi.fn(async () => ({
        handedOff: true,
        completed: false,
        status: "failed",
        error: "child crashed",
      })),
    };
    const result = await runFabricHandoffAtBoundary(
      controller,
      runner,
      ext.value,
      pending!,
      outerResult(),
      ctx.value,
    );

    expect(result).toMatchObject({ prewalk: true, mode: "trajectory", completed: false });
    expect(ext.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ customType: "pi-fabric-prewalk-continue" }),
      expect.anything(),
    );
  });

  it("threads the configured thinking level into the trajectory executor args", async () => {
    const controller = new PrewalkController();
    controller.arm({
      mode: "trajectory",
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement the guard",
      thinking: "high",
    });
    const pending = claimFabricHandoff(controller, execution(), "session-1", "auto");
    expect(pending!.args).toMatchObject({ model: "anthropic/executor", thinking: "high" });

    const ctx = context();
    const ext = extension();
    let receivedArgs: Record<string, unknown> | undefined;
    const runner = {
      executeHandoff: vi.fn(async (args) => {
        receivedArgs = args;
        return { handedOff: true, completed: true, status: "completed", implementation: "done" };
      }),
    };
    await runFabricHandoffAtBoundary(
      controller,
      runner,
      ext.value,
      pending!,
      outerResult(),
      ctx.value,
    );
    expect(receivedArgs).toMatchObject({ thinking: "high" });
  });

  it("keeps thinking out of in-place continuation args", () => {
    const controller = new PrewalkController();
    controller.arm({
      model: "anthropic/executor",
      sessionId: "session-1",
      thinking: "high",
    });
    const pending = claimFabricHandoff(controller, execution(), "session-1", "auto");
    expect(pending!.kind).toBe("prewalk-in-place");
    expect(pending!.args).not.toHaveProperty("thinking");
  });

  it("preserves the thinking level across a re-armed trajectory handoff", async () => {
    const controller = new PrewalkController();
    controller.arm({
      mode: "trajectory",
      model: "anthropic/executor",
      sessionId: "session-1",
      thinking: "xhigh",
      alwaysRearm: true,
    });
    const pending = claimFabricHandoff(controller, execution(), "session-1", "auto");
    await runFabricHandoffAtBoundary(
      controller,
      { executeHandoff: vi.fn(async () => ({ handedOff: true, completed: true, status: "completed" })) },
      extension().value,
      pending!,
      outerResult(),
      context().value,
    );
    expect(controller.status()).toMatchObject({
      state: "armed",
      thinking: "xhigh",
      alwaysRearm: true,
    });
  });

  it("keeps continuous in-place prewalk pending until its continuation settles", async () => {
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
      unusedRunner(),
      extension().value,
      pending!,
      outerResult(),
      ctx.value,
    );

    expect(controller.status()).toMatchObject({
      state: "continuation_pending",
      mode: "in-place",
      model: "anthropic/executor",
      alwaysRearm: true,
      task: "Implement the guard",
    });
    expect(ctx.setStatus).toHaveBeenLastCalledWith(
      "fabric-prewalk",
      "continuing Main → anthropic/executor",
    );
  });

  it("gives an explicit deferred trajectory request precedence", () => {
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
    run.handoffRequest = { model: "anthropic/explicit", task: "Use explicit executor" };

    expect(claimFabricHandoff(controller, run, "session-1", "auto")).toMatchObject({
      kind: "explicit",
      args: { model: "anthropic/explicit", task: "Use explicit executor" },
    });
    expect(controller.status()).toEqual({ state: "idle" });
  });

  it("does not claim when the complete execution had no mutation", () => {
    const controller = new PrewalkController();
    controller.arm({ model: "anthropic/executor", sessionId: "session-1" });
    const run = execution();
    run.audits = run.audits.slice(0, 1);

    expect(claimFabricHandoff(controller, run, "session-1", "auto")).toBeUndefined();
    expect(controller.isArmed("session-1")).toBe(true);
  });

  it("re-arms after a trajectory handoff when configured", async () => {
    const controller = new PrewalkController();
    controller.arm({
      mode: "trajectory",
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement the guard",
      alwaysRearm: true,
    });
    const pending = claimFabricHandoff(controller, execution(), "session-1", "auto");
    expect(pending).toMatchObject({ kind: "prewalk-trajectory" });

    const ctx = context();
    const runner = {
      executeHandoff: vi.fn(async () => ({
        handedOff: true,
        completed: true,
        status: "completed",
        implementation: "implemented",
      })),
    };
    const result = await runFabricHandoffAtBoundary(
      controller,
      runner,
      extension().value,
      pending!,
      outerResult(),
      ctx.value,
    );

    expect(result).toMatchObject({
      prewalk: true,
      mode: "trajectory",
      completed: true,
      implementation: "implemented",
    });
    expect(controller.status()).toMatchObject({
      state: "armed",
      mode: "trajectory",
      model: "anthropic/executor",
      alwaysRearm: true,
    });
    expect(controller.status()).not.toHaveProperty("task");
    expect(ctx.setStatus).toHaveBeenLastCalledWith(
      "fabric-prewalk",
      "armed → anthropic/executor",
    );
    expect(
      withTrajectoryRearmDirective("outer output", pending!, result, controller, "session-1"),
    ).toContain("Prewalk re-armed");
  });
});

describe("prewalkArmedPrompt", () => {
  it("describes the trajectory boundary for Main", () => {
    const text = prewalkArmedPrompt("trajectory", "anthropic/executor");
    expect(text).toContain("anthropic/executor (trajectory)");
    expect(text).toContain("pi.edit / pi.write / schema.commit");
    expect(text).toContain("the executor takes over the implementation there, and a hidden follow-up asks you to verify its work and summarize when it finishes.");
    expect(text).toContain("restate the remaining steps before your first edit");
  });

  it("describes in-place continuation for Main", () => {
    const text = prewalkArmedPrompt("in-place", "anthropic/executor");
    expect(text).toContain("this session switches to anthropic/executor and keeps working.");
    expect(text).not.toContain("hidden follow-up asks you to verify");
  });
});

describe("hasPrewalkArmedPrompt", () => {
  it("matches persisted armed prompts by content only", () => {
    const armed = prewalkArmedPrompt("trajectory", "anthropic/executor");
    const entries = [
      { type: "message", message: { role: "user" } },
      {
        type: "custom_message",
        customType: PREWALK_ARMED_MESSAGE_TYPE,
        content: [{ type: "text", text: armed }],
      },
      { type: "custom_message", customType: "other-extension", content: armed },
    ];
    expect(hasPrewalkArmedPrompt(entries, armed)).toBe(true);
    expect(hasPrewalkArmedPrompt(entries, prewalkArmedPrompt("in-place", "other/model"))).toBe(false);
    expect(hasPrewalkArmedPrompt([], armed)).toBe(false);
  });

  it("accepts string content and ignores malformed entries", () => {
    const entries = [
      { type: "custom_message", customType: PREWALK_ARMED_MESSAGE_TYPE, content: "plain" },
      null,
      42,
    ];
    expect(hasPrewalkArmedPrompt(entries, "plain")).toBe(true);
    expect(hasPrewalkArmedPrompt(entries, "other")).toBe(false);
  });
});

describe("withTrajectoryRearmDirective", () => {
  const trajectoryPending = (alwaysRearm: boolean) => {
    const controller = new PrewalkController();
    controller.arm({
      mode: "trajectory",
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement",
      alwaysRearm,
    });
    const pending = claimFabricHandoff(controller, execution(), "session-1", "auto")!;
    return { controller, pending };
  };

  it("appends the directive after a completed trajectory handoff when re-armed", () => {
    const { controller, pending } = trajectoryPending(true);
    controller.completeTask(); // boundary finally re-arms
    const text = withTrajectoryRearmDirective("OUTPUT", pending, { completed: true }, controller, "session-1");
    expect(text.startsWith("OUTPUT\n\n")).toBe(true);
    expect(text).toContain("result above is final");
    expect(text).toContain("pi.edit / pi.write in fabric_exec to hand off again");
    expect(text).toContain("keep any fixes scoped to what verification fails.");
  });

  it("omits the directive for in-place pendings", () => {
    const controller = new PrewalkController();
    controller.arm({ model: "anthropic/executor", sessionId: "session-1" });
    const pending = claimFabricHandoff(controller, execution(), "session-1", "auto")!;
    expect(pending.kind).toBe("prewalk-in-place");
    controller.completeTask();
    expect(withTrajectoryRearmDirective("OUTPUT", pending, { completed: true }, controller, "session-1")).toBe("OUTPUT");
  });

  it("omits the directive when the handoff failed", () => {
    const { controller, pending } = trajectoryPending(true);
    controller.completeTask();
    expect(withTrajectoryRearmDirective("OUTPUT", pending, { completed: false }, controller, "session-1")).toBe("OUTPUT");
  });

  it("omits the directive when the arm was one-shot", () => {
    const { controller, pending } = trajectoryPending(false);
    controller.completeTask(); // no alwaysRearm -> idle
    expect(controller.status()).toEqual({ state: "idle" });
    expect(withTrajectoryRearmDirective("OUTPUT", pending, { completed: true }, controller, "session-1")).toBe("OUTPUT");
  });

  it("omits the directive when the arm belongs to another session", () => {
    const { controller, pending } = trajectoryPending(true);
    controller.completeTask();
    expect(withTrajectoryRearmDirective("OUTPUT", pending, { completed: true }, controller, "session-2")).toBe("OUTPUT");
  });
});
