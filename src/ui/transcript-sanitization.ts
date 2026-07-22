const MAX_TOOL_SUMMARY_CHARS = 500;
const MAX_ENCODED_STRING_CHARS = 160;
const MAX_TRANSCRIPT_VALUE_CHARS = 40_000;
const MAX_TRANSCRIPT_STRING_CHARS = 12_000;
const MAX_TRANSCRIPT_VALUE_NODES = 400;
const secretKey = /authorization|api[-_]?key|token|password|secret|cookie|credential|private[-_]?key/i;

interface RedactionBudget {
  chars: number;
  nodes: number;
}

export const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export const terminalSafe = (value: string, trim = true): string => {
  const safe = value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u202a-\u202e\u2066-\u2069\u200e\u200f]/gi, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, " ")
    .replace(/\r\n?/g, "\n");
  return trim ? safe.trim() : safe;
};

const graphemeSegmenter = Intl.Segmenter
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : undefined;

const graphemes = (value: string): string[] =>
  graphemeSegmenter
    ? [...graphemeSegmenter.segment(value)].map((entry) => entry.segment)
    : Array.from(value);

export const clip = (value: string, max: number, trim = true): string => {
  const normalized = terminalSafe(value, trim);
  if (normalized.length <= max) return normalized;
  const parts = graphemes(normalized);
  if (parts.length <= max) return normalized;
  const tail = Math.min(1_000, Math.floor(max * 0.25));
  return `${parts.slice(0, max - tail - 2).join("")}…\n${parts.slice(-tail).join("")}`;
};

export const contentText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        const record = recordOf(part);
        return record?.type === "text" && typeof record.text === "string" ? record.text : "";
      })
      .filter(Boolean)
      .join("");
  }
  const record = recordOf(value);
  if (!record) return "";
  if (typeof record.text === "string") return record.text;
  if (record.content !== undefined) return contentText(record.content);
  return "";
};

export const messageError = (message: Record<string, unknown>): string => {
  if (message.role !== "assistant" || message.stopReason !== "error") return "";
  const details: string[] = [];
  if (typeof message.errorMessage === "string") details.push(message.errorMessage);
  else if (typeof message.error === "string") details.push(message.error);
  if (Array.isArray(message.diagnostics)) {
    for (const value of message.diagnostics) {
      const diagnostic = recordOf(value);
      const nested = recordOf(diagnostic?.error);
      const detail =
        typeof nested?.message === "string"
          ? nested.message
          : typeof diagnostic?.message === "string"
            ? diagnostic.message
            : undefined;
      if (detail) details.push(detail);
    }
  }
  return clip([...new Set(details)].join(" · ") || "Agent response failed", MAX_TOOL_SUMMARY_CHARS);
};

const redactInlineSecrets = (value: string): string =>
  value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/\bBasic\s+[A-Za-z0-9+/=]{8,}/gi, "Basic [redacted]")
    .replace(/\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/g, "[redacted]")
    .replace(
      /\b(Authorization|Proxy-Authorization|Cookie|Set-Cookie|X-Api-Key)\s*:\s*[^\r\n;]+/gi,
      "$1: [redacted]",
    )
    .replace(
      /\b([A-Z0-9_]*(?:PASSWORD|PASSWD|TOKEN|SECRET|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|COOKIE)[A-Z0-9_]*)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s;&|]+)/gi,
      "$1=[redacted]",
    )
    .replace(
      /(--?(?:password|passwd|token|secret|api[-_]?key|access[-_]?key|credential|cookie))(?:=|\s+)(?:"[^"]*"|'[^']*'|[^\s;&|]+)/gi,
      "$1=[redacted]",
    )
    .replace(/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1[redacted]@");

export const redact = (
  value: unknown,
  key = "",
  depth = 0,
  budget: RedactionBudget = {
    chars: MAX_TRANSCRIPT_VALUE_CHARS,
    nodes: MAX_TRANSCRIPT_VALUE_NODES,
  },
): unknown => {
  if (secretKey.test(key)) return "[redacted]";
  if (depth > 12) return "[nested value]";
  if (budget.nodes <= 0) return "[value omitted]";
  budget.nodes--;
  if (typeof value === "string") {
    const safe = terminalSafe(value, false);
    if (safe.length >= MAX_ENCODED_STRING_CHARS && /^[A-Za-z0-9+/=_-]+$/.test(safe)) {
      return `[large encoded value · ${safe.length} chars]`;
    }
    const available = Math.max(0, Math.min(MAX_TRANSCRIPT_STRING_CHARS, budget.chars));
    if (available === 0) return "[text omitted]";
    const hidden = redactInlineSecrets(clip(safe, available, false));
    budget.chars = Math.max(0, budget.chars - hidden.length);
    return hidden;
  }
  if (Array.isArray(value)) {
    const entries: unknown[] = [];
    for (const entry of value) {
      if (budget.nodes <= 0) {
        entries.push(`[${value.length - entries.length} entries omitted]`);
        break;
      }
      entries.push(redact(entry, key, depth + 1, budget));
    }
    return entries;
  }
  const record = recordOf(value);
  if (!record) return value;
  const entries = Object.entries(record);
  const redacted: Record<string, unknown> = {};
  for (let index = 0; index < entries.length; index++) {
    if (budget.nodes <= 0) {
      redacted["…"] = `[${entries.length - index} fields omitted]`;
      break;
    }
    const [name, entry] = entries[index]!;
    redacted[name] = redact(entry, name, depth + 1, budget);
  }
  return redacted;
};

export const redactRecord = (value: unknown): Record<string, unknown> | undefined => {
  const record = recordOf(value);
  if (!record) return undefined;
  return recordOf(redact(record));
};

export const compactRedactedValue = (value: unknown): string => {
  try {
    return clip(JSON.stringify(value).replace(/\s+/g, " "), MAX_TOOL_SUMMARY_CHARS);
  } catch {
    return clip(String(value ?? "").replace(/\s+/g, " "), MAX_TOOL_SUMMARY_CHARS);
  }
};
