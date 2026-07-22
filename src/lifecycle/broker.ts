import { randomUUID } from "node:crypto";
import { MeshStore, type MeshIdentity, type MeshStateEntry } from "../mesh/store.js";
import type { FabricParticipantSource } from "../topology/types.js";
import {
  FABRIC_LIFECYCLE_SUBSCRIPTION_PREFIX,
  FABRIC_PARTICIPANT_LIFECYCLE_TOPIC,
  lifecycleEventFromMesh,
  lifecycleSourceIdentity,
  lifecycleSubscriptionFromValue,
  type FabricLifecycleEvent,
  type FabricLifecyclePublishRequest,
  type FabricLifecycleSubscription,
  type FabricLifecycleSubscriptionRequest,
} from "./types.js";

export interface LifecycleBrokerOptions {
  enabled: boolean;
  pollMs: number;
  maxReadEvents: number;
}

export type FabricLifecycleDeliveryHandler = (
  subscription: FabricLifecycleSubscription,
  event: FabricLifecycleEvent,
) => Promise<void> | void;

const subscriptionKey = (id: string): string =>
  FABRIC_LIFECYCLE_SUBSCRIPTION_PREFIX + id;

export class LifecycleBroker {
  readonly #pollMs: number;
  readonly #maxReadEvents: number;
  #timer: NodeJS.Timeout | undefined;
  #polling: Promise<void> | undefined;
  #publishTail: Promise<void> = Promise.resolve();
  #pollScheduled = false;
  #closed = false;

  constructor(
    readonly mesh: MeshStore,
    readonly identity: MeshIdentity,
    readonly participants: FabricParticipantSource,
    readonly options: LifecycleBrokerOptions,
    readonly deliver: FabricLifecycleDeliveryHandler,
  ) {
    this.#pollMs = Math.max(20, options.pollMs);
    this.#maxReadEvents = Math.max(1, options.maxReadEvents);
  }

