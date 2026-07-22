import { createHash, randomUUID } from "node:crypto";
import { MeshStore, type MeshEvent, type MeshIdentity } from "../mesh/store.js";

const CONTROL_TOPIC = "fabric.control.command";
const ACK_TOPIC = "fabric.control.ack";
const CONTROL_SEEN_PREFIX = "topology/control-seen/";
const DEFAULT_POLL_MS = 100;
const DEFAULT_ACK_TIMEOUT_MS = 5_000;

export type FabricControlOperation = "steer" | "followUp" | "stop";

export interface FabricControlCommand {
  version: 1;
  commandId: string;
  targetId: string;
  operation: FabricControlOperation;
  replyTo: string;
  message?: string;
  data?: unknown;
  requestedAt: number;
}

export interface FabricControlAcceptance {
  accepted: boolean;
  messageId?: string;
  error?: string;
}

export interface FabricControlResult {
  queued: true;
  messageId: string;
  routed: "mesh";
  acknowledged: true;
}

export type FabricControlHandler = (
  command: FabricControlCommand,
  from: MeshIdentity,
) => Promise<FabricControlAcceptance> | FabricControlAcceptance;

const controlSeenKey = (hostId: string, commandId: string): string =>
  CONTROL_SEEN_PREFIX +
  createHash("sha256").update(`${hostId}\0${commandId}`).digest("hex");

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const commandFromEvent = (event: MeshEvent): FabricControlCommand | undefined => {
  if (!isObject(event.data) || event.data.version !== 1) return undefined;
  const data = event.data;
  if (
    data.version !== 1 ||
    typeof data.commandId !== "string" ||
    typeof data.targetId !== "string" ||
    (data.operation !== "steer" && data.operation !== "followUp" && data.operation !== "stop") ||
    typeof data.replyTo !== "string" ||
    typeof data.requestedAt !== "number"
  ) {
    return undefined;
  }
  return data as unknown as FabricControlCommand;
};

interface FabricControlSeenRecord {
  format: 1;
  hostId: string;
  commandId: string;
  targetId: string;
  expiresAt: number;
  acceptance?: FabricControlAcceptance;
}

const controlSeenRecord = (value: unknown): FabricControlSeenRecord | undefined => {
  if (!isObject(value) || value.format !== 1) return undefined;
  if (
    typeof value.hostId !== "string" ||
    typeof value.commandId !== "string" ||
    typeof value.targetId !== "string" ||
    typeof value.expiresAt !== "number"
  ) {
    return undefined;
  }
  return value as unknown as FabricControlSeenRecord;
};

export interface FabricControlPlaneOptions {
  enabled: boolean;
  hostId: string;
  pollMs?: number;
  acknowledgementTimeoutMs?: number;
}

export class FabricControlPlane {
  readonly #pending = new Map<
    string,
    {
      resolve: (acceptance: FabricControlAcceptance) => void;
      timer: NodeJS.Timeout;
      ownerIdentityId: string;
      targetId: string;
    }
  >();
  readonly #pollMs: number;
  readonly #ackTimeoutMs: number;
  #offset: number;
  #lastSequence: number;
  #timer: NodeJS.Timeout | undefined;
  #polling: Promise<void> | undefined;
  #closed = false;
  #handler: FabricControlHandler | undefined;
  #seenCleanupAt = 0;

  constructor(
    readonly mesh: MeshStore,
    readonly identity: MeshIdentity,
    readonly options: FabricControlPlaneOptions,
  ) {
    this.#pollMs = Math.max(20, options.pollMs ?? DEFAULT_POLL_MS);
    this.#ackTimeoutMs = Math.max(this.#pollMs * 4, options.acknowledgementTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS);
    // Replay the retained log from its current generation. Durable claims
    // recover unclaimed commands and make interrupted outcomes explicit without re-execution.
    this.#offset = 0;
    this.#lastSequence = 0;
  }

