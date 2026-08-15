import { PI_CORE_TOOL_NAMES, type PiCoreToolName } from "../core/pi-tools.js";
import {
  PI_CORE_COMPATIBILITY_ARGUMENT_TYPE_NAMES,
  PI_CORE_NUMERIC_FIELDS,
} from "./guest-types.js";

/** The small source shape needed to render a captured core override. */
export interface FabricCoreOverrideTypeSource {
  name: string;
  inputSchema: unknown;
}

const LOOSE_ARGUMENT_TYPE = "Record<string, unknown>";
const MAX_SCHEMA_DEPTH = 8;
const MAX_SCHEMA_MEMBERS = 128;
const MAX_SCHEMA_SOURCE_CHARS = 32_000;
const MAX_SCHEMA_OUTPUT_CHARS = 8_000;
const MAX_DECLARATION_OUTPUT_CHARS = 32_000;
const MAX_UNION_MEMBERS = 16;

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// The extra overload must also accept Fabric's existing built-in forms. In
// particular, the runtime accepts numeric strings before host validation; the
// compatibility aliases beside PiToolsApi keep those forms in the same SSOT.
const compatibilityArgumentTypeFor = (name: PiCoreToolName): string =>
  PI_CORE_COMPATIBILITY_ARGUMENT_TYPE_NAMES[name];

const returnTypeFor = (name: PiCoreToolName): string =>
  `ReturnType<PiToolsApi["${name}"]>`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const propertyKey = (name: string): string =>
  IDENTIFIER.test(name) ? name : JSON.stringify(name);

const literalType = (value: unknown): string => {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  throw new Error("Schema literal is not a JSON primitive");
};

const unique = <T>(values: T[]): T[] => [...new Set(values)];

const unionType = (parts: string[]): string => {
  const members = unique(parts);
  if (members.length === 0) throw new Error("Schema union has no members");
  return members.length === 1 ? members[0]! : members.join(" | ");
};

const schemaTypes = (schema: Record<string, unknown>): string[] => {
  const value = schema.type;
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string")) {
    return unique(value as string[]);
  }
  if (value === undefined) return [];
  throw new Error("Schema type is malformed");
};

const unsupportedSchemaKeys = new Set([
  "$defs",
  "$ref",
  "definitions",
  "dependentRequired",
  "dependentSchemas",
  "dependencies",
  "if",
  "not",
  "patternProperties",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
  "unless",
  "when",
]);

interface RenderState {
  members: number;
  active: Set<object>;
  numericStringFields: ReadonlySet<string>;
}

const countMember = (state: RenderState): void => {
  state.members += 1;
  if (state.members > MAX_SCHEMA_MEMBERS) throw new Error("Schema member budget exceeded");
};

const recordSchema = (schema: Record<string, unknown>, state: RenderState): void => {
  for (const key of unsupportedSchemaKeys) {
    if (key in schema) throw new Error(`Unsupported schema keyword: ${key}`);
  }
  if (state.active.has(schema)) throw new Error("Recursive schema");
  state.active.add(schema);
};

