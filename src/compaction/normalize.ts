import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { FabricExecutionOutcomeV1, FabricTraceJsonValue } from "../audit/trace.js";
import { readFabricProjectionTrace, type FabricProjectionSource } from "./trace-events.js";
import { readFabricBranchSummaryDetailsV1 } from "./branch-details.js";
import { clipUtf8, utf8Bytes } from "./bounds.js";

// A purely structural, typed view of one session window. Every event carries
// the 1-based `index` it occupied in the normalized stream (stable, used by the
// brief-transcript `(#N)` references), a stable fact `entryId`, and the actual
// `sourceEntryId` that carried it. Normalization extracts ONLY
// typed structure — roles, tool names, JSON arguments, isError flags, bash
// commands and exit codes. It never inspects prose. See docs/compaction.md
// principle 2.

interface EventBase {
  index: number;
  entryId: string;
  sourceEntryId: string;
}

interface UserEvent extends EventBase {
  kind: "user";
  text: string;
}

interface AssistantTextEvent extends EventBase {
  kind: "assistantText";
  text: string;
}

interface ThinkingEvent extends EventBase {
  kind: "thinking";
  text: string;
}

interface CustomMessageEvent extends EventBase {
  kind: "customMessage";
  customType: string;
  text: string;
  display: boolean;
  details?: FabricTraceJsonValue;
}

export interface ToolCallEvent extends EventBase {
  kind: "toolCall";
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
}

interface ToolResultEvent extends EventBase {
  kind: "toolResult";
  toolCallId: string;
  toolName: string;
  isError: boolean;
  text: string;
}

interface BashEvent extends EventBase {
  kind: "bash";
  toolCallId: string;
  command: string;
  isError: boolean;
  exitCode: number | null;
  error?: string;
}

interface FabricPhaseEvent extends EventBase {
  kind: "fabricPhase";
  subordinal: string;
  address: string;
  phase: string;
}

interface FabricOperationEvent extends EventBase {
  kind: "fabricOperation";
  subordinal: string;
  address: string;
  ref: string;
  provider?: string;
  action?: string;
  tool: string;
  args: Record<string, FabricTraceJsonValue>;
  outcome: FabricExecutionOutcomeV1;
  error?: string;
  result?: FabricTraceJsonValue;
  source: FabricProjectionSource | "branch";
}

export type CompactionEvent =
  | UserEvent
  | AssistantTextEvent
  | ThinkingEvent
  | CustomMessageEvent
  | ToolCallEvent
  | ToolResultEvent
  | BashEvent
  | FabricPhaseEvent
  | FabricOperationEvent;

const isMessageEntry = (entry: SessionEntry): entry is Extract<SessionEntry, { type: "message" }> =>
  entry.type === "message";

const MAX_CUSTOM_DETAILS_DEPTH = 12;
const MAX_CUSTOM_DETAILS_NODES = 256;
const MAX_CUSTOM_DETAILS_COLLECTION = 64;
const MAX_CUSTOM_DETAILS_STRING_BYTES = 1024;
const MAX_CUSTOM_DETAILS_BYTES = 8 * 1024;

interface JsonSanitizerState {
  nodes: number;
  ancestors: Set<object>;
}

const boundedJsonValue = (
  value: unknown,
  state: JsonSanitizerState,
  depth = 0,
): FabricTraceJsonValue | undefined => {
  state.nodes += 1;
  if (state.nodes > MAX_CUSTOM_DETAILS_NODES) return undefined;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return clipUtf8(value, MAX_CUSTOM_DETAILS_STRING_BYTES);
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "object" || depth > MAX_CUSTOM_DETAILS_DEPTH || state.ancestors.has(value)) return undefined;
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const output: FabricTraceJsonValue[] = [];
      for (const item of value.slice(0, MAX_CUSTOM_DETAILS_COLLECTION)) {
        const sanitized = boundedJsonValue(item, state, depth + 1);
        if (sanitized === undefined) return undefined;
        output.push(sanitized);
      }
      return output;
    }
    const output = Object.create(null) as Record<string, FabricTraceJsonValue>;
    const keys = Object.keys(value).sort().slice(0, MAX_CUSTOM_DETAILS_COLLECTION);
    for (const key of keys) {
      const sanitized = boundedJsonValue((value as Record<string, unknown>)[key], state, depth + 1);
      if (sanitized === undefined) return undefined;
      output[key] = sanitized;
    }
    return output;
  } finally {
    state.ancestors.delete(value);
  }
};

