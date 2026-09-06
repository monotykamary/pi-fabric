const PREVIEW_ARG_CHARS = 2_000;
const WRITE_PREVIEW_CONTENT_CHARS = 16_000;
const PREVIEW_ARG_KEYS = 32;
const PREVIEW_RESULT_CHARS = 16_000;
const PREVIEW_NESTED_CHARS = 16_000;
export const MAX_AUDIT_VALUE_CHARS = 64_000;

export const truncateString = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max)}…`;

export const boundedPreviewValue = (value: unknown, maxChars: number): unknown => {
  if (value === undefined || value === null || typeof value !== "object") return value;
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length <= maxChars) return JSON.parse(serialized) as unknown;
    return {
      fabricTruncated: true,
      originalChars: serialized.length,
      preview: serialized.slice(0, Math.max(1, maxChars - 100)),
    };
  } catch {
    return truncateString(String(value), maxChars);
  }
};

export const previewArgs = (ref: string, args: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const [key, value] of Object.entries(args)) {
    if (count++ >= PREVIEW_ARG_KEYS) break;
    const maxChars =
      ref === "pi.write" && key === "content"
        ? WRITE_PREVIEW_CONTENT_CHARS
        : PREVIEW_ARG_CHARS;
    out[key] =
      typeof value === "string"
        ? truncateString(value, maxChars)
        : boundedPreviewValue(value, PREVIEW_NESTED_CHARS);
  }
  return out;
};

export const previewResult = (value: unknown): unknown => {
  if (typeof value === "string") return truncateString(value, PREVIEW_RESULT_CHARS);
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (count++ >= PREVIEW_ARG_KEYS) break;
      out[key] =
        typeof val === "string"
          ? truncateString(val, PREVIEW_RESULT_CHARS)
          : boundedPreviewValue(val, PREVIEW_NESTED_CHARS);
    }
    return out;
  }
  return boundedPreviewValue(value, PREVIEW_RESULT_CHARS);
};

export const failedResultError = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const status = record.status;
  if (status !== "failed" && status !== "stopped" && status !== "timed_out") return undefined;
  const error = typeof record.error === "string" ? record.error.trim() : "";
  return error ? truncateString(error, PREVIEW_RESULT_CHARS) : `Fabric action returned ${status}`;
};

export const failedResultOutcome = (value: unknown): "failed" | "aborted" | "timed_out" => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "failed";
  const status = (value as Record<string, unknown>).status;
  return status === "timed_out" ? "timed_out" : status === "stopped" ? "aborted" : "failed";
};

export const boundedResult = (
  value: unknown,
  maxChars: number,
): { value: unknown; chars: number; truncated: boolean } => {
  let serialized: string;
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined && value !== undefined) {
      throw new Error(`unsupported result type: ${typeof value}`);
    }
    serialized = encoded ?? "null";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Fabric action returned a non-JSON-serializable value: ${message}`);
  }
  if (serialized.length <= maxChars) {
    return { value, chars: serialized.length, truncated: false };
  }
  const previewChars = Math.max(1, maxChars - 200);
  return {
    value: {
      fabricTruncated: true,
      originalChars: serialized.length,
      preview: serialized.slice(0, previewChars),
    },
    chars: serialized.length,
    truncated: true,
  };
};

