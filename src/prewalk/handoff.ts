import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { FabricPrewalkMode, FabricResultFormat } from "../config.js";
import {
  NESTED_TOOL_CALL_ID_PREFIX,
  type FabricCallAudit,
} from "../core/action-registry.js";
import type { CompactRequestIntent } from "../core/compact-controller.js";
import type { FabricExecutionResult } from "../execution-service.js";
import type {
  FabricInvocationActivityUpdate,
  FabricInvocationContext,
} from "../protocol.js";
import { snapshotHandoffSession } from "../agents/handoff.js";
import type {
  AgentSessionSeed,
  AgentToolResultMessage,
} from "../agents/types.js";
import {
  buildThinkingDigest,
  THINKING_DIGEST_CUSTOM_TYPE,
  thinkingTransferPolicy,
  type ThinkingTransferInput,
} from "../agents/thinking-transfer.js";
import type { PrewalkController } from "./controller.js";

const PREWALK_CONTINUE_PROMPT = [
  "Continue the existing task in this same session under the new executor model.",
  "Do not stop merely because the model changed or because the first mutation succeeded.",
  "Finish the remaining implementation, check matching call sites for consistency, and run the relevant verification before reporting completion.",
].join(" ");

// Forced continuation after a completed trajectory handoff: Main must not
// settle idle at the boundary. The executor's implementation is the source of
// truth — Main verifies it with real checks and reports, redoing nothing.
const PREWALK_TRAJECTORY_VERIFY_PROMPT = [
  "Prewalk trajectory handoff complete: the executor's implementation above is final — do not redo it.",
  "Continue now: run the relevant verification (matching test module, build, or an equivalent probe) and check the changed call sites for consistency, then summarize what the executor implemented and how the checks went.",
  "If a check fails, fix only the failing part; keep the fix scoped. If this verification already happened in this turn, respond with the summary only.",
].join(" ");

export const PREWALK_ARMED_MESSAGE_TYPE = "pi-fabric-prewalk-armed";
const PREWALK_CONTINUE_MESSAGE_TYPE = "pi-fabric-prewalk-continue";

const prewalkContinuationId = (message: unknown): string | undefined => {
  if (typeof message !== "object" || message === null) return undefined;
  const custom = message as { role?: unknown; customType?: unknown; details?: unknown };
  if (custom.role !== "custom" || custom.customType !== PREWALK_CONTINUE_MESSAGE_TYPE) {
    return undefined;
  }
  if (typeof custom.details !== "object" || custom.details === null) return undefined;
  const details = custom.details as { mode?: unknown; continuationId?: unknown };
  // Identity filtering applies to in-place continuations only: they carry the
  // accept/settle lifecycle. The trajectory verify prompt shares this custom
  // type but has no continuation identity and must always reach Main.
  if (details.mode !== "in-place") return undefined;
  return typeof details.continuationId === "string" ? details.continuationId : "";
};

export const filterPrewalkContinuationMessages = <Message>(
  messages: Message[],
  accept: (continuationId: string) => boolean,
): { messages: Message[]; changed: boolean } => {
  let changed = false;
  const filtered = messages.filter((message) => {
    const continuationId = prewalkContinuationId(message);
    if (continuationId === undefined) return true;
    const keep = continuationId.length > 0 && accept(continuationId);
    if (!keep) changed = true;
    return keep;
  });
  return { messages: changed ? filtered : messages, changed };
};

// Advisory arm-time framing, delivered as a hidden nextTurn custom message:
// LLM-visible, TUI-hidden, and never fired as an `input` event, so it cannot
// be captured as the next prewalk task and never triggers a turn by itself.
export const prewalkArmedPrompt = (mode: FabricPrewalkMode, model: string): string =>
  [
    `Prewalk armed → ${model} (${mode}): the first successful pi.edit / pi.write / schema.commit inside fabric_exec hands off to the executor automatically; ${
      mode === "trajectory"
        ? "the executor takes over the implementation there, and a hidden follow-up asks you to verify its work and summarize when it finishes."
        : `this session switches to ${model} and keeps working.`
    }`,
    "Reads never fire it; for multi-step work, restate the remaining steps before your first edit.",
  ].join("\n");

