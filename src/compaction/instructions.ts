import { canonicalizeText, utf8Bytes } from "./bounds.js";

export const FABRIC_COMPACTION_REQUEST_PREFIX = "__pi_fabric_compact_request_v1__:";
export const MAX_COMPACTION_INSTRUCTIONS_CHARS = 8 * 1024;
const MAX_COMPACTION_INSTRUCTIONS_BYTES = 8 * 1024;
export const MAX_PRESERVE_ITEMS = 16;
export const MAX_PRESERVE_ITEM_CHARS = 2 * 1024;
const MAX_PRESERVE_ITEM_BYTES = 2 * 1024;
export const MAX_TYPED_COMPACTION_SOURCE_BYTES = 16 * 1024;

export interface TypedCompactionRequest {
  version: 1;
  instructions?: string;
  preserve?: string[];
}

export interface CompactionInstructionPolicy {
  mode: "none" | "plain" | "typed-v1";
  canonicalized: boolean;
  sourceBytes: number;
  truncated: boolean;
  preserveCount: number;
  omittedPreserveCount: number;
}

type CompactionInstructionErrorCode =
  | "encoded-source-too-large"
  | "malformed-json"
  | "invalid-object"
  | "unknown-field"
  | "unsupported-version"
  | "invalid-type"
  | "instructions-too-large"
  | "preserve-too-many"
  | "preserve-item-too-large";

export interface CompactionInstructionDecodeError {
  code: CompactionInstructionErrorCode;
  message: string;
  sourceBytes: number;
}

export type DecodedCompactionInstructions =
  | {
      ok: true;
      requestLines: string[];
      policy: CompactionInstructionPolicy;
    }
  | {
      ok: false;
      requestLines: [];
      error: CompactionInstructionDecodeError;
    };

