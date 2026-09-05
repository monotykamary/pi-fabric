import { createHash } from "node:crypto";
import { createConversationQueue, type ConversationQueue, type ConversationQueueOptions, type ConversationSnapshotEntry } from "./conversation-queue.js";
import type { NativeConversationTranscript } from "./conversation-native-reader.js";
import { unwrapActorEnvelopeText } from "./conversation-transcript.js";

interface QueueSlot {
  queue: ConversationQueue;
  attached: ConversationQueueOptions | undefined;
  initialized: boolean;
  frontier: number;
  projection?: QueueProjection | undefined;
}

interface QueueProjection {
  messages: NativeConversationTranscript["messages"];
  messageCount: number;
  revision: number;
  sourceId: string;
  sessionFile: string | undefined;
  eventsFile: string | undefined;
  leafId: string | null;
  entries: ConversationSnapshotEntry[];
}

interface UserIdentity {
  content: string;
  timestamp: number;
  id: string;
  text: string;
}

/** Session-owned queues; replacing a view never strands an acknowledgement or editor. */
export class ConversationQueueStore {
  private readonly slots = new Map<string, QueueSlot>();
  private readonly userIdentities = new WeakMap<object, UserIdentity>();

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
    slot.projection = undefined;
  }

  sync(id: string, transcript: NativeConversationTranscript): void {
    const slot = this.slots.get(id);
    if (!slot) return;
    let projection = slot.projection;
    const changed = !projection || projection.messages !== transcript.messages ||
      projection.messageCount !== transcript.messages.length || projection.revision !== transcript.revision ||
      projection.sourceId !== transcript.sourceId || projection.sessionFile !== transcript.sessionFile ||
      projection.eventsFile !== transcript.eventsFile || projection.leafId !== transcript.leafId;
    if (changed) {
      let frontier = slot.frontier;
      const occurrences = new Map<string, number>();
      const entries: ConversationSnapshotEntry[] = [];
      for (const message of transcript.messages) {
        if (Number.isFinite(message.timestamp)) frontier = Math.max(frontier, message.timestamp);
        if (message.role !== "user") continue;
        const { id: identity, text } = this.userIdentity(message);
        const occurrence = occurrences.get(identity) ?? 0;
        occurrences.set(identity, occurrence + 1);
        entries.push({ id: occurrence === 0 ? identity : `${identity}:${occurrence}`, text,
          historical: !slot.initialized || message.timestamp < slot.frontier });
      }
      projection = {
        messages: transcript.messages, messageCount: transcript.messages.length, revision: transcript.revision,
        sourceId: transcript.sourceId, sessionFile: transcript.sessionFile, eventsFile: transcript.eventsFile,
        leafId: transcript.leafId, entries,
      };
      // Inactive queues keep delivery frontiers, not a strong reference to the
      // reader's entire transcript. Its identity cache uses weak keys too.
      slot.projection = slot.attached ? projection : undefined;
      slot.frontier = frontier;
      slot.initialized = true;
    }
    // A routing acknowledgement can arrive after its native entry, without a
    // transcript change. Pending sends must still check cached delivery ids.
    if (projection && (changed || slot.queue.pendingCount() > 0)) slot.queue.syncSnapshot(projection.entries);
    slot.queue.syncPending(transcript.pendingMessages);
  }

  private userIdentity(message: Extract<NativeConversationTranscript["messages"][number], { role: "user" }>): Pick<UserIdentity, "id" | "text"> {
    const cached = this.userIdentities.get(message);
    if (cached && cached.content === message.content && cached.timestamp === message.timestamp) return cached;
    const raw = typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
    const text = unwrapActorEnvelopeText(raw) ?? raw;
    let id: string | undefined;
    if (text !== raw) {
      try {
        const envelope = JSON.parse(raw.trim().slice("Fabric actor message from direct:".length));
        if (typeof envelope.id === "string") id = envelope.id;
      } catch { /* Only a validated actor envelope can provide a delivery id. */ }
    }
    id ||= createHash("sha256").update(JSON.stringify([message.timestamp, message.content])).digest("hex");
    const identity = { id, text };
    // Array blocks can be mutated in place; recheck them on changed projections
    // rather than trusting their container identity for delivery matching.
    if (typeof message.content === "string") {
      this.userIdentities.set(message, { ...identity, content: message.content, timestamp: message.timestamp });
    }
    return identity;
  }

  clear(): void {
    for (const slot of this.slots.values()) { slot.queue.cancelEditing(); slot.attached = undefined; slot.projection = undefined; slot.queue.dispose(); }
    this.slots.clear();
  }
}
