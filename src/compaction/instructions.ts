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
  | "duplicate-field"
  | "invalid-unicode"
  | "structure-too-complex"
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

const hasPairedSurrogates = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
};

export const compactionRequestBoundsError = (
  request: Omit<TypedCompactionRequest, "version">,
): Omit<CompactionInstructionDecodeError, "sourceBytes"> | undefined => {
  if (request.instructions !== undefined) {
    if (!hasPairedSurrogates(request.instructions)) {
      return {
        code: "invalid-unicode",
        message: "typed compaction instructions contain an unpaired UTF-16 surrogate",
      };
    }
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
      if (!hasPairedSurrogates(item)) {
        return {
          code: "invalid-unicode",
          message: "typed compaction preserve item contains an unpaired UTF-16 surrogate",
        };
      }
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

class StrictJsonError extends Error {
  constructor(
    readonly code: "malformed-json" | "duplicate-field" | "invalid-unicode" | "structure-too-complex",
    message: string,
  ) {
    super(message);
  }
}

const MAX_TYPED_JSON_DEPTH = 32;
const MAX_TYPED_JSON_NODES = 4096;

class StrictJsonParser {
  private index = 0;
  private nodes = 0;

  constructor(private readonly source: string) {}

  parse(): unknown {
    this.skipWhitespace();
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.index !== this.source.length) this.malformed();
    return value;
  }

  private parseValue(depth: number): unknown {
    if (depth > MAX_TYPED_JSON_DEPTH) {
      throw new StrictJsonError("structure-too-complex", "typed compaction JSON exceeds the structural depth limit");
    }
    this.nodes += 1;
    if (this.nodes > MAX_TYPED_JSON_NODES) {
      throw new StrictJsonError("structure-too-complex", "typed compaction JSON exceeds the structural node limit");
    }
    const character = this.source[this.index];
    if (character === "{") return this.parseObject(depth + 1);
    if (character === "[") return this.parseArray(depth + 1);
    if (character === "\"") return this.parseString();
    if (character === "t") return this.parseLiteral("true", true);
    if (character === "f") return this.parseLiteral("false", false);
    if (character === "n") return this.parseLiteral("null", null);
    if (character === "-" || (character !== undefined && character >= "0" && character <= "9")) {
      return this.parseNumber();
    }
    return this.malformed();
  }

  private parseObject(depth: number): Record<string, unknown> {
    this.index += 1;
    this.skipWhitespace();
    const output = Object.create(null) as Record<string, unknown>;
    const keys = new Set<string>();
    if (this.source[this.index] === "}") {
      this.index += 1;
      return output;
    }
    while (this.index < this.source.length) {
      if (this.source[this.index] !== "\"") this.malformed();
      const key = this.parseString();
      if (keys.has(key)) {
        throw new StrictJsonError("duplicate-field", `typed compaction request contains duplicate field ${JSON.stringify(key)}`);
      }
      keys.add(key);
      this.skipWhitespace();
      if (this.source[this.index] !== ":") this.malformed();
      this.index += 1;
      this.skipWhitespace();
      output[key] = this.parseValue(depth);
      this.skipWhitespace();
      const delimiter = this.source[this.index];
      if (delimiter === "}") {
        this.index += 1;
        return output;
      }
      if (delimiter !== ",") this.malformed();
      this.index += 1;
      this.skipWhitespace();
    }
    return this.malformed();
  }

  private parseArray(depth: number): unknown[] {
    this.index += 1;
    this.skipWhitespace();
    const output: unknown[] = [];
    if (this.source[this.index] === "]") {
      this.index += 1;
      return output;
    }
    while (this.index < this.source.length) {
      output.push(this.parseValue(depth));
      this.skipWhitespace();
      const delimiter = this.source[this.index];
      if (delimiter === "]") {
        this.index += 1;
        return output;
      }
      if (delimiter !== ",") this.malformed();
      this.index += 1;
      this.skipWhitespace();
    }
    return this.malformed();
  }

  private parseString(): string {
    this.index += 1;
    let output = "";
    while (this.index < this.source.length) {
      const unit = this.source.charCodeAt(this.index);
      if (unit === 0x22) {
        this.index += 1;
        if (!hasPairedSurrogates(output)) {
          throw new StrictJsonError("invalid-unicode", "typed compaction JSON string contains an unpaired UTF-16 surrogate");
        }
        return output;
      }
      if (unit <= 0x1f) this.malformed();
      if (unit !== 0x5c) {
        output += this.source[this.index]!;
        this.index += 1;
        continue;
      }
      this.index += 1;
      const escape = this.source[this.index];
      this.index += 1;
      if (escape === "\"" || escape === "\\" || escape === "/") output += escape;
      else if (escape === "b") output += "\b";
      else if (escape === "f") output += "\f";
      else if (escape === "n") output += "\n";
      else if (escape === "r") output += "\r";
      else if (escape === "t") output += "\t";
      else if (escape === "u") {
        let value = 0;
        for (let offset = 0; offset < 4; offset++) {
          const digit = this.hexValue(this.source.charCodeAt(this.index + offset));
          if (digit < 0) this.malformed();
          value = value * 16 + digit;
        }
        this.index += 4;
        output += String.fromCharCode(value);
      } else {
        this.malformed();
      }
    }
    return this.malformed();
  }

  private parseNumber(): number {
    const start = this.index;
    if (this.source[this.index] === "-") this.index += 1;
    if (this.source[this.index] === "0") {
      this.index += 1;
      if (this.isDigit(this.source.charCodeAt(this.index))) this.malformed();
    } else {
      if (!this.isDigitOneToNine(this.source.charCodeAt(this.index))) this.malformed();
      while (this.isDigit(this.source.charCodeAt(this.index))) this.index += 1;
    }
    if (this.source[this.index] === ".") {
      this.index += 1;
      if (!this.isDigit(this.source.charCodeAt(this.index))) this.malformed();
      while (this.isDigit(this.source.charCodeAt(this.index))) this.index += 1;
    }
    const exponent = this.source[this.index];
    if (exponent === "e" || exponent === "E") {
      this.index += 1;
      const sign = this.source[this.index];
      if (sign === "+" || sign === "-") this.index += 1;
      if (!this.isDigit(this.source.charCodeAt(this.index))) this.malformed();
      while (this.isDigit(this.source.charCodeAt(this.index))) this.index += 1;
    }
    const value = Number(this.source.slice(start, this.index));
    if (!Number.isFinite(value)) this.malformed();
    return value;
  }

  private parseLiteral<T>(literal: string, value: T): T {
    if (!this.source.startsWith(literal, this.index)) this.malformed();
    this.index += literal.length;
    return value;
  }

  private skipWhitespace(): void {
    while (this.index < this.source.length) {
      const unit = this.source.charCodeAt(this.index);
      if (unit !== 0x20 && unit !== 0x09 && unit !== 0x0a && unit !== 0x0d) return;
      this.index += 1;
    }
  }

  private hexValue(unit: number): number {
    if (unit >= 0x30 && unit <= 0x39) return unit - 0x30;
    if (unit >= 0x41 && unit <= 0x46) return unit - 0x41 + 10;
    if (unit >= 0x61 && unit <= 0x66) return unit - 0x61 + 10;
    return -1;
  }

  private isDigit(unit: number): boolean {
    return unit >= 0x30 && unit <= 0x39;
  }

  private isDigitOneToNine(unit: number): boolean {
    return unit >= 0x31 && unit <= 0x39;
  }

  private malformed(): never {
    throw new StrictJsonError("malformed-json", "typed compaction request contains malformed JSON");
  }
}

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
    parsed = new StrictJsonParser(source.slice(FABRIC_COMPACTION_REQUEST_PREFIX.length)).parse();
  } catch (error) {
    if (error instanceof StrictJsonError) {
      return rejection(error.code, error.message, encodedSourceBytes);
    }
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
