import type { FabricCallAudit } from "../core/action-registry.js";

const PREWALK_TRIGGER_REFS = new Set([
  "pi.edit",
  "pi.write",
  "schema.commit",
]);

interface FabricPrewalkArm {
  model: string;
  sessionId: string;
  armedAt: number;
  alwaysRearm: boolean;
  task?: string;
}

export type FabricPrewalkStatus =
  | { state: "idle" }
  | ({ state: "armed" | "handing_off" } & FabricPrewalkArm);

export interface FabricPrewalkClaim {
  arm: FabricPrewalkArm;
  mutation: FabricCallAudit;
}

const normalizedTask = (value: string | undefined): string | undefined => {
  const task = value?.trim();
  return task ? task.slice(0, 20_000) : undefined;
};

export class PrewalkController {
  #status: FabricPrewalkStatus = { state: "idle" };

  status(): FabricPrewalkStatus {
    return structuredClone(this.#status);
  }

  arm(input: {
    model: string;
    sessionId: string;
    task?: string;
    alwaysRearm?: boolean;
  }): FabricPrewalkStatus {
    const model = input.model.trim();
    if (!model.includes("/")) throw new Error("Prewalk requires a provider/model executor target");
    const task = normalizedTask(input.task);
    this.#status = {
      state: "armed",
      model,
      sessionId: input.sessionId,
      armedAt: Date.now(),
      alwaysRearm: input.alwaysRearm === true,
      ...(task ? { task } : {}),
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
      model: this.#status.model,
      sessionId: this.#status.sessionId,
      armedAt: Date.now(),
      alwaysRearm: true,
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
      model: this.#status.model,
      sessionId: this.#status.sessionId,
      armedAt: this.#status.armedAt,
      alwaysRearm: this.#status.alwaysRearm,
      ...(this.#status.task ? { task: this.#status.task } : {}),
    };
    this.#status = { state: "handing_off", ...arm };
    return { arm, mutation };
  }

  cancel(): void {
    this.#status = { state: "idle" };
  }
}
