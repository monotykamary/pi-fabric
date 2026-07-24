import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  CURRENT_SESSION_VERSION,
  SessionManager,
  type SessionEntry,
  type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentSessionSeed,
  AgentToolResultMessage,
} from "./types.js";

interface HandoffSessionSource {
  getBranch(): SessionEntry[];
  getEntry(id: string): SessionEntry | undefined;
  getLeafId(): string | null;
  getSessionFile(): string | undefined;
  getSessionId(): string;
}

interface CurrentModel {
  provider: string;
  id: string;
}

type NativeAssistantMessage = Extract<
  SessionMessageEntry["message"],
  { role: "assistant" }
>;
type NativeAssistantEntry = SessionMessageEntry & {
  message: NativeAssistantMessage;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isToolCall = (value: unknown): value is {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
} =>
  isRecord(value) &&
  value.type === "toolCall" &&
  typeof value.id === "string" &&
  typeof value.name === "string" &&
  isRecord(value.arguments);

const activeFabricTurn = (
  source: HandoffSessionSource,
  outerToolCallId: string,
): NativeAssistantEntry => {
  const leafId = source.getLeafId();
  const entry = leafId ? source.getEntry(leafId) : undefined;
  if (entry?.type !== "message" || entry.message.role !== "assistant") {
    throw new Error(
      "Trajectory handoff requires the active fabric_exec assistant turn to be the session leaf",
    );
  }
  const content = Array.isArray(entry.message.content) ? entry.message.content : [];
  const toolCalls = content.filter(isToolCall);
  if (!toolCalls.some((call) => call.id === outerToolCallId)) {
    throw new Error(
      "Trajectory handoff could not find the active fabric_exec assistant turn in the Pi session",
    );
  }
  if (toolCalls.length !== 1 || toolCalls[0]?.name !== "fabric_exec") {
    throw new Error(
      "Trajectory handoff requires fabric_exec to be the only top-level tool call in its assistant turn",
    );
  }
  return entry as NativeAssistantEntry;
};

export const snapshotHandoffSession = (
  source: HandoffSessionSource,
  currentModel: CurrentModel | undefined,
  outerToolResult: AgentToolResultMessage,
  outerToolCallId: string,
): AgentSessionSeed => {
  if (
    outerToolResult.toolCallId !== outerToolCallId ||
    outerToolResult.toolName !== "fabric_exec"
  ) {
    throw new Error("Trajectory handoff requires the finalized outer fabric_exec result");
  }
  const active = activeFabricTurn(source, outerToolCallId);
  const sourceSessionFile = source.getSessionFile();
  const branch = source.getBranch();
  let model = currentModel
    ? { provider: currentModel.provider, modelId: currentModel.id }
    : undefined;
  let thinkingLevel: string | undefined;
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (!thinkingLevel && entry?.type === "thinking_level_change") {
      thinkingLevel = entry.thinkingLevel;
    }
    if (!model && entry?.type === "model_change") {
      model = { provider: entry.provider, modelId: entry.modelId };
    }
    if (model && thinkingLevel) break;
  }
  return {
    sourceSessionId: source.getSessionId(),
    ...(sourceSessionFile ? { sourceSessionFile } : {}),
    sourceBranchLeafId: active.id,
    ...(!sourceSessionFile ? { sourceBranch: structuredClone(branch) } : {}),
    ...(model ? { sourceModel: model } : {}),
    ...(thinkingLevel ? { sourceThinkingLevel: thinkingLevel } : {}),
    outerToolResult: structuredClone(outerToolResult),
  };
};

const materializeBranch = (
  seed: AgentSessionSeed,
  cwd: string,
  directory: string,
): SessionManager => {
  if (!seed.sourceBranch) {
    throw new Error("In-memory trajectory handoff is missing its source branch");
  }
  const id = randomUUID();
  const sessionFile = path.join(directory, `handoff-${id}.jsonl`);
  const header = {
    type: "session" as const,
    version: CURRENT_SESSION_VERSION,
    id,
    timestamp: new Date().toISOString(),
    cwd,
    ...(seed.sourceSessionFile ? { parentSession: seed.sourceSessionFile } : {}),
  };
  fs.writeFileSync(
    sessionFile,
    `${[header, ...seed.sourceBranch].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  return SessionManager.open(sessionFile, directory, cwd);
};

const forkBranch = (
  seed: AgentSessionSeed,
  cwd: string,
  directory: string,
): SessionManager => {
  if (!seed.sourceSessionFile) return materializeBranch(seed, cwd, directory);
  const fork = SessionManager.open(seed.sourceSessionFile, directory, cwd);
  if (!fork.getEntry(seed.sourceBranchLeafId)) {
    throw new Error(
      `Trajectory handoff branch point ${seed.sourceBranchLeafId} is missing from the persisted Pi session`,
    );
  }
  const sessionFile = fork.createBranchedSession(seed.sourceBranchLeafId);
  if (!sessionFile) {
    throw new Error("Trajectory handoff could not create a persisted Pi session branch");
  }
  return fork;
};

const synchronizeSourceSettings = (
  session: SessionManager,
  seed: AgentSessionSeed,
): void => {
  const context = session.buildSessionContext();
  if (
    seed.sourceModel &&
    (context.model?.provider !== seed.sourceModel.provider ||
      context.model.modelId !== seed.sourceModel.modelId)
  ) {
    session.appendModelChange(seed.sourceModel.provider, seed.sourceModel.modelId);
  }
  if (seed.sourceThinkingLevel && context.thinkingLevel !== seed.sourceThinkingLevel) {
    session.appendThinkingLevelChange(seed.sourceThinkingLevel);
  }
};

export const writeHandoffSession = (
  seed: AgentSessionSeed,
  cwd: string,
  directory: string,
): string => {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const session = forkBranch(seed, cwd, directory);
  synchronizeSourceSettings(session, seed);
  session.appendMessage(seed.outerToolResult);
  session.appendCustomEntry("pi-fabric-handoff", {
    sourceSessionId: seed.sourceSessionId,
    boundary: "fabric_exec_end",
  });
  const sessionFile = session.getSessionFile();
  if (!sessionFile) throw new Error("Trajectory handoff did not produce a Pi session file");
  fs.chmodSync(sessionFile, 0o600);
  return sessionFile;
};
