import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { HANDOFF_COMPLETION_MESSAGE_TYPE } from "../agents/handoff-completion.js";

export const registerHandoffCompletionRenderer = (extension: ExtensionAPI): void => {
  extension.registerMessageRenderer(HANDOFF_COMPLETION_MESSAGE_TYPE, (message, { outputPad }) => {
    const details = message.details as { displayText?: string } | undefined;
    // Internal continuation instructions stay in model context, not the TUI.
    return new Text(details?.displayText ?? "Fabric handoff finished. See the handoff tool result.", outputPad, 0);
  });
};
