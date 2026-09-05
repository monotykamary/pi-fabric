import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import type { NativeConversationTranscript } from "./conversation-native-reader.js";

export const CONVERSATION_COMMANDS = [
  { value: "/copy", label: "/copy", description: "Copy the last assistant response" },
  { value: "/copy selection", label: "/copy selection", description: "Copy selected transcript text" },
  { value: "/latest", label: "/latest", description: "Clear selection and follow latest output" },
  { value: "/agents", label: "/agents", description: "Choose a conversation" },
  { value: "/back", label: "/back", description: "Return to Main" },
  { value: "/stop", label: "/stop", description: "Confirm stopping this participant" },
  { value: "/help", label: "/help", description: "Show preview commands" },
] satisfies AutocompleteItem[];

export const CONVERSATION_COMMAND_HELP = "Commands: /copy [selection] · /latest · /agents · /back · /stop · /help";

export function conversationCommandCompletion(enabled: () => boolean): AutocompleteProvider {
  return {
    triggerCharacters: ["/"],
    async getSuggestions(lines, row, col, options) {
      if (!enabled() || options.signal.aborted || row !== 0 || lines.length !== 1) return null;
      const prefix = lines[0]!.slice(0, col);
      if (col !== lines[0]!.length || !/^\/[a-z]*(?: +[a-z]*)?$/.test(prefix)) return null;
      const items = CONVERSATION_COMMANDS.filter((item) => item.value.startsWith(prefix));
      return items.length ? { items, prefix } : null;
    },
    applyCompletion(lines, row, _col, item) {
      const next = [...lines];
      next[row] = `${item.value} `;
      return { lines: next, cursorLine: row, cursorCol: next[row]!.length };
    },
  };
}

/** Match Pi's /copy semantics: text from the last non-empty-aborted assistant. */
export function conversationAssistantText(transcript: NativeConversationTranscript): string | undefined {
  for (let index = transcript.messages.length - 1; index >= 0; index--) {
    const message = transcript.messages[index]!;
    if (message.role !== "assistant" || (message.stopReason === "aborted" && message.content.length === 0)) continue;
    const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("").trim();
    return text || undefined;
  }
  return undefined;
}