const customMessageText = (content: unknown): string | undefined => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .filter(
        (block): block is { type: "text"; text: string } =>
          typeof block === "object" &&
          block !== null &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string",
      )
      .map((block) => block.text);
    return parts.length > 0 ? parts.join("\n") : undefined;
  }
  return undefined;
};

// Pileup guard: only skip when an identical armed prompt already persists in
// the branch, so re-arming with a different mode/model still announces itself.
export const hasPrewalkArmedPrompt = (
  entries: ReadonlyArray<unknown>,
  content: string,
): boolean =>
  entries.some((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const candidate = entry as { type?: unknown; customType?: unknown; content?: unknown };
    return (
      candidate.type === "custom_message" &&
      candidate.customType === PREWALK_ARMED_MESSAGE_TYPE &&
      customMessageText(candidate.content) === content
    );
  });

export interface BoundaryHandoffRunner {
  executeHandoff(
    args: Record<string, unknown>,
    context: FabricInvocationContext,
    sessionSeed: AgentSessionSeed,
  ): Promise<Record<string, unknown>>;
}

export interface PendingFabricHandoff {
  kind: "explicit" | "prewalk-in-place" | "prewalk-trajectory";
  args: Record<string, unknown>;
  audit: FabricCallAudit;
  resultFormat: FabricResultFormat;
  triggerRef?: string;
}

// Appended to the replaced boundary tool result so the framing persists with
// what Main keeps seeing, anchoring every later turn. Advisory only: prewalk
// cannot gate the next claim on a plan, and bash edits stay invisible to it.
const TRAJECTORY_REARM_DIRECTIVE = [
  "Prewalk handoff completed — the executor's result above is final; don't redo it.",
  "Prewalk re-armed: on the next request, restate remaining steps (skip if trivial), then make changes via pi.edit / pi.write in fabric_exec to hand off again.",
  "A hidden follow-up turn verifies the executor's work and summarizes; keep any fixes scoped to what verification fails.",
].join("\n");

export const withTrajectoryRearmDirective = (
  text: string,
  pending: PendingFabricHandoff,
  handoff: Record<string, unknown>,
  controller: PrewalkController,
  sessionId: string,
): string =>
  pending.kind === "prewalk-trajectory" &&
  handoff.completed === true &&
  controller.isArmed(sessionId)
    ? `${text}\n\n${TRAJECTORY_REARM_DIRECTIVE}`
    : text;

export const claimFabricHandoff = (
  controller: PrewalkController,
  execution: FabricExecutionResult,
  sessionId: string,
  resultFormat: FabricResultFormat,
): PendingFabricHandoff | undefined => {
  if (execution.handoffRequest) {
    controller.completeTask();
    let audit: FabricCallAudit | undefined;
    for (let index = execution.audits.length - 1; index >= 0; index--) {
      const candidate = execution.audits[index];
      if (candidate?.ref === "agents.handoff") {
        audit = candidate;
        break;
      }
    }
    if (!audit) {
      throw new Error("Deferred agents.handoff request has no matching Fabric audit");
    }
    return {
      kind: "explicit",
      args: execution.handoffRequest,
      audit,
      resultFormat,
    };
  }

  const claim = controller.claim(execution.audits, sessionId);
  if (!claim) return undefined;
  const inPlace = claim.arm.mode === "in-place";
  const nestedToolCallId = `${NESTED_TOOL_CALL_ID_PREFIX}prewalk_${randomUUID()}`;
  const args = {
    model: claim.arm.model,
    name: inPlace ? "In-place Prewalk" : "Prewalk trajectory executor",
    ...(claim.arm.task ? { task: claim.arm.task } : {}),
    // Thinking applies to the child executor only; in-place keeps Main's level.
    ...(!inPlace && claim.arm.thinking ? { thinking: claim.arm.thinking } : {}),
  };
  const audit: FabricCallAudit = {
    ref: inPlace ? "fabric.prewalk" : "agents.handoff",
    nestedToolCallId,
    startedAt: Date.now(),
    tool: inPlace ? "prewalk" : "handoff",
    provider: inPlace ? "fabric" : "agents",
    args,
  };
  execution.audits.push(audit);
  return {
    kind: inPlace ? "prewalk-in-place" : "prewalk-trajectory",
    args,
    audit,
    resultFormat,
    triggerRef: claim.mutation.ref,
  };
};