const renderSchema = (value: unknown, state: RenderState, depth: number): string => {
  if (depth > MAX_SCHEMA_DEPTH) throw new Error("Schema depth budget exceeded");
  if (value === true) return "unknown";
  if (value === false) return "never";
  if (!isRecord(value)) throw new Error("Schema is malformed");

  recordSchema(value, state);
  try {
    if (Object.hasOwn(value, "const")) return literalType(value.const);

    if (Object.hasOwn(value, "enum")) {
      if (!Array.isArray(value.enum) || value.enum.length === 0) {
        throw new Error("Schema enum is malformed");
      }
      if (value.enum.length > MAX_UNION_MEMBERS) {
        throw new Error("Schema union budget exceeded");
      }
      return unionType(value.enum.map((entry) => {
        countMember(state);
        return literalType(entry);
      }));
    }

    const alternates = Array.isArray(value.anyOf)
      ? value.anyOf
      : Array.isArray(value.oneOf)
        ? value.oneOf
        : undefined;
    if (alternates) {
      if (alternates.length === 0 || alternates.length > MAX_UNION_MEMBERS) {
        throw new Error("Schema union is malformed or over budget");
      }
      return unionType(alternates.map((entry) => {
        countMember(state);
        return renderSchema(entry, state, depth + 1);
      }));
    }

    if (Object.hasOwn(value, "allOf")) {
      if (!Array.isArray(value.allOf) || value.allOf.length === 0 || value.allOf.length > MAX_UNION_MEMBERS) {
        throw new Error("Schema intersection is malformed or over budget");
      }
      return value.allOf.map((entry) => {
        countMember(state);
        const rendered = renderSchema(entry, state, depth + 1);
        return rendered.includes(" | ") ? `(${rendered})` : rendered;
      }).join(" & ");
    }

    if (Object.hasOwn(value, "nullable") && typeof value.nullable !== "boolean") {
      throw new Error("Schema nullable flag is malformed");
    }

    const types = schemaTypes(value);
    let rendered: string;
    if (types.length > 1) {
      rendered = unionType(types.map((type) => renderSchema({ ...value, type }, state, depth + 1)));
    } else {
      const type = types[0];
      if (type === undefined) {
        rendered = isRecord(value.properties) || Object.hasOwn(value, "additionalProperties")
          ? renderObject(value, state, depth)
          : (() => { throw new Error("Schema has no supported type"); })();
      } else if (type === "object") {
        rendered = renderObject(value, state, depth);
      } else if (type === "string") {
        rendered = "string";
      } else if (type === "number" || type === "integer") {
        rendered = "number";
      } else if (type === "boolean") {
        rendered = "boolean";
      } else if (type === "null") {
        rendered = "null";
      } else if (type === "array") {
        rendered = renderArray(value, state, depth);
      } else {
        throw new Error(`Unsupported schema type: ${type}`);
      }
    }

    return value.nullable === true && !rendered.split(" | ").includes("null")
      ? `${rendered} | null`
      : rendered;
  } finally {
    state.active.delete(value);
  }
};

const renderObject = (
  schema: Record<string, unknown>,
  state: RenderState,
  depth: number,
): string => {
  const rawProperties = schema.properties;
  if (rawProperties !== undefined && !isRecord(rawProperties)) {
    throw new Error("Schema properties are malformed");
  }
  const properties = rawProperties as Record<string, unknown> | undefined;
  const rawRequired = schema.required;
  if (rawRequired !== undefined && (
    !Array.isArray(rawRequired) ||
    !rawRequired.every((entry) => typeof entry === "string") ||
    new Set(rawRequired).size !== rawRequired.length
  )) {
    throw new Error("Schema required fields are malformed");
  }
  const required = new Set((rawRequired ?? []) as string[]);
  if (properties && [...required].some((key) => !(key in properties))) {
    throw new Error("Schema required field is not a property");
  }

  const members: string[] = [];
  for (const key of Object.keys(properties ?? {}).sort()) {
    countMember(state);
    const rendered = renderSchema(properties![key], state, depth + 1);
    const type = depth === 0 && state.numericStringFields.has(key) && rendered === "number"
      ? "number | string"
      : rendered;
    members.push(`${propertyKey(key)}${required.has(key) ? "" : "?"}: ${type}`);
  }

  if (Object.hasOwn(schema, "additionalProperties")) {
    const additional = schema.additionalProperties;
    if (additional === false) {
      // A never-valued index signature keeps an empty closed object strict.
      if (members.length === 0) return "Record<string, never>";
    } else if (additional === true) {
      members.push("[key: string]: unknown");
    } else if (isRecord(additional)) {
      members.push(`[key: string]: ${renderSchema(additional, state, depth + 1)}`);
    } else {
      throw new Error("Schema additionalProperties is malformed");
    }
  } else {
    members.push("[key: string]: unknown");
  }

  return `{ ${members.join("; ")} }`;
};

const renderArray = (
  schema: Record<string, unknown>,
  state: RenderState,
  depth: number,
): string => {
  const items = schema.items;
  if (Array.isArray(items)) {
    if (items.length > MAX_UNION_MEMBERS) throw new Error("Schema tuple budget exceeded");
    return `[${items.map((entry) => {
      countMember(state);
      return renderSchema(entry, state, depth + 1);
    }).join(", ")}]`;
  }
  if (items === undefined || items === true) return "Array<unknown>";
  return `Array<${renderSchema(items, state, depth + 1)}>`;
};

