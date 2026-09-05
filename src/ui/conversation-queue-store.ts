import { createHash } from "node:crypto";
import { createConversationQueue, type ConversationQueue, type ConversationQueueOptions, type ConversationSnapshotEntry } from "./conversation-queue.js";
import type { NativeConversationTranscript } from "./conversation-native-reader.js";
import { unwrapActorEnvelopeText } from "./conversation-transcript.js";

interface QueueSlot {
  queue: ConversationQueue;
  attached: ConversationQueueOptions | undefined;
  initialized: boolean;
  frontier: number;
}

/** Session-owned queues; replacing a view never strands an acknowledgement or editor. */
export class ConversationQueueStore {
  private readonly slots = new Map<string, QueueSlot>();

  attach(options: ConversationQueueOptions): ConversationQueue {
    const existing = this.slots.get(options.targetId);
    if (existing) { existing.attached = options; return existing.queue; }
    const slot: QueueSlot = { queue: undefined as unknown as ConversationQueue, attached: options, initialized: false, frontier: 0 };
    const attached = () => slot.attached;
    slot.queue = createConversationQueue({
      ...options,
      send: (text, lane) => {
        const current = attached();
        if (!current) return Promise.reject(new Error("Open this conversation to send its queued messages"));
        return current.send(text, lane);
      },
      editor: {
        getText: () => attached()?.editor?.getText() ?? "",
        setText: (text) => attached()?.editor?.setText(text),
        handleInput: (data) => attached()?.editor?.handleInput?.(data),
        render: (width) => attached()?.editor?.render?.(width) ?? [],
        get paddingX() { return attached()?.editor?.paddingX ?? 0; },
      },
      isIdle: () => attached()?.isIdle?.() ?? true,
      onNotify: (text, kind) => attached()?.onNotify?.(text, kind),
      requestRender: () => attached()?.requestRender?.(),
    });
    this.slots.set(options.targetId, slot);
    return slot.queue;
  }

  get(id: string): ConversationQueue | undefined { return this.slots.get(id)?.queue; }

  detach(id: string): void {
    const slot = this.slots.get(id);
    if (!slot) return;
    slot.queue.cancelEditing();
    slot.attached = undefined;
  }

  sync(id: string, transcript: NativeConversationTranscript): void {
    const slot = this.slots.get(id);
    if (!slot) return;
    let frontier = slot.frontier;
    const occurrences = new Map<string, number>();
    const entries: ConversationSnapshotEntry[] = [];
    for (const message of transcript.messages) {
      if (Number.isFinite(message.timestamp)) frontier = Math.max(frontier, message.timestamp);
      if (message.role !== "user") continue;
      const raw = typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
      const text = unwrapActorEnvelopeText(raw) ?? raw;
      let identity: string | undefined;
      if (text !== raw) {
        try {
          const envelope = JSON.parse(raw.trim().slice("Fabric actor message from direct:".length));
          if (typeof envelope.id === "string") identity = envelope.id;
        } catch { /* Only a validated actor envelope can provide a delivery id. */ }
      }
      if (!identity) identity = createHash("sha256").update(JSON.stringify([message.timestamp, message.content])).digest("hex");
      const occurrence = occurrences.get(identity) ?? 0;
      occurrences.set(identity, occurrence + 1);
      entries.push({ id: occurrence === 0 ? identity : `${identity}:${occurrence}`, text,
        historical: !slot.initialized || message.timestamp < slot.frontier });
    }
    slot.queue.syncSnapshot(entries);
    slot.queue.syncPending(transcript.pendingMessages);
    slot.frontier = frontier;
    slot.initialized = true;
  }

  clear(): void {
    for (const slot of this.slots.values()) { slot.queue.cancelEditing(); slot.attached = undefined; slot.queue.dispose(); }
    this.slots.clear();
  }
}
