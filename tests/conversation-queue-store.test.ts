import { describe, expect, it } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { ConversationQueueStore } from "../src/ui/conversation-queue-store.js";
import { nativeTranscript, userMessage } from "./fixtures/native-conversation.js";
const options = (id: string) => ({ targetId: id, piEvents: { emit() {} }, theme: { fg: (_: string, text: string) => text } as unknown as Theme, send: async () => undefined });

describe("session-owned conversation queues", () => {
  it("retains acknowledgements across detach/reopen and matches actor delivery ids", async () => {
    const store = new ConversationQueueStore();
    const queue = store.attach({ ...options("a"), send: async () => ({ id: "delivery-1" }) });
    store.sync("a", nativeTranscript());
    await queue.dispatch("payload", "steer");
    store.detach("a");
    expect(store.attach(options("a"))).toBe(queue);
    store.sync("a", nativeTranscript([userMessage(`Fabric actor message from direct:\n${JSON.stringify({ id: "delivery-1", source: "direct", payload: { message: "payload" } })}`, 2)]));
    expect(queue.rows()).toEqual([]);
    store.clear();
    expect(store.get("a")).toBeUndefined();
  });

  it("does not confuse older pages with a new same-text delivery", async () => {
    const store = new ConversationQueueStore();
    const queue = store.attach(options("a"));
    store.sync("a", nativeTranscript([userMessage("latest", 100)]));
    await queue.dispatch("repeat", "steer");
    store.sync("a", nativeTranscript([userMessage("repeat", 1), userMessage("latest", 100)]));
    expect(queue.rows()).toHaveLength(1);
    store.sync("a", nativeTranscript([userMessage("repeat", 1), userMessage("latest", 100), userMessage("repeat", 101)]));
    expect(queue.rows()).toEqual([]);
    store.clear();
  });
});