  start(): void {
    if (!this.options.enabled || this.#timer) return;
    this.#closed = false;
    this.#timer = setInterval(() => this.#schedulePoll(), this.#pollMs);
    this.#timer.unref();
    this.#schedulePoll();
  }

  publish(
    request: FabricLifecyclePublishRequest,
  ): Promise<FabricLifecycleEvent | undefined> {
    if (
      !this.options.enabled ||
      this.#closed ||
      !this.#isObserved(request.source.id, request.event)
    ) return Promise.resolve(undefined);
    const operation = this.#publishTail.then(async () => {
      const occurredAt = request.occurredAt ?? Date.now();
      const event = await this.mesh.publish({
        topic: FABRIC_PARTICIPANT_LIFECYCLE_TOPIC,
        kind: request.event,
        from: lifecycleSourceIdentity(request.source),
        data: {
          version: 1,
          event: request.event,
          source: request.source,
          occurredAt,
          ...(request.runId ? { runId: request.runId } : {}),
          ...(request.status ? { status: request.status } : {}),
          ...(request.data === undefined ? {} : { payload: request.data }),
        },
      });
      this.#schedulePoll();
      return lifecycleEventFromMesh(event);
    });
    this.#publishTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async subscribe(
    request: FabricLifecycleSubscriptionRequest,
  ): Promise<FabricLifecycleSubscription> {
    if (!this.options.enabled) {
      throw new Error("Fabric mesh is disabled; lifecycle subscriptions are unavailable");
    }
    const from = request.from.trim();
    const to = request.to.trim();
    if (!from) throw new Error("Lifecycle subscription source is empty");
    if (!to) throw new Error("Lifecycle subscription target is empty");
    if (from === to) {
      throw new Error("Lifecycle subscriptions cannot target their own source");
    }
    const events = [...new Set(request.events)];
    if (events.length === 0) throw new Error("Lifecycle subscription requires at least one event");

    await this.participants.refresh();
    const source = this.participants.get(from);
    if (!source || source.stale) throw new Error("Unknown or stale lifecycle source: " + from);
    const target = this.participants.get(to);
    if (!target || target.stale) throw new Error("Unknown or stale lifecycle target: " + to);
    if (!target.capabilities.includes(request.delivery)) {
      throw new Error(
        "Fabric participant " + to + " does not support " + request.delivery + " delivery",
      );
    }

    const now = Date.now();
    const subscription: FabricLifecycleSubscription = {
      format: 1,
      id: randomUUID().replaceAll("-", ""),
      from,
      events,
      to,
      delivery: request.delivery,
      triggerTurn: request.triggerTurn,
      once: request.once === true,
      afterSequence: this.mesh.latestSequence(),
      createdAt: now,
      updatedAt: now,
      createdBy: structuredClone(this.identity),
    };
    await this.mesh.put({
      key: subscriptionKey(subscription.id),
      value: subscription,
      identity: this.identity,
      ifVersion: 0,
    });
    this.#schedulePoll();
    return structuredClone(subscription);
  }

  list(input: { from?: string; to?: string } = {}): FabricLifecycleSubscription[] {
    return this.mesh
      .listAll(FABRIC_LIFECYCLE_SUBSCRIPTION_PREFIX)
      .flatMap((entry) => {
        const subscription = lifecycleSubscriptionFromValue(entry.value);
        if (!subscription || entry.key !== subscriptionKey(subscription.id)) return [];
        if (input.from && subscription.from !== input.from) return [];
        if (input.to && subscription.to !== input.to) return [];
        return [structuredClone(subscription)];
      });
  }

  async unsubscribe(id: string): Promise<{ removed: boolean }> {
    const key = subscriptionKey(id.trim());
    const entry = this.mesh.get(key);
    if (!entry || !lifecycleSubscriptionFromValue(entry.value)) return { removed: false };
    const result = await this.mesh.delete({ key, ifVersion: entry.version });
    return { removed: result.deleted };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#publishTail;
    await this.#polling?.catch(() => undefined);
  }

  #schedulePoll(): void {
    if (
      this.#pollScheduled ||
      this.#closed ||
      !this.options.enabled
    ) return;
    this.#pollScheduled = true;
    queueMicrotask(() => {
      this.#pollScheduled = false;
      if (this.#closed) return;
      void this.#poll().catch(() => undefined);
    });
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
    const entries = this.mesh.listAll(FABRIC_LIFECYCLE_SUBSCRIPTION_PREFIX);
    for (const entry of entries) {
      const subscription = lifecycleSubscriptionFromValue(entry.value);
      if (!subscription || entry.key !== subscriptionKey(subscription.id)) continue;
      const target = this.participants.get(subscription.to);
      if (!target || target.stale || !target.local) continue;
      await this.#drainSubscription(entry, subscription);
    }
  }

  async #drainSubscription(
    initialEntry: MeshStateEntry,
    initial: FabricLifecycleSubscription,
  ): Promise<void> {
    let entry = initialEntry;
    let subscription = initial;
    while (!this.#closed) {
      const latestSequence = this.mesh.latestSequence();
      if (latestSequence <= subscription.afterSequence) return;
      const events = this.mesh.read({
        after: subscription.afterSequence,
        limit: this.#maxReadEvents,
      });
      if (events.length === 0) {
        await this.#replace(entry, {
          ...subscription,
          afterSequence: latestSequence,
          updatedAt: Date.now(),
        }).catch(() => undefined);
        return;
      }

      let cursor = subscription.afterSequence;
      let lastDeliveredAt = subscription.lastDeliveredAt;
      let lastEventId = subscription.lastEventId;
      for (const meshEvent of events) {
        const lifecycle = lifecycleEventFromMesh(meshEvent);
        if (!lifecycle) {
          cursor = Math.max(cursor, meshEvent.sequence);
          continue;
        }
        const matches =
          lifecycle.source.id === subscription.from &&
          subscription.events.includes(lifecycle.event) &&
          this.#sourceIsCurrentOwner(lifecycle);
        if (!matches) {
          cursor = lifecycle.sequence;
          continue;
        }
        try {
          await this.deliver(subscription, lifecycle);
        } catch (error) {
          const failed: FabricLifecycleSubscription = {
            ...subscription,
            afterSequence: cursor,
            updatedAt: Date.now(),
            lastError: error instanceof Error ? error.message : String(error),
          };
          await this.#replace(entry, failed).catch(() => undefined);
          return;
        }
        cursor = lifecycle.sequence;
        lastDeliveredAt = Date.now();
        lastEventId = lifecycle.id;
        if (subscription.once) {
          await this.mesh
            .delete({ key: entry.key, ifVersion: entry.version })
            .catch(() => ({ deleted: false }));
          return;
        }
      }

      const updated: FabricLifecycleSubscription = {
        ...subscription,
        afterSequence: cursor,
        updatedAt: Date.now(),
        ...(lastDeliveredAt !== undefined ? { lastDeliveredAt } : {}),
        ...(lastEventId !== undefined ? { lastEventId } : {}),
      };
      delete updated.lastError;
      const next = await this.#replace(entry, updated).catch(() => undefined);
      if (!next) return;
      entry = next;
      subscription = updated;
      if (events.length < this.#maxReadEvents) return;
    }
  }

  #sourceIsCurrentOwner(event: FabricLifecycleEvent): boolean {
    const participant = this.participants.get(event.source.id);
    return Boolean(
      participant &&
      !participant.stale &&
      event.source.ownerHostId &&
      event.source.ownerIdentityId &&
      participant.kind === event.source.kind &&
      participant.rootId === event.source.rootId &&
      participant.runner === event.source.runner &&
      participant.ownerHostId === event.source.ownerHostId &&
      participant.ownerIdentityId === event.source.ownerIdentityId
    );
  }

  #isObserved(sourceId: string, event: FabricLifecyclePublishRequest["event"]): boolean {
    return this.mesh
      .listAll(FABRIC_LIFECYCLE_SUBSCRIPTION_PREFIX)
      .some((entry) => {
        const subscription = lifecycleSubscriptionFromValue(entry.value);
        return (
          subscription !== undefined &&
          entry.key === subscriptionKey(subscription.id) &&
          subscription.from === sourceId &&
          subscription.events.includes(event)
        );
      });
  }

  async #replace(
    entry: MeshStateEntry,
    subscription: FabricLifecycleSubscription,
  ): Promise<MeshStateEntry> {
    return this.mesh.put({
      key: entry.key,
      value: subscription,
      identity: this.identity,
      ifVersion: entry.version,
    });
  }
}
