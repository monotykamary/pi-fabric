import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FabricResultFormat } from "../config.js";
import {
  NESTED_TOOL_CALL_ID_PREFIX,
  type FabricCallAudit,
} from "../core/action-registry.js";
import type { FabricExecutionResult } from "../execution-service.js";
import type { FabricInvocationContext } from "../protocol.js";
import { snapshotHandoffSession } from "../agents/handoff.js";
import type {
  AgentSessionSeed,
  AgentToolResultMessage,
} from "../agents/types.js";
import type { PrewalkController } from "./controller.js";

export interface BoundaryHandoffRunner {
  executeHandoff(
    args: Record<string, unknown>,
    context: FabricInvocationContext,
    sessionSeed: AgentSessionSeed,
  ): Promise<Record<string, unknown>>;
}

export interface PendingFabricHandoff {
  kind: "explicit" | "prewalk";
  args: Record<string, unknown>;
  audit: FabricCallAudit;
  resultFormat: FabricResultFormat;
  triggerRef?: string;
}

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
  const nestedToolCallId = `${NESTED_TOOL_CALL_ID_PREFIX}prewalk_${randomUUID()}`;
  const args = {
    model: claim.arm.model,
    name: "Prewalk executor",
    ...(claim.arm.task ? { task: claim.arm.task } : {}),
  };
  const audit: FabricCallAudit = {
    ref: "agents.handoff",
    nestedToolCallId,
    startedAt: Date.now(),
    tool: "handoff",
    provider: "agents",
    args,
  };
  execution.audits.push(audit);
  return {
    kind: "prewalk",
    args,
    audit,
    resultFormat,
    triggerRef: claim.mutation.ref,
  };
};

export const runFabricHandoffAtBoundary = async (
  controller: PrewalkController,
  runner: BoundaryHandoffRunner,
  pending: PendingFabricHandoff,
  outerToolResult: AgentToolResultMessage,
  context: ExtensionContext,
): Promise<Record<string, unknown>> => {
  const model = String(pending.args.model ?? "");
  context.ui.setStatus("fabric-prewalk", `handing off → ${model}`);
  try {
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
      },
      attachPreview(preview) {
        pending.audit.preview = preview;
      },
    };
    const result = await runner.executeHandoff(pending.args, invocation, seed);
    const completed = result.completed === true;
    pending.audit.success = completed;
    pending.audit.result = result;
    pending.audit.endedAt = Date.now();
    context.ui.setStatus(
      "fabric-prewalk",
      completed ? "handoff implemented" : `handoff ${String(result.status ?? "failed")}`,
    );
    return {
      ...(pending.kind === "prewalk"
        ? { prewalk: true, trigger: { ref: pending.triggerRef } }
        : {}),
      ...result,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pending.audit.success = false;
    pending.audit.error = message;
    pending.audit.endedAt = Date.now();
    context.ui.setStatus("fabric-prewalk", "handoff failed");
    return {
      ...(pending.kind === "prewalk"
        ? { prewalk: true, trigger: { ref: pending.triggerRef } }
        : {}),
      handedOff: false,
      completed: false,
      status: "failed",
      error: message,
    };
  } finally {
    const status = controller.completeTask();
    if (status.state === "armed") {
      context.ui.setStatus("fabric-prewalk", `armed → ${status.model}`);
    }
  }
};
