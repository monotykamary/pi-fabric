import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { NativeAgentMessage, NativeConversationTranscript } from "../../src/ui/conversation-native-reader.js";

export const userMessage = (text: string, timestamp = 1): NativeAgentMessage => ({
  role: "user", content: text, timestamp,
});

export const assistantMessage = (text: string, timestamp = 2): AssistantMessage => ({
  role: "assistant", content: [{ type: "text", text }], timestamp,
  api: "openai-responses", provider: "openai", model: "fixture", stopReason: "stop",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});

export const nativeTranscript = (
  messages: NativeAgentMessage[] = [],
  overrides: Partial<NativeConversationTranscript> = {},
): NativeConversationTranscript => ({
  messages, revision: 1,
  entries: messages.map((message, index) => {
    const id = `message-${index}`;
    const parentId = index === 0 ? null : `message-${index - 1}`;
    const timestamp = new Date(message.timestamp).toISOString();
    return { entryId: id, parentId, entryType: "message", timestamp, message,
      entry: { type: "message", id, parentId, timestamp, message } };
  }),
  streaming: { active: false, tools: [] }, leafId: messages.length ? `message-${messages.length - 1}` : null,
  sourceId: "fixture", status: "completed", historyComplete: true, hasMore: false, hasNewer: false, updatedAt: 1,
  ...overrides,
});
