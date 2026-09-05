import { normalizeRunDisplay } from "./run-display.js";
import { repairFabricGuestCode } from "./runtime/guest-code-repair.js";

const OPTIONAL_FABRIC_EXEC_KEYS = [
  "payloads",
  "strings",
  "resultFormat",
  "tokenBudget",
  "agentBudget",
  "timeoutMs",
  "display",
  "timeout",
  "settle",
] as const;

/** Internal guest binding used only after a validated script reaches execute. */
const FABRIC_SCRIPT_STRING_KEY = "__fabric_script";

/** Script-only scalars consumed by compilation into the nested pi.bash options. */
const SCRIPT_OPTION_KEYS = ["timeout", "settle"] as const;

/** Upper bound on the script-mode `timeout`, in seconds. */
const MAX_SCRIPT_TIMEOUT_SECONDS = 86_400;

/** Keys that cannot reach a shell payload and therefore reject alongside `script`. */
const SCRIPT_INCOMPATIBLE_KEYS = [
  "payloads",
  "strings",
  "tokenBudget",
  "agentBudget",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const looksLikeJsonObject = (text: string): boolean =>
  text.startsWith("{") && text.endsWith("}");

const looksLikeJsonString = (text: string): boolean =>
  text.startsWith('"') && text.endsWith('"');

const parseJsonObject = (text: string): Record<string, unknown> | undefined => {
  const trimmed = text.trim();
  if (!looksLikeJsonObject(trimmed) && !looksLikeJsonString(trimmed)) return undefined;
  try {
    let parsed: unknown = JSON.parse(trimmed);
    // One extra unwrap: models sometimes JSON-encode the object twice.
    if (typeof parsed === "string") {
      const inner = parsed.trim();
      if (!looksLikeJsonObject(inner)) return undefined;
      parsed = JSON.parse(inner);
    }
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const asStringRecord = (record: Record<string, unknown>): Record<string, string> | undefined => {
  if (Object.values(record).some((value) => typeof value !== "string")) return undefined;
  return record as Record<string, string>;
};

// Silent repair for the named-payload map. The declared shape is
// Record<string, string>, but models stringify nested maps (the highest-entropy
// escaped field in an otherwise flat tool), which strict schema validation
// rejects at the cost of a zero-work round trip. `strings` is a legacy alias:
// the name collides with the JSON string type and taught models to pass one.
const normalizeFabricExecStrings = (
  input: unknown,
): Record<string, string> | undefined => {
  if (isRecord(input)) return asStringRecord(input);
  if (typeof input !== "string") return undefined;
  const parsed = parseJsonObject(input);
  return parsed ? asStringRecord(parsed) : undefined;
};

export const resolveFabricExecPayloads = (params: {
  payloads?: unknown;
  strings?: unknown;
}): Record<string, string> | undefined =>
  normalizeFabricExecStrings(params.payloads) ?? normalizeFabricExecStrings(params.strings);

// Pi wraps prepareArguments in the same try/catch that serves schema
// validation, so a plain Error here becomes an ordinary argument-error tool
// result carrying this message.
const argumentError = (message: string): Error => new Error(message);

type ScriptOptions = { timeout?: number; settle?: boolean };

const scriptOptionLiteral = (options: ScriptOptions): string => {
  const parts: string[] = [];
  if (options.timeout !== undefined) parts.push(`timeout: ${options.timeout}`);
  if (options.settle !== undefined) parts.push(`settle: ${options.settle}`);
  return parts.length > 0 ? `, { ${parts.join(", ")} }` : "";
};

// The settle projection narrows the pi.bash union before reading exitCode,
// because the ok:true branch of that union carries no exitCode field. Fabric's
// own type gate would not catch a flat `result.exitCode ?? 0` — it filters
// type-correctness diagnostics (TS2339 among them) and rejects on syntax — so
// this is written to be correct under an ordinary tsc rather than to survive
// the gate, and it stays correct if that filter is ever tightened.
const SETTLED_RETURN =
  "return result.ok ? { ok: true, exitCode: 0, output: result.output } : "
  + "{ ok: false, exitCode: result.exitCode, output: result.output };";
const PLAIN_RETURN = "return result.output;";

/**
 * Compile a script payload to the fixed `code` template selected by which
 * options were supplied. Caller values only ever appear as typed scalars in the
 * nested option object; the script text itself stays in `strings` and is never
 * interpolated into the program.
 */
const compileFabricScriptProgram = (options: ScriptOptions): string =>
  `const result = await pi.bash(π.${FABRIC_SCRIPT_STRING_KEY}${scriptOptionLiteral(options)}); `
  + (options.settle === true ? SETTLED_RETURN : PLAIN_RETURN);

const present = (args: Record<string, unknown>, key: string): boolean =>
  Object.hasOwn(args, key) && args[key] !== undefined && args[key] !== null;

const readScriptOptions = (args: Record<string, unknown>): ScriptOptions => {
  const options: ScriptOptions = {};
  if (present(args, "timeout")) {
    const timeout = args.timeout;
    // Whole seconds only, and bounded: the execution seam embeds this typed
    // scalar into a fixed program template rather than interpolating payload text.
    if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1
      || timeout > MAX_SCRIPT_TIMEOUT_SECONDS) {
      throw argumentError(
        `fabric_exec \`timeout\` must be a whole number of seconds between 1 and ${MAX_SCRIPT_TIMEOUT_SECONDS}.`,
      );
    }
    options.timeout = timeout;
  }
  if (present(args, "settle")) {
    const settle = args.settle;
    if (typeof settle !== "boolean") {
      throw argumentError("fabric_exec `settle` must be a boolean.");
    }
    options.settle = settle;
  }
  return options;
};

/**
 * Enforce the flat `code` XOR `script` contract before Pi validates the public
 * schema. Compilation stays behind {@link resolveFabricExecProgram}, after the
 * host has validated and persisted the authored surface.
 *
 * Contract violations throw. Pi wraps prepareArguments in the same try/catch
 * that serves schema validation, so a throw here becomes an ordinary argument
 * error tool result and never reaches `execute`, QuickJS, or a nested call.
 */
const applyScriptContract = (
  args: Record<string, unknown>,
): Record<string, unknown> => {
  const hasScript = Object.hasOwn(args, "script") && args.script !== undefined
    && args.script !== null;
  const hasCode = Object.hasOwn(args, "code") && args.code !== undefined && args.code !== null;

  if (!hasScript) {
    for (const key of SCRIPT_OPTION_KEYS) {
      if (!present(args, key)) continue;
      throw argumentError(
        `fabric_exec \`${key}\` is a script-mode option and requires \`script\`. `
        + "A `code` program passes it to pi.bash directly instead.",
      );
    }
    if (!hasCode) {
      throw argumentError(
        "fabric_exec requires either `code` (a TypeScript function body) or "
        + "`script` (one complete shell program).",
      );
    }
    return args;
  }

  if (hasCode) {
    throw argumentError(
      "fabric_exec accepts `code` or `script`, not both. Use `script` for one "
      + "complete shell program and `code` for anything that orchestrates more "
      + "than that single command.",
    );
  }
  if (typeof args.script !== "string") {
    throw argumentError("fabric_exec `script` must be a string.");
  }
  for (const key of SCRIPT_INCOMPATIBLE_KEYS) {
    if (!present(args, key)) continue;
    throw argumentError(
      `fabric_exec \`${key}\` cannot be used with \`script\` and would have no effect: `
      + "`π` is a guest binding a shell program cannot read, and both budgets are "
      + "observed only by workflow.agent() calls. Use `code` if you need it.",
    );
  }

  readScriptOptions(args);
  return args;
};

export type FabricExecProgram =
  | {
      kind: "code";
      code: string;
      strings?: Record<string, string>;
    }
  | {
      kind: "script";
      code: string;
      strings: Record<string, string>;
    };

/**
 * Resolve validated model-facing arguments into the one internal execution
 * shape. Script identity remains explicit until this seam; no downstream
 * caller has to infer authorship from a magic key or generated source text.
 */
export const resolveFabricExecProgram = (input: unknown): FabricExecProgram => {
  if (!isRecord(input)) {
    throw argumentError("fabric_exec arguments must be an object.");
  }
  if (typeof input.script === "string") {
    return {
      kind: "script",
      code: compileFabricScriptProgram(readScriptOptions(input)),
      strings: { [FABRIC_SCRIPT_STRING_KEY]: input.script },
    };
  }
  if (typeof input.code !== "string") {
    throw argumentError(
      "fabric_exec requires either `code` (a TypeScript function body) or "
      + "`script` (one complete shell program).",
    );
  }
  const payloads = resolveFabricExecPayloads(input);
  return {
    kind: "code",
    code: input.code,
    ...(payloads ? { strings: payloads } : {}),
  };
};

export const prepareFabricExecArguments = (input: unknown): unknown => {
  if (typeof input === "string") return { code: repairFabricGuestCode(input) };
  if (!isRecord(input)) return input;

  let prepared = input;
  const writable = (): Record<string, unknown> => {
    if (prepared === input) prepared = { ...input };
    return prepared;
  };

  if (Array.isArray(prepared.code) && prepared.code.every((line) => typeof line === "string")) {
    writable().code = prepared.code.join("\n");
  }
  if (typeof prepared.code === "string") {
    const repaired = repairFabricGuestCode(prepared.code);
    if (repaired !== prepared.code) writable().code = repaired;
  }

  for (const key of OPTIONAL_FABRIC_EXEC_KEYS) {
    if (!Object.hasOwn(prepared, key)) continue;
    if (prepared[key] === null || prepared[key] === undefined) delete writable()[key];
  }

  const display = prepared.display;
  if (typeof display === "string" || isRecord(display)) {
    const normalized = normalizeRunDisplay(display);
    if (normalized) writable().display = normalized;
    else delete writable().display;
  }

  const hasPayloads = Object.hasOwn(prepared, "payloads");
  const hasStrings = Object.hasOwn(prepared, "strings");
  if (hasPayloads || hasStrings) {
    const raw = hasPayloads ? prepared.payloads : prepared.strings;
    const normalized = normalizeFabricExecStrings(raw);
    if (normalized) {
      if (prepared.payloads !== normalized) writable().payloads = normalized;
    } else if (!hasPayloads) {
      writable().payloads = raw;
    }
    if (hasStrings) delete writable().strings;
  }

  // Malformed `code` values keep their existing pass-through behavior so schema
  // validation, not this hook, reports them.
  if (Object.hasOwn(prepared, "code") && prepared.code !== undefined
    && typeof prepared.code !== "string") {
    return prepared;
  }

  return applyScriptContract(prepared);
};