const modelForKey = (key: string, context: ExtensionContext) => {
  const separator = key.indexOf("/");
  if (separator <= 0 || separator === key.length - 1) {
    throw new Error("Prewalk requires a provider/model executor target");
  }
  const model = context.modelRegistry.find(
    key.slice(0, separator),
    key.slice(separator + 1),
  );
  if (!model) throw new Error(`Prewalk model is unavailable: ${key}`);
  return model;
};

const runInPlacePrewalk = async (
  controller: PrewalkController,
  extension: ExtensionAPI,
  pending: PendingFabricHandoff,
  context: ExtensionContext,
): Promise<Record<string, unknown>> => {
  const modelKey = String(pending.args.model ?? "");
  context.ui.setStatus("fabric-prewalk", `switching Main → ${modelKey}`);
  const model = modelForKey(modelKey, context);
  // Snapshot the pre-switch reasoning channel and branch. In-place handoff
  // cannot rewrite Pi's ground-truth log, so foreign thinking stays
  // unreplayable for the new model; bridge continuity with the bounded digest.
  const sourceModel = context.model
    ? {
        provider: context.model.provider,
        modelId: context.model.id,
        api: context.modelRegistry.find(context.model.provider, context.model.id)?.api,
      }
    : undefined;
  const transfer: ThinkingTransferInput = {
    ...(sourceModel ? { source: sourceModel } : {}),
    target: {
      provider: model.provider,
      modelId: model.id,
      api: model.api,
      reasoning: model.reasoning,
      ...((model.compat as { requiresThinkingAsText?: boolean } | undefined)
        ?.requiresThinkingAsText !== undefined
        ? {
            requiresThinkingAsText: (model.compat as { requiresThinkingAsText?: boolean })
              .requiresThinkingAsText,
          }
        : {}),
    },
  };
  const branch = context.sessionManager.getBranch();
  const returnModel = context.model;
  if (!returnModel) throw new Error("Prewalk cannot determine Main return model");
  const returnModelKey = `${returnModel.provider}/${returnModel.id}`;
  const continuationId = randomUUID();
  const switched = await extension.setModel(model);
  if (!switched) {
    throw new Error(`No authentication configured for prewalk model: ${modelKey}`);
  }

  try {
    const transferPolicy = thinkingTransferPolicy(transfer);
    if (transferPolicy !== "preserved") {
      const digest = buildThinkingDigest(branch, transfer);
      if (digest) {
        extension.sendMessage(
          {
            customType: THINKING_DIGEST_CUSTOM_TYPE,
            content: digest.content,
            display: false,
            details: {
              mode: "in-place",
              policy: transferPolicy,
              citedBlocks: digest.citedBlocks,
              target: modelKey,
              trigger: pending.triggerRef,
            },
          },
          { deliverAs: "followUp" },
        );
      }
    }
    extension.sendMessage(
      {
        customType: PREWALK_CONTINUE_MESSAGE_TYPE,
        content: PREWALK_CONTINUE_PROMPT,
        display: false,
        details: {
          mode: "in-place",
          model: modelKey,
          continuationId,
          returnModel: returnModelKey,
          trigger: pending.triggerRef,
        },
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  } catch (error) {
    const restored = await extension.setModel(returnModel);
    if (!restored) {
      throw new Error(
        `Prewalk could not queue its continuation or return Main to ${returnModelKey}`,
        { cause: error },
      );
    }
    throw error;
  }

  controller.beginContinuation(continuationId, returnModelKey);
  context.ui.notify(
    `Prewalk is continuing in Main with ${modelKey}, then returning to ${returnModelKey}.`,
    "info",
  );
  context.ui.setStatus("fabric-prewalk", `continuing Main → ${modelKey}`);
  return {
    prewalk: true,
    mode: "in-place",
    continued: true,
    status: "continued",
    model: modelKey,
    trigger: { ref: pending.triggerRef },
  };
};

const modelForReturnKey = (key: string, context: ExtensionContext) => {
  const separator = key.indexOf("/");
  if (separator <= 0 || separator === key.length - 1) return undefined;
  return context.modelRegistry.find(key.slice(0, separator), key.slice(separator + 1));
};

const PREWALK_RETURN_COMPACTION_INSTRUCTIONS = [
  "Compact before Main returns to its boundary model after an in-place prewalk continuation.",
  "Preserve the executor's final report and verification results; summarize implementation scratch work, file reads, and command output.",
].join(" ");

export interface InPlacePrewalkSettleOptions {
  // Enabled by default when a compact controller is provided.
  compactOnReturn?: boolean;
  compact?: {
    request(intent: CompactRequestIntent): unknown;
    maybeCommit(context: ExtensionContext): Promise<void>;
    status?(): { pending?: unknown };
  };
}

export const settleInPlacePrewalk = async (
  controller: PrewalkController,
  extension: ExtensionAPI,
  context: ExtensionContext,
  options?: InPlacePrewalkSettleOptions,
): Promise<boolean> => {
  const sessionId = context.sessionManager.getSessionId();
  const settlement = controller.takeContinuationSettlement(sessionId);
  if (!settlement) return false;

  const model = modelForReturnKey(settlement.returnModel, context);
  if (!model) {
    controller.finishContinuation(sessionId, settlement.continuationId);
    context.ui.setStatus("fabric-prewalk", `return failed → ${settlement.returnModel}`);
    context.ui.notify(
      `Prewalk completed, but Main could not return to unavailable model ${settlement.returnModel}.`,
      "error",
    );
    return false;
  }

  context.ui.setStatus("fabric-prewalk", `returning Main → ${settlement.returnModel}`);
  if (options?.compact && options.compactOnReturn !== false) {
    // Compact while the executor is still active so the restored boundary
    // model re-ingests a compacted transcript instead of the executor's full
    // implementation scratch work: the return prefill is cold regardless of
    // provider cache-policy differences, so keep it small. An already-pending
    // intent (e.g. requested by the model) wins over ours. The commit is
    // best-effort; the controller records failures without throwing.
    if (!options.compact.status?.().pending) {
      options.compact.request({
        reason: "in-place prewalk return",
        instructions: PREWALK_RETURN_COMPACTION_INSTRUCTIONS,
        requestedBy: "prewalk",
      });
    }
    await options.compact.maybeCommit(context);
  }
  let restored = false;
  try {
    restored = await extension.setModel(model);
  } catch {
    restored = false;
  }
  if (!restored) {
    controller.finishContinuation(sessionId, settlement.continuationId);
    context.ui.setStatus("fabric-prewalk", `return failed → ${settlement.returnModel}`);
    context.ui.notify(
      `Prewalk completed, but Main could not return to ${settlement.returnModel}. Check model authentication.`,
      "error",
    );
    return false;
  }

  controller.finishContinuation(sessionId, settlement.continuationId);
  const status = controller.status();
  context.ui.setStatus(
    "fabric-prewalk",
    status.state === "armed" ? `armed → ${status.model}` : undefined,
  );
  context.ui.notify(
    status.state === "armed"
      ? `Prewalk complete. Main returned to ${settlement.returnModel} and re-armed for the next task.`
      : `Prewalk complete. Main returned to ${settlement.returnModel}.`,
    "info",
  );
  return true;
};


export const runFabricHandoffAtBoundary = async (
  controller: PrewalkController,
  runner: BoundaryHandoffRunner,
  extension: ExtensionAPI,
  pending: PendingFabricHandoff,
  outerToolResult: AgentToolResultMessage,
  context: ExtensionContext,
  activity?: (update: FabricInvocationActivityUpdate) => void,
): Promise<Record<string, unknown>> => {
  const model = String(pending.args.model ?? "");
  const inPlace = pending.kind === "prewalk-in-place";
  context.ui.setStatus(
    "fabric-prewalk",
    inPlace ? `switching Main → ${model}` : `handing off trajectory → ${model}`,
  );
  try {
    if (inPlace) {
      const result = await runInPlacePrewalk(controller, extension, pending, context);
      pending.audit.success = true;
      pending.audit.result = result;
      pending.audit.endedAt = Date.now();
      activity?.({ type: "progress", message: `Main continuing in place with ${model}` });
      return result;
    }

    const seed = snapshotHandoffSession(
      context.sessionManager,
      context.model,
      outerToolResult,
      outerToolResult.toolCallId,
    );
    const invocation: FabricInvocationContext = {
      cwd: context.cwd,
      signal: context.signal,
      parentToolCallId: outerToolResult.toolCallId,
      nestedToolCallId: pending.audit.nestedToolCallId,
      extensionContext: context,
      update(message) {
        context.ui.setStatus("fabric-prewalk", message);
        activity?.({ type: "progress", message });
      },
      ...(activity ? { activity } : {}),
      attachPreview(preview) {
        pending.audit.preview = preview;
      },
    };
    const result = await runner.executeHandoff(pending.args, invocation, seed);
    const completed = result.completed === true;
    pending.audit.success = completed;
    pending.audit.result = result;
    pending.audit.endedAt = Date.now();
    if (pending.kind === "prewalk-trajectory" && completed) {
      // Main is never left idle after a delegated implementation: queue a
      // hidden verify-and-summarize continuation the same way in-place does.
      // Best-effort — the executor's completed result stays authoritative.
      try {
        extension.sendMessage(
          {
            customType: "pi-fabric-prewalk-continue",
            content: PREWALK_TRAJECTORY_VERIFY_PROMPT,
            display: false,
            details: {
              mode: "trajectory",
              model,
              trigger: pending.triggerRef,
            },
          },
          { deliverAs: "followUp", triggerTurn: true },
        );
      } catch {
        // Swallow: a missed verification turn must not fail the handoff.
      }
    }
    context.ui.setStatus(
      "fabric-prewalk",
      completed ? "trajectory executor implemented" : `trajectory ${String(result.status ?? "failed")}`,
    );
    return {
      ...(pending.kind === "prewalk-trajectory"
        ? { prewalk: true, mode: "trajectory", trigger: { ref: pending.triggerRef } }
        : {}),
      ...result,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (inPlace) controller.failHandoff();
    pending.audit.success = false;
    pending.audit.error = message;
    pending.audit.endedAt = Date.now();
    context.ui.setStatus("fabric-prewalk", inPlace ? "in-place continuation failed" : "trajectory handoff failed");
    return {
      ...(pending.kind.startsWith("prewalk-")
        ? {
            prewalk: true,
            mode: inPlace ? "in-place" : "trajectory",
            trigger: { ref: pending.triggerRef },
          }
        : {}),
      handedOff: false,
      continued: false,
      completed: false,
      status: "failed",
      error: message,
    };
  } finally {
    if (!inPlace) {
      const status = controller.completeTask();
      if (status.state === "armed") {
        context.ui.setStatus("fabric-prewalk", `armed → ${status.model}`);
      }
    }
  }
};