const customDetails = (value: unknown): FabricTraceJsonValue | undefined => {
  if (value === undefined) return undefined;
  try {
    const sanitized = boundedJsonValue(value, { nodes: 0, ancestors: new Set<object>() });
    if (sanitized === undefined || utf8Bytes(JSON.stringify(sanitized)) > MAX_CUSTOM_DETAILS_BYTES) return undefined;
    return sanitized;
  } catch {
    return undefined;
  }
};

const isTypedCustomContent = (content: unknown): boolean => {
  if (typeof content === "string") return true;
  if (!Array.isArray(content)) return false;
  return content.every((part) => {
    if (part === null || typeof part !== "object") return false;
    const candidate = part as { type?: unknown; text?: unknown };
    if (candidate.type === "text") return typeof candidate.text === "string";
    return candidate.type === "image";
  });
};

export const isPiCustomMessageEntry = (
  entry: SessionEntry,
): entry is Extract<SessionEntry, { type: "custom_message" }> => {
  try {
    if (entry.type !== "custom_message") return false;
    const candidate = entry as SessionEntry & {
      customType?: unknown;
      content?: unknown;
      display?: unknown;
    };
    return typeof candidate.customType === "string"
      && typeof candidate.display === "boolean"
      && isTypedCustomContent(candidate.content);
  } catch {
    return false;
  }
};

const textOfContent = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (part && typeof part === "object" && "type" in part) {
      if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
    }
  }
  return parts.join("\n");
};

const firstLine = (text: string): string => {
  const trimmed = text.trimStart();
  const nl = trimmed.indexOf("\n");
  return nl < 0 ? trimmed : trimmed.slice(0, nl);
};

interface PendingCall {
  name: string;
  args: Record<string, unknown>;
}

type DistributiveOmit<T, K extends keyof any> = T extends T ? Omit<T, K> : never;

