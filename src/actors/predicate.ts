import { QuickJsRuntime } from "../runtime/quickjs-runtime.js";
import type {
  FabricActorValidityDecision,
  FabricActorValidityFacts,
  FabricActorValidWhileSource,
} from "./types.js";

const PREDICATE_VERSION = 1;
const MAX_PREDICATE_SOURCE_CHARS = 16_000;
const PREDICATE_TIMEOUT_MS = 100;
const PREDICATE_MEMORY_BYTES = 16 * 1024 * 1024;

const runtime = new QuickJsRuntime();

const predicateProgram = (source: string, invoke: boolean): string => [
  `const predicate = (${source});`,
  'if (typeof predicate !== "function") throw new TypeError("validWhile must be a function");',
  invoke
    ? [
        'const freeze = (value) => {',
        '  if (value && typeof value === "object" && !Object.isFrozen(value)) {',
        '    Object.freeze(value);',
        '    for (const nested of Object.values(value)) freeze(nested);',
        '  }',
        '  return value;',
        '};',
        'const decision = predicate(freeze(JSON.parse(π.facts)));',
        'if (decision && typeof decision.then === "function") throw new TypeError("validWhile must return synchronously");',
        'return decision;',
      ].join("\n")
    : 'return true;',
].join("\n");

const execute = async (source: FabricActorValidWhileSource, facts?: FabricActorValidityFacts) => {
  const result = await runtime.execute(
    predicateProgram(source.source, facts !== undefined),
    async () => {
      throw new Error("validWhile cannot call host tools");
    },
    {
      timeoutMs: PREDICATE_TIMEOUT_MS,
      memoryLimitBytes: PREDICATE_MEMORY_BYTES,
      maxLogChars: 0,
      strings: facts === undefined ? {} : { facts: JSON.stringify(facts) },
    },
  );
  if (result.terminationReason !== "completed") {
    throw new Error(result.error ?? `validWhile ${result.terminationReason}`);
  }
  return result.value;
};

export const validateActorValidWhile = async (
  value: FabricActorValidWhileSource | undefined,
): Promise<void> => {
  if (!value) return;
  if (value.version !== PREDICATE_VERSION) {
    throw new Error(`Unsupported validWhile predicate version: ${String(value.version)}`);
  }
  if (!value.source.trim()) throw new Error("validWhile predicate source must not be empty");
  if (value.source.length > MAX_PREDICATE_SOURCE_CHARS) {
    throw new Error(`validWhile predicate exceeds ${MAX_PREDICATE_SOURCE_CHARS} characters`);
  }
  await execute(value);
};

export const evaluateActorValidWhile = async (
  source: FabricActorValidWhileSource,
  facts: FabricActorValidityFacts,
): Promise<{ valid: boolean; reason?: string }> => {
  const value = await execute(source, facts);
  if (typeof value === "boolean") return { valid: value };
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const decision = value as Partial<FabricActorValidityDecision>;
    if (typeof decision.valid === "boolean") {
      return {
        valid: decision.valid,
        ...(typeof decision.reason === "string" && decision.reason.trim()
          ? { reason: decision.reason.trim() }
          : {}),
      };
    }
  }
  throw new Error("validWhile must return a boolean or { valid, reason? } synchronously");
};