  start(handler: FabricControlHandler): void {
    this.#handler = handler;
    if (!this.options.enabled || this.#timer) return;
    this.#closed = false;
    this.#timer = setInterval(() => void this.#poll().catch(() => undefined), this.#pollMs);
    this.#timer.unref();
  }

  async request(
    ownerHostId: string,
    targetId: string,
    operation: FabricControlOperation,
    input: { message?: string; data?: unknown } = {},
    ownerIdentityId = ownerHostId,
  ): Promise<FabricControlResult> {
    if (!this.options.enabled) throw new Error("Fabric mesh is disabled; cannot control a remote participant");
    if (!ownerHostId.trim()) throw new Error("Remote participant has no execution owner");
    const commandId = randomUUID();
    const acceptance = new Promise<FabricControlAcceptance>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(commandId);
        reject(new Error("Timed out waiting for the remote Fabric owner to acknowledge " + targetId));
      }, this.#ackTimeoutMs);
      timer.unref();
      this.#pending.set(commandId, { resolve, timer, ownerIdentityId, targetId });
    });
    try {
      await this.mesh.publish({
        topic: CONTROL_TOPIC,
        kind: operation,
        from: this.identity,
        to: ownerHostId,
        data: {
          version: 1,
          commandId,
          targetId,
          operation,
          replyTo: this.options.hostId,
          ...(input.message !== undefined ? { message: input.message } : {}),
          ...(input.data !== undefined ? { data: input.data } : {}),
          requestedAt: Date.now(),
        } satisfies FabricControlCommand,
      });
      const acknowledged = await acceptance;
      if (!acknowledged.accepted) {
        throw new Error(acknowledged.error || "Remote Fabric owner rejected command for " + targetId);
      }
      return { queued: true, messageId: acknowledged.messageId ?? commandId, routed: "mesh", acknowledged: true };
    } catch (error) {
      const pending = this.#pending.get(commandId);
      if (pending) clearTimeout(pending.timer);
      this.#pending.delete(commandId);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#polling?.catch(() => undefined);
    await this.#drain().catch(() => undefined);
    this.#closed = true;
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.resolve({ accepted: false, error: "Fabric control plane closed" });
      this.#pending.delete(id);
    }
    this.#handler = undefined;
  }

  async #poll(): Promise<void> {
    if (this.#closed || !this.options.enabled) return;
    if (this.#polling) return this.#polling;
    const operation = this.#drain();
    this.#polling = operation;
    try {
      await operation;
    } finally {
      if (this.#polling === operation) this.#polling = undefined;
    }
  }

  async #drain(): Promise<void> {
    while (true) {
      const tail = this.mesh.tail(this.#offset, 100);
      this.#offset = tail.nextOffset;
      for (const event of tail.events) {
        if (event.sequence <= this.#lastSequence) continue;
        this.#lastSequence = event.sequence;
        if (event.to !== this.options.hostId) continue;
        if (event.topic === ACK_TOPIC) this.#acceptAcknowledgement(event);
        else if (event.topic === CONTROL_TOPIC) await this.#acceptCommand(event);
      }
      if (tail.events.length < 100) break;
    }
  }

  #acceptAcknowledgement(event: MeshEvent): void {
    if (!isObject(event.data) || typeof event.data.commandId !== "string") return;
    const pending = this.#pending.get(event.data.commandId);
    if (
      !pending ||
      event.data.version !== 1 ||
      event.data.targetId !== pending.targetId ||
      event.from.id !== pending.ownerIdentityId
    ) {
      return;
    }
    clearTimeout(pending.timer);
    this.#pending.delete(event.data.commandId);
    pending.resolve({
      accepted: event.data.accepted === true,
      ...(typeof event.data.messageId === "string" ? { messageId: event.data.messageId } : {}),
      ...(typeof event.data.error === "string" ? { error: event.data.error } : {}),
    });
  }

  async #acceptCommand(event: MeshEvent): Promise<void> {
    const command = commandFromEvent(event);
    if (!command) return;
    const now = Date.now();
    await this.#cleanupSeen(now);
    const age = now - command.requestedAt;
    if (age > this.#ackTimeoutMs || age < -this.#ackTimeoutMs) {
      await this.#publishAcknowledgement(command, {
        accepted: false,
        error: "Fabric control command expired",
      });
      return;
    }

    const key = controlSeenKey(this.options.hostId, command.commandId);
    const duplicate = controlSeenRecord(this.mesh.get(key)?.value);
    if (duplicate) {
      if (
        duplicate.hostId === this.options.hostId &&
        duplicate.commandId === command.commandId &&
        duplicate.targetId === command.targetId
      ) {
        await this.#publishAcknowledgement(
          command,
          duplicate.acceptance ?? {
            accepted: false,
            error: "Fabric control outcome is indeterminate after owner restart",
          },
        );
      }
      return;
    }

    let claim;
    try {
      claim = await this.mesh.put({
        key,
        value: {
          format: 1,
          hostId: this.options.hostId,
          commandId: command.commandId,
          targetId: command.targetId,
          expiresAt: now + this.#ackTimeoutMs,
        } satisfies FabricControlSeenRecord,
        identity: this.identity,
        ifVersion: 0,
      });
    } catch {
      const raced = controlSeenRecord(this.mesh.get(key)?.value);
      if (
        raced?.hostId === this.options.hostId &&
        raced.commandId === command.commandId &&
        raced.targetId === command.targetId
      ) {
        await this.#publishAcknowledgement(
          command,
          raced.acceptance ?? {
            accepted: false,
            error: "Fabric control outcome is indeterminate after concurrent claim",
          },
        );
      }
      return;
    }

    let acceptance: FabricControlAcceptance;
    try {
      acceptance = this.#handler
        ? await this.#handler(command, event.from)
        : { accepted: false, error: "Fabric owner has no control handler" };
    } catch (error) {
      acceptance = {
        accepted: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    try {
      await this.mesh.put({
        key,
        value: {
          format: 1,
          hostId: this.options.hostId,
          commandId: command.commandId,
          targetId: command.targetId,
          expiresAt: now + this.#ackTimeoutMs,
          acceptance,
        } satisfies FabricControlSeenRecord,
        identity: this.identity,
        ifVersion: claim.version,
      });
    } catch {
      return;
    }
    await this.#publishAcknowledgement(command, acceptance);
  }

  async #cleanupSeen(now: number): Promise<void> {
    if (now - this.#seenCleanupAt < this.#ackTimeoutMs) return;
    this.#seenCleanupAt = now;
    const expired = this.mesh.listAll(CONTROL_SEEN_PREFIX).filter((entry) => {
      const record = controlSeenRecord(entry.value);
      return !record || record.expiresAt < now;
    });
    await Promise.allSettled(
      expired.map((entry) =>
        this.mesh.delete({ key: entry.key, ifVersion: entry.version }),
      ),
    );
  }

  async #publishAcknowledgement(
    command: FabricControlCommand,
    acceptance: FabricControlAcceptance,
  ): Promise<void> {
    await this.mesh
      .publish({
        topic: ACK_TOPIC,
        kind: acceptance.accepted ? "accepted" : "rejected",
        from: this.identity,
        to: command.replyTo,
        data: {
          version: 1,
          commandId: command.commandId,
          targetId: command.targetId,
          accepted: acceptance.accepted,
          ...(acceptance.messageId ? { messageId: acceptance.messageId } : {}),
          ...(acceptance.error ? { error: acceptance.error } : {}),
        },
      })
      .catch(() => undefined);
  }
}