// Normalize a SessionEntry source prefix into a flat, typed event stream.
// The caller selects the cumulative raw active-branch prefix before the new
// kept boundary. Tool results are paired back to their tool calls by
// id so a bash result can carry the command from the originating call; this
// pairing is structural (id match), never prose-based.
export const normalizeEntries = (entries: SessionEntry[]): CompactionEvent[] => {
  const events: CompactionEvent[] = [];
  const calls = new Map<string, PendingCall>();
  let index = 0;

  const push = (event: DistributiveOmit<CompactionEvent, "index">): void => {
    index += 1;
    events.push({ ...event, index } as CompactionEvent);
  };

  const pushBranchFacts = (entry: SessionEntry & { details?: unknown }): void => {
    const details = readFabricBranchSummaryDetailsV1(entry.details);
    if (!details) return;
    for (const fact of details.facts) {
      if (fact.kind === "user") {
        push({ kind: "user", entryId: fact.entryId, sourceEntryId: entry.id, text: fact.text });
      } else if (fact.kind === "customMessage") {
        push({
          kind: "customMessage",
          entryId: fact.entryId,
          sourceEntryId: entry.id,
          customType: fact.customType,
          text: fact.text,
          display: fact.display,
          ...(fact.details !== undefined ? { details: fact.details } : {}),
        });
      } else if (fact.kind === "phase") {
        push({
          kind: "fabricPhase",
          entryId: fact.entryId,
          sourceEntryId: entry.id,
          subordinal: fact.subordinal,
          address: fact.address,
          phase: fact.phase,
        });
      } else {
        push({
          kind: "fabricOperation",
          entryId: fact.entryId,
          sourceEntryId: entry.id,
          subordinal: fact.subordinal,
          address: fact.address,
          ref: fact.ref,
          ...(fact.provider ? { provider: fact.provider } : {}),
          ...(fact.action ? { action: fact.action } : {}),
          tool: fact.tool,
          args: fact.args,
          outcome: fact.outcome,
          ...(fact.error !== undefined ? { error: fact.error } : {}),
          ...(fact.result !== undefined ? { result: fact.result } : {}),
          source: "branch",
        });
      }
    }
  };

  for (const entry of entries) {
    if (entry.type === "branch_summary") {
      pushBranchFacts(entry as SessionEntry & { details?: unknown });
      continue;
    }
    if (entry.type === "custom_message") {
      try {
        if (!isPiCustomMessageEntry(entry)) continue;
        const details = customDetails(entry.details);
        push({
          kind: "customMessage",
          entryId: entry.id,
          sourceEntryId: entry.id,
          customType: entry.customType,
          text: textOfContent(entry.content),
          display: entry.display,
          ...(details !== undefined ? { details } : {}),
        });
      } catch {
        // Malformed extension-owned entries are ignored without affecting later source.
      }
      continue;
    }
    if (!isMessageEntry(entry)) continue;
    const message = entry.message as SessionMessageEntry["message"];
    if (!message || typeof message !== "object") continue;
    const role = (message as { role?: unknown }).role;
    const entryId = entry.id;

    if (role === "user") {
      push({ kind: "user", entryId, sourceEntryId: entryId, text: textOfContent((message as { content: unknown }).content) });
      continue;
    }

    if (role === "assistant") {
      const content = (message as { content: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (!part || typeof part !== "object" || !("type" in part)) continue;
        if (part.type === "text" && typeof part.text === "string") {
          push({ kind: "assistantText", entryId, sourceEntryId: entryId, text: part.text });
        } else if (part.type === "thinking" && typeof part.thinking === "string") {
          push({ kind: "thinking", entryId, sourceEntryId: entryId, text: part.thinking });
        } else if (part.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string") {
          const args = (part.arguments ?? {}) as Record<string, unknown>;
          calls.set(part.id, { name: part.name, args });
          push({ kind: "toolCall", entryId, sourceEntryId: entryId, toolCallId: part.id, name: part.name, args });
        }
      }
      continue;
    }

    if (role === "toolResult") {
      const toolResult = message as {
        toolCallId?: string;
        toolName?: string;
        isError?: boolean;
        content?: unknown;
        details?: unknown;
      };
      const toolCallId = typeof toolResult.toolCallId === "string" ? toolResult.toolCallId : "";
      const toolName = typeof toolResult.toolName === "string" ? toolResult.toolName : "";
      const isError = toolResult.isError === true;
      const text = textOfContent(toolResult.content);
      if (toolName === "bash") {
        const pending = toolCallId ? calls.get(toolCallId) : undefined;
        const command =
          pending && typeof pending.args.command === "string"
            ? pending.args.command
            : "";
        push({
          kind: "bash",
          entryId,
          sourceEntryId: entryId,
          toolCallId,
          command,
          isError,
          exitCode: null,
          ...(isError && text ? { error: text } : {}),
        });
      } else {
        push({ kind: "toolResult", entryId, sourceEntryId: entryId, toolCallId, toolName, isError, text });
      }
      if (toolName === "fabric_exec") {
        const nested = readFabricProjectionTrace(toolResult.details);
        if (nested) {
          for (let phaseIndex = 0; phaseIndex < nested.phases.length; phaseIndex++) {
            const subordinal = `phase:${phaseIndex}`;
            push({
              kind: "fabricPhase",
              entryId,
              sourceEntryId: entryId,
              subordinal,
              address: `${entryId}/${subordinal}`,
              phase: nested.phases[phaseIndex]!,
            });
          }
          for (const operation of nested.operations) {
            const subordinal = String(operation.sequence);
            push({
              kind: "fabricOperation",
              entryId,
              sourceEntryId: entryId,
              subordinal,
              address: `${entryId}/${subordinal}`,
              ref: operation.ref,
              ...(operation.provider ? { provider: operation.provider } : {}),
              ...(operation.action ? { action: operation.action } : {}),
              tool: operation.tool,
              args: operation.args,
              outcome: operation.outcome,
              ...(operation.error !== undefined ? { error: operation.error } : {}),
              ...(operation.result !== undefined ? { result: operation.result } : {}),
              source: operation.source,
            });
          }
        }
      }
      continue;
    }

    if (role === "bashExecution") {
      const bash = message as {
        command?: string;
        exitCode?: number | undefined;
        output?: string;
      };
      const exitCode = typeof bash.exitCode === "number" ? bash.exitCode : null;
      const isError = exitCode !== null && exitCode !== 0;
      push({
        kind: "bash",
        entryId,
        sourceEntryId: entryId,
        toolCallId: "",
        command: typeof bash.command === "string" ? bash.command : "",
        isError,
        exitCode,
        ...(isError && typeof bash.output === "string" && bash.output ? { error: bash.output } : {}),
      });
      continue;
    }

    // Message-role custom / branchSummary / compactionSummary and any other
    // roles are not top-level Pi custom_message entries and are skipped here.
  }

  return events;
};

export { firstLine };
