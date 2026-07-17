import fs from "node:fs";
import path from "node:path";

export interface FixtureEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  [key: string]: unknown;
}

// Plain message records shaped like pi's AgentMessage union, without importing
// pi-ai (which is not a direct dependency of pi-fabric). The shapes below are
// structural matches for what normalize.ts reads.
type FixtureMessage = Record<string, unknown>;

export const sessionHeader = (
  id: string,
  cwd: string,
  timestamp = "2024-12-03T14:00:00.000Z",
): FixtureEntry => ({
  type: "session",
  version: 3,
  id,
  parentId: null,
  timestamp,
  cwd,
});

export const messageEntry = (
  id: string,
  parentId: string | null,
  timestamp: string,
  message: FixtureMessage,
): FixtureEntry => ({ type: "message", id, parentId, timestamp, message });

export const writeSessionFile = (
  dir: string,
  name: string,
  entries: FixtureEntry[],
): string => {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(
    file,
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    "utf8",
  );
  return file;
};

const baseUsage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export const userMessage = (text: string, timestamp = 1_700_000_000_000): FixtureMessage => ({
  role: "user",
  content: text,
  timestamp,
});

export const assistantText = (text: string, timestamp = 1_700_000_000_000): FixtureMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  provider: "anthropic",
  model: "claude-test",
  usage: baseUsage,
  stopReason: "stop",
  timestamp,
});

export const assistantToolCall = (
  toolCallId: string,
  name: string,
  args: Record<string, unknown>,
  timestamp = 1_700_000_000_000,
): FixtureMessage => ({
  role: "assistant",
  content: [{ type: "toolCall", id: toolCallId, name, arguments: args }],
  provider: "anthropic",
  model: "claude-test",
  usage: baseUsage,
  stopReason: "toolUse",
  timestamp,
});

export const toolResult = (
  toolCallId: string,
  toolName: string,
  text: string,
  isError = false,
  timestamp = 1_700_000_000_000,
): FixtureMessage => ({
  role: "toolResult",
  toolCallId,
  toolName,
  content: [{ type: "text", text }],
  isError,
  timestamp,
});

export const bashExecution = (
  command: string,
  output: string,
  exitCode: number | undefined = 0,
  timestamp = 1_700_000_000_000,
): FixtureMessage => ({
  role: "bashExecution",
  command,
  output,
  exitCode,
  cancelled: false,
  truncated: false,
  timestamp,
});
