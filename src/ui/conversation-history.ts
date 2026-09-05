import type { NativeConversationTranscript } from "./conversation-native-reader.js";
import { unwrapActorEnvelopeText } from "./conversation-transcript.js";

const PROMPT_HISTORY_LIMIT = 100;

/** Pi keeps the newest 100 trimmed prompts, suppressing consecutive duplicates. */
export function appendConversationPrompt(history: string[], text: string): void {
  const prompt = text.trim();
  if (!prompt || history.at(-1) === prompt) return;
  history.push(prompt);
  if (history.length > PROMPT_HISTORY_LIMIT) history.shift();
}

/** Seed once on history use, without retaining transcript objects or reading more pages. */
export function conversationPromptHistory(transcript: NativeConversationTranscript): string[] {
  const newest: string[] = [];
  for (let index = transcript.messages.length - 1; index >= 0 && newest.length < PROMPT_HISTORY_LIMIT; index--) {
    const message = transcript.messages[index]!;
    if (message.role !== "user") continue;
    const raw = typeof message.content === "string" ? message.content
      : message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
    const text = (unwrapActorEnvelopeText(raw) ?? raw).trim();
    if (text && newest.at(-1) !== text) newest.push(text);
  }
  return newest.reverse();
}
