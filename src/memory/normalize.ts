import fs from "node:fs";

/**
 * A typed, structure-derived projection of one session JSONL line.
 *
 * Text is truncated to `maxEntryChars` for index storage; the full untruncated
 * text remains addressable via {@link expandSession} / `memory.expand`, which
 * re-reads the source line on demand. The `index` is the dense position of the
 * entry among normalized entries within its session (0-based), so it stays
 * stable across re-parse and can address the same line on expand.
 */
export interface NormalizedEntry {
  sessionFile: string;
  sessionId: string;
  index: number;
  entryId: string | null;
  parentId: string | null;
  type: string;
  role: string | null;
  toolName: string | null;
  text: string;
  timestamp: number | null;
  isError: boolean;
  truncated: boolean;
  filesTouched?: string[];
}

export interface SessionHeaderInfo {
  sessionId: string;
  cwd: string;
  parentSession?: string;
}

const truncate = (text: string, max: number): { text: string; truncated: boolean } =>
  text.length <= max ? { text, truncated: false } : { text: text.slice(0, max), truncated: true };

const asString = (value: unknown): string =>
  typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);

const joinTextParts = (parts: unknown[]): string => {
  const out: string[] = [];
  for (const part of parts) {
    if (part === null || typeof part !== "object") continue;
    const record = part as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      out.push(record.text);
    }
  }
  return out.join("\n");
};

const summarizeArgs = (args: unknown, max = 400): string => {
  let serialized: string;
  try {
    serialized = JSON.stringify(args) ?? "";
  } catch {
    serialized = String(args);
  }
  if (serialized.length <= max) return serialized;
  return `${serialized.slice(0, max)}…`;
};

const collectPathArguments = (value: unknown, key: string | null, paths: string[]): void => {
  if (typeof value === "string") {
    if (key !== null && /(?:file|path)s?$/i.test(key) && value.trim()) paths.push(value.trim());
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPathArguments(item, key, paths);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    collectPathArguments(childValue, childKey, paths);
  }
};

const extractFilesTouched = (raw: Record<string, unknown>): string[] => {
  if (asString(raw.type) !== "message") return [];
  const message = raw.message as Record<string, unknown> | undefined;
  if (!message || asString(message.role) !== "assistant" || !Array.isArray(message.content)) return [];
  const paths: string[] = [];
  for (const block of message.content) {
    if (block === null || typeof block !== "object") continue;
    const record = block as Record<string, unknown>;
    if (record.type === "toolCall") collectPathArguments(record.arguments, null, paths);
  }
  return [...new Set(paths)];
};

/**
 * Extract searchable text from a parsed JSONL entry, structurally — from the
 * typed message content arrays, tool-call name + args, tool-result content,
 * and bashExecution command + output. No regex over prose lives here.
 */
export const extractFullText = (raw: Record<string, unknown>): string => {
  const type = asString(raw.type);
  if (type === "message") {
    const message = raw.message as Record<string, unknown> | undefined;
    if (!message || typeof message !== "object") return "";
    const role = asString(message.role);
    const content = message.content;
    if (role === "user") {
      if (typeof content === "string") return content;
      if (Array.isArray(content)) return joinTextParts(content);
      return "";
    }
    if (role === "assistant") {
      const parts: string[] = [];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block === null || typeof block !== "object") continue;
          const record = block as Record<string, unknown>;
          if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
          else if (record.type === "thinking" && typeof record.thinking === "string") {
            parts.push(record.thinking);
          } else if (record.type === "toolCall") {
            const name = asString(record.name);
            parts.push(`Tool: ${name}(${summarizeArgs(record.arguments)})`);
          }
        }
      }
      const errorMessage = asString(message.errorMessage);
      if (errorMessage) parts.push(`Error: ${errorMessage}`);
      return parts.join("\n");
    }
    if (role === "toolResult") {
      const toolName = asString(message.toolName);
      let body = "";
      if (Array.isArray(message.content)) body = joinTextParts(message.content);
      else if (typeof message.content === "string") body = message.content;
      const prefix = toolName ? `toolResult(${toolName})` : "toolResult";
      return body ? `${prefix}: ${body}` : prefix;
    }
    if (role === "bashExecution") {
      const command = asString(message.command);
      const output = asString(message.output);
      const exit = message.exitCode;
      const exitSuffix = typeof exit === "number" ? ` [exit ${exit}]` : "";
      return `bash$ ${command}${exitSuffix}\n${output}`;
    }
    if (role === "custom") {
      const customType = asString(message.customType);
      let body = "";
      if (typeof message.content === "string") body = message.content;
      else if (Array.isArray(message.content)) body = joinTextParts(message.content);
      return customType ? `[${customType}] ${body}` : body;
    }
    if (role === "compactionSummary") return `compaction: ${asString(message.summary)}`;
    if (role === "branchSummary") return `branchSummary: ${asString(message.summary)}`;
    return "";
  }
  if (type === "compaction") return `compaction: ${asString(raw.summary)}`;
  if (type === "branch_summary") return `branchSummary: ${asString(raw.summary)}`;
  if (type === "custom_message") {
    let body = "";
    if (typeof raw.content === "string") body = raw.content;
    else if (Array.isArray(raw.content)) body = joinTextParts(raw.content);
    const customType = asString(raw.customType);
    return customType ? `[${customType}] ${body}` : body;
  }
  return "";
};