const isObjectArgumentSchema = (value: unknown, active = new Set<object>()): boolean => {
  if (!isRecord(value)) return false;
  if (active.has(value)) return false;
  active.add(value);
  try {
    const types = schemaTypes(value);
    if (types.length > 0) return types.length === 1 && types[0] === "object";
    const alternates = Array.isArray(value.anyOf)
      ? value.anyOf
      : Array.isArray(value.oneOf)
        ? value.oneOf
        : undefined;
    if (alternates) return alternates.length > 0 && alternates.every((entry) => isObjectArgumentSchema(entry, active));
    if (Array.isArray(value.allOf)) {
      return value.allOf.length > 0 && value.allOf.every((entry) => isObjectArgumentSchema(entry, active));
    }
    return isRecord(value.properties) || Object.hasOwn(value, "additionalProperties");
  } finally {
    active.delete(value);
  }
};

const renderArgumentType = (
  schema: unknown,
  numericStringFields: ReadonlySet<string>,
): { type: string; required: boolean } => {
  let serialized: string;
  try {
    serialized = JSON.stringify(schema);
  } catch {
    throw new Error("Schema cannot be serialized");
  }
  if (!serialized || serialized.length > MAX_SCHEMA_SOURCE_CHARS) {
    throw new Error("Schema source budget exceeded");
  }
  const state: RenderState = {
    members: 0,
    active: new Set(),
    numericStringFields,
  };
  if (!isObjectArgumentSchema(schema)) {
    throw new Error("Core override arguments must be an object schema");
  }
  const type = renderSchema(schema, state, 0);
  if (type.length > MAX_SCHEMA_OUTPUT_CHARS) throw new Error("Schema output budget exceeded");
  const required = isRecord(schema) && Array.isArray(schema.required) && schema.required.length > 0;
  return { type, required };
};

const resolveValidCoreOverrideSource = (
  source: FabricCoreOverrideTypeSource,
): { name: PiCoreToolName; inputSchema: unknown } | undefined => {
  if (!PI_CORE_TOOL_NAMES.includes(source.name as PiCoreToolName)) return undefined;
  return { name: source.name as PiCoreToolName, inputSchema: source.inputSchema };
};

/**
 * Build the full-code `pi` declaration for the current exact-name overrides.
 *
 * The static PiToolsApi remains the base interface. Each generated member is
 * an additive overload with the core slot's static result type; a renderer
 * failure intentionally produces a loose object overload so runtime schema
 * validation remains the authority.
 */
export const buildCoreOverrideGuestDeclarations = (
  sources: readonly FabricCoreOverrideTypeSource[],
): string | undefined => {
  const byName = new Map<PiCoreToolName, FabricCoreOverrideTypeSource>();
  for (const source of sources) {
    const resolved = resolveValidCoreOverrideSource(source);
    if (resolved && !byName.has(resolved.name)) byName.set(resolved.name, source);
  }
  if (byName.size === 0) return undefined;

  const methods: string[] = [];
  let outputChars = 0;
  for (const name of PI_CORE_TOOL_NAMES) {
    const source = byName.get(name);
    if (!source) continue;
    let argumentType = LOOSE_ARGUMENT_TYPE;
    let required = false;
    try {
      const rendered = renderArgumentType(
        source.inputSchema,
        new Set(PI_CORE_NUMERIC_FIELDS[name]),
      );
      argumentType = rendered.type;
      required = rendered.required;
    } catch {
      // A loose overload keeps override-specific calls reachable while the
      // registry still validates the effective schema at dispatch.
    }
    let compatibility = `Partial<${argumentType}> & (${compatibilityArgumentTypeFor(name)})`;
    let method = `  ${name}(args${required ? "" : "?"}: ${argumentType} | (${compatibility})): ${returnTypeFor(name)};`;
    outputChars += method.length;
    if (outputChars > MAX_DECLARATION_OUTPUT_CHARS) {
      argumentType = LOOSE_ARGUMENT_TYPE;
      required = false;
      compatibility = `Partial<${argumentType}> & (${compatibilityArgumentTypeFor(name)})`;
      method = `  ${name}(args?: ${argumentType} | (${compatibility})): ${returnTypeFor(name)};`;
    }
    methods.push(method);
  }

  if (methods.length === 0) return undefined;
  return [
    "// Generated from the current captured exact-name core overrides for this execution.",
    "type FabricPiCoreOverrideApi = PiToolsApi & {",
    ...methods,
    "};",
    "declare const pi: FabricPiCoreOverrideApi;",
    "",
  ].join("\n");
};
