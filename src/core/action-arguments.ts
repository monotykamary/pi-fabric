import { Value } from "typebox/value";
import { applyActiveArgRepairs, getActiveRepairCompiler } from "../repairs/active.js";
import { truncateString } from "./action-result.js";

const MAX_VALIDATION_MESSAGE_CHARS = 2_000;

// TypeBox reports additionalProperties failures against the object root
// without naming the offending keys; name them so a rejected near-miss call
// is actionable (e.g. a before/after guess on memory.expand surfaces as
// "/before: must not have additional properties").
const unexpectedKeys = (
  schema: Record<string, unknown>,
  value: Record<string, unknown>,
): string[] => {
  if ((schema as { type?: unknown }).type !== "object") return [];
  if ((schema as { additionalProperties?: unknown }).additionalProperties !== false) return [];
  if ((schema as { patternProperties?: unknown }).patternProperties !== undefined) return [];
  const properties = (schema as { properties?: Record<string, unknown> }).properties;
  if (!properties) return [];
  return Object.keys(value).filter((key) => !(key in properties));
};

export const validationMessage = (
  schema: Record<string, unknown>,
  value: Record<string, unknown>,
): string | undefined => {
  try {
    if (Value.Check(schema, value)) return undefined;
    const messages = [...Value.Errors(schema, value)]
      .slice(0, 5)
      .map((error) => {
        // Prefix nested failures with their property path.
        const at = (error as { path?: unknown }).path;
        return typeof at === "string" && at !== "" && at !== "/"
          ? `${at}: ${error.message}`
          : error.message;
      });
    for (const key of unexpectedKeys(schema, value).slice(0, 5)) {
      messages.push(`/${key}: must not have additional properties`);
    }
    return truncateString(
      messages.join("; ") || "Schema validation failed",
      MAX_VALIDATION_MESSAGE_CHARS,
    );
  } catch {
    return "Schema validator failed";
  }
};

const declaredPropertyNames = (schema: Record<string, unknown>): string[] => {
  const properties = (schema as { properties?: Record<string, unknown> }).properties;
  return properties ? Object.keys(properties) : [];
};

export const repairCatalogInput = (
  ref: string,
  schema: Record<string, unknown>,
  args: Record<string, unknown>,
): { args: Record<string, unknown>; observedUnexpected: string | undefined } => {
  const extras = unexpectedKeys(schema, args).sort();
  const observedUnexpected = extras.length > 0 ? extras.join("\0") : undefined;
  if (extras.length > 0) {
    getActiveRepairCompiler()?.observeInvalidArgs(
      ref,
      args,
      declaredPropertyNames(schema),
      extras.join(","),
      { countError: false, extraKeys: extras },
    );
  }
  return {
    args: applyActiveArgRepairs(ref, args, schema),
    observedUnexpected,
  };
};

export const validateCatalogArgs = (
  ref: string,
  schema: Record<string, unknown>,
  args: Record<string, unknown>,
  observedUnexpected: string | undefined,
): { args: Record<string, unknown>; invalid?: string } => {
  const compiler = getActiveRepairCompiler();
  const first = applyActiveArgRepairs(ref, args, schema);
  const invalid = validationMessage(schema, first);
  if (!invalid) return { args: first };
  const extras = unexpectedKeys(schema, first).sort();
  if (observedUnexpected === undefined || extras.join("\0") !== observedUnexpected) {
    compiler?.observeInvalidArgs(
      ref,
      first,
      declaredPropertyNames(schema),
      invalid,
      { countError: false, extraKeys: extras },
    );
  }
  const second = applyActiveArgRepairs(ref, first, schema);
  const stillInvalid = validationMessage(schema, second);
  if (stillInvalid) compiler?.recordInvocationError();
  return stillInvalid ? { args: second, invalid: stillInvalid } : { args: second };
};