const rejection = (
  code: CompactionInstructionErrorCode,
  message: string,
  sourceBytes: number,
): DecodedCompactionInstructions => ({
  ok: false,
  requestLines: [],
  error: { code, message, sourceBytes },
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const compactionRequestBoundsError = (
  request: Omit<TypedCompactionRequest, "version">,
): Omit<CompactionInstructionDecodeError, "sourceBytes"> | undefined => {
  if (request.instructions !== undefined) {
    if (request.instructions.length > MAX_COMPACTION_INSTRUCTIONS_CHARS
      || utf8Bytes(request.instructions) > MAX_COMPACTION_INSTRUCTIONS_BYTES) {
      return {
        code: "instructions-too-large",
        message: `typed compaction instructions exceed ${MAX_COMPACTION_INSTRUCTIONS_CHARS} characters or ${MAX_COMPACTION_INSTRUCTIONS_BYTES} UTF-8 bytes`,
      };
    }
  }
  if (request.preserve !== undefined) {
    if (request.preserve.length > MAX_PRESERVE_ITEMS) {
      return {
        code: "preserve-too-many",
        message: `typed compaction preserve exceeds ${MAX_PRESERVE_ITEMS} items`,
      };
    }
    for (const item of request.preserve) {
      if (item.length > MAX_PRESERVE_ITEM_CHARS || utf8Bytes(item) > MAX_PRESERVE_ITEM_BYTES) {
        return {
          code: "preserve-item-too-large",
          message: `typed compaction preserve item exceeds ${MAX_PRESERVE_ITEM_CHARS} characters or ${MAX_PRESERVE_ITEM_BYTES} UTF-8 bytes`,
        };
      }
    }
  }
  return undefined;
};

export const encodeCompactionRequest = (request: Omit<TypedCompactionRequest, "version">): string => {
  const boundsError = compactionRequestBoundsError(request);
  if (boundsError) throw new Error(boundsError.message);
  const payload: TypedCompactionRequest = {
    version: 1,
    ...(request.instructions !== undefined ? { instructions: request.instructions } : {}),
    ...(request.preserve !== undefined ? { preserve: request.preserve } : {}),
  };
  const encoded = `${FABRIC_COMPACTION_REQUEST_PREFIX}${JSON.stringify(payload)}`;
  if (utf8Bytes(encoded) > MAX_TYPED_COMPACTION_SOURCE_BYTES) {
    throw new Error(`typed compaction request exceeds ${MAX_TYPED_COMPACTION_SOURCE_BYTES} encoded UTF-8 bytes`);
  }
  return encoded;
};

const plainInstructions = (source: string): DecodedCompactionInstructions => {
  const canonical = canonicalizeText(source);
  return {
    ok: true,
    requestLines: canonical.text ? [canonical.text] : [],
    policy: {
      mode: "plain",
      canonicalized: canonical.text !== source,
      sourceBytes: canonical.sourceBytes,
      truncated: canonical.truncated,
      preserveCount: 0,
      omittedPreserveCount: 0,
    },
  };
};

export const decodeCompactionInstructions = (
  source: string | undefined,
): DecodedCompactionInstructions => {
  if (source === undefined || source === "") {
    return {
      ok: true,
      requestLines: [],
      policy: {
        mode: "none",
        canonicalized: false,
        sourceBytes: 0,
        truncated: false,
        preserveCount: 0,
        omittedPreserveCount: 0,
      },
    };
  }
  if (!source.startsWith(FABRIC_COMPACTION_REQUEST_PREFIX)) return plainInstructions(source);

  const encodedSourceBytes = utf8Bytes(source);
  if (encodedSourceBytes > MAX_TYPED_COMPACTION_SOURCE_BYTES) {
    return rejection(
      "encoded-source-too-large",
      `typed compaction request exceeds ${MAX_TYPED_COMPACTION_SOURCE_BYTES} encoded UTF-8 bytes`,
      encodedSourceBytes,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source.slice(FABRIC_COMPACTION_REQUEST_PREFIX.length));
  } catch {
    return rejection("malformed-json", "typed compaction request contains malformed JSON", encodedSourceBytes);
  }
  if (!isRecord(parsed)) {
    return rejection("invalid-object", "typed compaction request must be a JSON object", encodedSourceBytes);
  }

  const keys = Object.keys(parsed);
  const unknownField = keys.find((key) => key !== "version" && key !== "instructions" && key !== "preserve");
  if (unknownField !== undefined) {
    return rejection("unknown-field", `typed compaction request contains unknown field ${JSON.stringify(unknownField)}`, encodedSourceBytes);
  }
  if (parsed.version !== 1) {
    return rejection("unsupported-version", "typed compaction request version must be 1", encodedSourceBytes);
  }
  if (parsed.instructions !== undefined && typeof parsed.instructions !== "string") {
    return rejection("invalid-type", "typed compaction request instructions must be a string", encodedSourceBytes);
  }
  if (parsed.preserve !== undefined && !Array.isArray(parsed.preserve)) {
    return rejection("invalid-type", "typed compaction request preserve must be an array", encodedSourceBytes);
  }

  const preserve = parsed.preserve as unknown[] | undefined;
  if (preserve !== undefined && preserve.length > MAX_PRESERVE_ITEMS) {
    return rejection(
      "preserve-too-many",
      `typed compaction preserve exceeds ${MAX_PRESERVE_ITEMS} items`,
      encodedSourceBytes,
    );
  }
  if (preserve !== undefined && !preserve.every((item) => typeof item === "string")) {
    return rejection("invalid-type", "typed compaction preserve items must be strings", encodedSourceBytes);
  }

  const request: Omit<TypedCompactionRequest, "version"> = {
    ...(parsed.instructions !== undefined ? { instructions: parsed.instructions } : {}),
    ...(preserve !== undefined ? { preserve: preserve as string[] } : {}),
  };
  const boundsError = compactionRequestBoundsError(request);
  if (boundsError) return rejection(boundsError.code, boundsError.message, encodedSourceBytes);

  const requestLines: string[] = [];
  let valueSourceBytes = 0;
  let truncated = false;
  let canonicalized = false;
  if (request.instructions !== undefined) {
    const instructions = canonicalizeText(request.instructions, MAX_COMPACTION_INSTRUCTIONS_BYTES);
    valueSourceBytes += instructions.sourceBytes;
    truncated ||= instructions.truncated;
    canonicalized ||= instructions.text !== request.instructions;
    if (instructions.text) requestLines.push(instructions.text);
  }

  for (let index = 0; index < (request.preserve?.length ?? 0); index++) {
    const sourceItem = request.preserve![index]!;
    const item = canonicalizeText(sourceItem, MAX_PRESERVE_ITEM_BYTES);
    valueSourceBytes += item.sourceBytes;
    truncated ||= item.truncated;
    canonicalized ||= item.text !== sourceItem;
    if (item.text) requestLines.push(`- ${item.text} [preserve:${index}]`);
  }

  return {
    ok: true,
    requestLines,
    policy: {
      mode: "typed-v1",
      canonicalized,
      sourceBytes: valueSourceBytes,
      truncated,
      preserveCount: request.preserve?.length ?? 0,
      omittedPreserveCount: 0,
    },
  };
};
