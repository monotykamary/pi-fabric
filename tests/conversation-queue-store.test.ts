import { afterEach, describe, expect, it, vi } from "vitest";

import type { Theme } from "@earendil-works/pi-coding-agent";
import { ConversationQueueStore } from "../src/ui/conversation-queue-store.js";
import { nativeTranscript, userMessage } from "./fixtures/native-conversation.js";
afterEach(() => vi.restoreAllMocks());

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

  it("does not hash or fold unchanged history, and hashes only a new string message on append", () => {
    const store = new ConversationQueueStore();
    const queue = store.attach(options("a"));
    const transcript = nativeTranscript(Array.from({ length: 500 }, (_, index) => userMessage(`message-${index}`, index + 1)));
    const serialize = vi.spyOn(JSON, "stringify");
    const fold = vi.spyOn(queue, "syncSnapshot");
    store.sync("a", transcript);
    expect(serialize).toHaveBeenCalledTimes(500);
    serialize.mockClear(); fold.mockClear();
    for (let index = 0; index < 5; index++) store.sync("a", transcript);
    expect(serialize).not.toHaveBeenCalled();
    expect(fold).not.toHaveBeenCalled();
    store.sync("a", nativeTranscript([...transcript.messages, userMessage("appended", 501)], { revision: 2 }));
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(fold).toHaveBeenCalledTimes(1);
    store.clear();
  });

  it("reconciles an acknowledgement arriving after its native entry without a new revision", async () => {
    const store = new ConversationQueueStore();
    let acknowledge!: (value: { id: string }) => void;
    const queue = store.attach({ ...options("a"), send: () => new Promise<{ id: string }>((resolve) => { acknowledge = resolve; }) });
    store.sync("a", nativeTranscript());
    const delivery = queue.dispatch("original wording", "steer");
    const transcript = nativeTranscript([userMessage(`Fabric actor message from direct:\n${JSON.stringify({ id: "late-delivery", source: "direct", payload: { message: "normalized wording" } })}`, 2)]);
    store.sync("a", transcript);
    expect(queue.rows()).toHaveLength(1);
    acknowledge({ id: "late-delivery" });
    await delivery;
    const serialize = vi.spyOn(JSON, "stringify");
    store.sync("a", transcript);
    expect(queue.rows()).toEqual([]);
    expect(serialize).not.toHaveBeenCalled();
    store.clear();
  });

  it("observes pending lanes independently of the unchanged transcript projection", () => {
    const store = new ConversationQueueStore();
    const queue = store.attach(options("a"));
    const transcript = nativeTranscript([userMessage("baseline")]);
    store.sync("a", transcript);
    const fold = vi.spyOn(queue, "syncSnapshot");
    store.sync("a", { ...transcript, pendingMessages: { steering: ["remote steer"], followUp: ["remote follow-up"] } });
    expect(queue.rows().map((row) => row.text)).toEqual(["remote steer", "remote follow-up"]);
    store.sync("a", { ...transcript, pendingMessages: { steering: [], followUp: [] } });
    expect(queue.rows()).toEqual([]);
    expect(fold).not.toHaveBeenCalled();
    store.clear();
  });

  it("does not key projections by revision alone across source or message replacements", () => {
    const store = new ConversationQueueStore();
    const queue = store.attach(options("a"));
    const first = nativeTranscript([userMessage("first", 1)], { revision: 1, eventsFile: "/run-1" });
    store.sync("a", first);
    const fold = vi.spyOn(queue, "syncSnapshot");
    store.sync("a", nativeTranscript([userMessage("replacement", 1)], { revision: 1, eventsFile: "/run-2" }));
    expect(fold).toHaveBeenCalledTimes(1);
    expect(fold.mock.calls[0]?.[0][0]?.text).toBe("replacement");
    store.clear();
  });

  it("rechecks mutable array blocks on a changed revision and keeps duplicate occurrences distinct", () => {
    const store = new ConversationQueueStore();
    const queue = store.attach(options("a"));
    const message = { role: "user" as const, timestamp: 1, content: [{ type: "text" as const, text: "before" }] };
    const transcript = nativeTranscript([message, message]);
    store.sync("a", transcript);
    const fold = vi.spyOn(queue, "syncSnapshot");
    message.content[0]!.text = "after";
    transcript.revision++;
    store.sync("a", transcript);
    const entries = fold.mock.calls[0]?.[0];
    expect(entries?.map((entry) => entry.text)).toEqual(["after", "after"]);
    expect(entries?.[1]?.id).toBe(`${entries?.[0]?.id}:1`);
    store.clear();
  });

  it("drops inactive projections while preserving queue delivery frontiers", () => {
    const store = new ConversationQueueStore();
    const queue = store.attach(options("a"));
    const transcript = nativeTranscript([userMessage("baseline")]);
    store.sync("a", transcript);
    const fold = vi.spyOn(queue, "syncSnapshot");
    store.detach("a");
    expect(store.attach(options("a"))).toBe(queue);
    store.sync("a", transcript);
    expect(fold).toHaveBeenCalledTimes(1);
    expect(fold.mock.calls[0]?.[0][0]?.id).toBeDefined();
    store.clear();
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