const entryRoleAndTool = (
  raw: Record<string, unknown>,
): { role: string | null; toolName: string | null; isError: boolean } => {
  const type = asString(raw.type);
  if (type === "message") {
    const message = raw.message as Record<string, unknown> | undefined;
    if (!message || typeof message !== "object") return { role: null, toolName: null, isError: false };
    const role = asString(message.role) || null;
    let toolName: string | null = null;
    if (role === "toolResult") toolName = asString(message.toolName) || null;
    else if (role === "bashExecution") toolName = "bash";
    else if (role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block === null || typeof block !== "object") continue;
        const record = block as Record<string, unknown>;
        if (record.type === "toolCall" && typeof record.name === "string") {
          toolName = record.name;
          break;
        }
      }
    }
    const isError = Boolean(message.isError);
    return { role, toolName, isError };
  }
  if (type === "compaction") return { role: "compaction", toolName: null, isError: false };
  if (type === "branch_summary") return { role: "branchSummary", toolName: null, isError: false };
  if (type === "custom_message") return { role: "custom", toolName: null, isError: false };
  return { role: null, toolName: null, isError: false };
};

const parseTimestamp = (raw: unknown): number | null => {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    const entryTimestamp = parseTimestamp(record.timestamp);
    if (entryTimestamp !== null) return entryTimestamp;
    const message = record.message as Record<string, unknown> | undefined;
    if (message) return parseTimestamp(message.timestamp);
  }
  return null;
};

/**
 * Parse a session JSONL file into typed {@link NormalizedEntry} records.
 *
 * Only entries that carry searchable text are emitted (message, compaction,
 * branch_summary, custom_message); structural-only entries (model_change,
 * thinking_level_change, label, custom, session_info) are skipped, so `index`
 * counts only content-bearing lines. The session header (line 0) is returned
 * separately via {@link readSessionHeader} when needed.
 */
export const normalizeSession = (
  sessionFile: string,
  maxEntryChars: number,
): { entries: NormalizedEntry[]; header: SessionHeaderInfo | null } => {
  let content: string;
  try {
    content = fs.readFileSync(sessionFile, "utf8");
  } catch {
    return { entries: [], header: null };
  }
  const lines = content.split("\n");
  let header: SessionHeaderInfo | null = null;
  const entries: NormalizedEntry[] = [];
  let index = 0;
  let sessionId = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (asString(raw.type) === "session") {
      sessionId = asString(raw.id);
      header = {
        sessionId,
        cwd: asString(raw.cwd),
        ...(typeof raw.parentSession === "string" ? { parentSession: raw.parentSession } : {}),
      };
      continue;
    }
    const type = asString(raw.type);
    if (
      type !== "message" &&
      type !== "compaction" &&
      type !== "branch_summary" &&
      type !== "custom_message"
    ) {
      continue;
    }
    const { role, toolName, isError } = entryRoleAndTool(raw);
    const filesTouched = extractFilesTouched(raw);
    const fullText = extractFullText(raw);
    const { text, truncated } = truncate(fullText, maxEntryChars);
    if (!text.trim() && role === null) continue;
    const entryId = typeof raw.id === "string" ? raw.id : null;
    const parentId = typeof raw.parentId === "string" ? raw.parentId : null;
    entries.push({
      sessionFile,
      sessionId: sessionId || "",
      index,
      entryId,
      parentId,
      type,
      role,
      toolName,
      text,
      timestamp: parseTimestamp(raw),
      isError,
      truncated,
      ...(filesTouched.length > 0 ? { filesTouched } : {}),
    });
    index += 1;
  }
  return { entries, header };
};

/** Read only the session header (first JSONL line). */
export const readSessionHeader = (sessionFile: string): SessionHeaderInfo | null => {
  try {
    const fd = fs.openSync(sessionFile, "r");
    const buffer = Buffer.alloc(8_192);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);
    const slice = buffer.subarray(0, bytesRead).toString("utf8");
    const newline = slice.indexOf("\n");
    const firstLine = (newline === -1 ? slice : slice.slice(0, newline)).trim();
    if (!firstLine) return null;
    const raw = JSON.parse(firstLine) as Record<string, unknown>;
    if (asString(raw.type) !== "session") return null;
    return {
      sessionId: asString(raw.id),
      cwd: asString(raw.cwd),
      ...(typeof raw.parentSession === "string" ? { parentSession: raw.parentSession } : {}),
    };
  } catch {
    return null;
  }
};

/** Re-read a single session line and return its full, untruncated text. */
export const expandSessionEntry = (
  sessionFile: string,
  index: number,
): string | null => {
  let content: string;
  try {
    content = fs.readFileSync(sessionFile, "utf8");
  } catch {
    return null;
  }
  let cursor = 0;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (asString(raw.type) === "session") continue;
    const type = asString(raw.type);
    if (
      type !== "message" &&
      type !== "compaction" &&
      type !== "branch_summary" &&
      type !== "custom_message"
    ) {
      continue;
    }
    const { role } = entryRoleAndTool(raw);
    const fullText = extractFullText(raw);
    if (!fullText.trim() && role === null) continue;
    if (cursor === index) return fullText;
    cursor += 1;
  }
  return null;
};
