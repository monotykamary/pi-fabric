import type { FabricPrewalkMode } from "../config.js";
import type { FabricCallAudit } from "../core/action-registry.js";
import { isFabricThinking, type FabricThinking } from "../thinking.js";

const PREWALK_TRIGGER_REFS = new Set([
  "pi.edit",
  "pi.write",
  "schema.commit",
]);

interface FabricPrewalkArm {
  mode: FabricPrewalkMode;
  model: string;
  sessionId: string;
  armedAt: number;
  alwaysRearm: boolean;
  task?: string;
  thinking?: FabricThinking;
}

interface FabricPrewalkContinuation extends FabricPrewalkArm {
  continuationId: string;
  returnModel: string;
  accepted: boolean;
}

export type FabricPrewalkStatus =
  | { state: "idle" }
  | ({ state: "armed" | "handing_off" } & FabricPrewalkArm)
  | ({ state: "continuation_pending" } & FabricPrewalkContinuation);

export interface FabricPrewalkClaim {
  arm: FabricPrewalkArm;
  mutation: FabricCallAudit;
}

export interface FabricPrewalkSettlement {
  continuationId: string;
  returnModel: string;
  executorModel: string;
}

const normalizedTask = (value: string | undefined): string | undefined => {
  const task = value?.trim();
  return task ? task.slice(0, 20_000) : undefined;
};

export class PrewalkController {
  #status: FabricPrewalkStatus = { state: "idle" };
  #settling = new Set<string>();

  status(): FabricPrewalkStatus {
    return structuredClone(this.#status);
  }

  arm(input: {
    model: string;
    mode?: FabricPrewalkMode;
    sessionId: string;
    task?: string;
    alwaysRearm?: boolean;
    thinking?: FabricThinking;
  }): FabricPrewalkStatus {
    const model = input.model.trim();
    if (!model.includes("/")) throw new Error("Prewalk requires a provider/model executor target");
    if (input.thinking !== undefined && !isFabricThinking(input.thinking)) {
      throw new Error(`Invalid prewalk thinking level: ${String(input.thinking)}`);
    }
    const task = normalizedTask(input.task);
    this.#settling.clear();
    this.#status = {
      state: "armed",
      mode: input.mode ?? "in-place",
      model,
      sessionId: input.sessionId,
      armedAt: Date.now(),
      alwaysRearm: input.alwaysRearm === true,
      ...(task ? { task } : {}),
      ...(input.thinking ? { thinking: input.thinking } : {}),
    };
    return this.status();
  }

  observeTask(sessionId: string, task: string): FabricPrewalkStatus {
    if (
      this.#status.state !== "armed" ||
      this.#status.sessionId !== sessionId ||
      this.#status.task
    ) {
      return this.status();
    }
    const normalized = normalizedTask(task);
    if (normalized) this.#status = { ...this.#status, task: normalized };
    return this.status();
  }

  isArmed(sessionId?: string): boolean {
    return (
      this.#status.state === "armed" &&
      (sessionId === undefined || this.#status.sessionId === sessionId)
    );
  }

  beginContinuation(continuationId: string, returnModel: string): FabricPrewalkStatus {
    if (this.#status.state !== "handing_off" || this.#status.mode !== "in-place") {
      return this.status();
    }
    this.#status = {
      ...this.#status,
      state: "continuation_pending",
      continuationId,
      returnModel,
      accepted: false,
    };
    return this.status();
  }

  acceptContinuation(sessionId: string, continuationId: string): boolean {
    if (
      this.#status.state !== "continuation_pending" ||
      this.#status.sessionId !== sessionId ||
      this.#status.continuationId !== continuationId
    ) {
      return false;
    }
    this.#status = { ...this.#status, accepted: true };
    return true;
  }

  takeContinuationSettlement(sessionId: string): FabricPrewalkSettlement | undefined {
    if (
      this.#status.state !== "continuation_pending" ||
      this.#status.sessionId !== sessionId ||
      !this.#status.accepted ||
      this.#settling.has(this.#status.continuationId)
    ) {
      return undefined;
    }
    this.#settling.add(this.#status.continuationId);
    return {
      continuationId: this.#status.continuationId,
      returnModel: this.#status.returnModel,
      executorModel: this.#status.model,
    };
  }

  finishContinuation(sessionId: string, continuationId: string): boolean {
    if (
      this.#status.state !== "continuation_pending" ||
      this.#status.sessionId !== sessionId ||
      this.#status.continuationId !== continuationId ||
      !this.#settling.delete(continuationId)
    ) {
      return false;
    }
    this.completeTask();
    return true;
  }

  failHandoff(): FabricPrewalkStatus {
    if (this.#status.state !== "handing_off") return this.status();
    this.#status = { ...this.#status, state: "armed" };
    return this.status();
  }

  settleTask(sessionId: string): boolean {
    if (
      this.#status.state !== "armed" ||
      this.#status.sessionId !== sessionId ||
      !this.#status.task
    ) {
      return false;
    }
    this.completeTask();
    return true;
  }

  completeTask(): FabricPrewalkStatus {
    if (this.#status.state === "idle") return this.status();
    if (!this.#status.alwaysRearm) {
      this.cancel();
      return this.status();
    }
    this.#status = {
      state: "armed",
      mode: this.#status.mode,
      model: this.#status.model,
      sessionId: this.#status.sessionId,
      armedAt: Date.now(),
      alwaysRearm: true,
      ...(this.#status.thinking ? { thinking: this.#status.thinking } : {}),
    };
    return this.status();
  }

  claim(audits: FabricCallAudit[], sessionId: string): FabricPrewalkClaim | undefined {
    if (!this.isArmed(sessionId) || this.#status.state !== "armed") return undefined;
    if (audits.some((audit) => audit.ref === "agents.handoff" && audit.success === true)) {
      this.completeTask();
      return undefined;
    }
    const mutation = audits.find(
      (audit) => PREWALK_TRIGGER_REFS.has(audit.ref) && audit.success === true,
    );
    if (!mutation) return undefined;
    const arm: FabricPrewalkArm = {
      mode: this.#status.mode,
      model: this.#status.model,
      sessionId: this.#status.sessionId,
      armedAt: this.#status.armedAt,
      alwaysRearm: this.#status.alwaysRearm,
      ...(this.#status.task ? { task: this.#status.task } : {}),
      ...(this.#status.thinking ? { thinking: this.#status.thinking } : {}),
    };
    this.#status = { state: "handing_off", ...arm };
    return { arm, mutation };
  }

  cancel(): void {
    this.#settling.clear();
    this.#status = { state: "idle" };
  }
}
