import type * as Pi from "@earendil-works/pi-coding-agent";

/** Only the host APIs used by the native conversation UI. */
type ConversationHost = Pick<typeof Pi,
  | "AssistantMessageComponent" | "BashExecutionComponent"
  | "BranchSummaryMessageComponent" | "CompactionSummaryMessageComponent"
  | "CustomMessageComponent" | "SkillInvocationMessageComponent"
  | "ToolExecutionComponent" | "UserMessageComponent" | "parseSkillBlock"
  | "SettingsManager" | "copyToClipboard"
  | "buildContextEntries" | "sessionEntryToContextMessages"
>;

let host: ConversationHost | undefined;

// The eager controller receives Pi's aliased/virtual host module. Initialize
// this native-lazy module before loading any chat views, rather than resolving
// a second Pi installation (and its proper-lockfile/signal-exit dependency tree).
// Rebind on reopen so native module caching across /reload uses the current host.
export function initializeConversationHost(value: ConversationHost): void {
  host = value;
}

export function getConversationHost(): ConversationHost {
  if (!host) throw new Error("Fabric conversation host has not been initialized");
  return host;
}
