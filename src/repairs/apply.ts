import { Value } from "typebox/value";
import { repairActionName } from "../core/action-repair.js";
import { uniqueDeclaredKeyForSpelling } from "../providers/arg-normalization.js";
import type { CatalogRepair } from "./types.js";

const strictDeclaredPropertyNames = (
  schema: Record<string, unknown>,
): string[] | undefined => {
  if (
    schema.type !== "object" ||
    schema.additionalProperties !== false ||
    schema.patternProperties !== undefined
  ) {
    return undefined;
  }
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return undefined;
  return Object.keys(properties);
};

const applyKeyAliasRepairs = (
  ref: string,
  args: Record<string, unknown>,
  repairs: readonly CatalogRepair[],
  schema: Record<string, unknown>,
): { args: Record<string, unknown>; changed: boolean } => {
  const declared = strictDeclaredPropertyNames(schema);
  if (!declared) return { args, changed: false };
  const declaredSet = new Set(declared);
  const applicable = repairs.filter(
    (repair) =>
      repair.kind === "keyAlias" &&
      repair.ref === ref &&
      Object.hasOwn(args, repair.from) &&
      repair.from !== repair.to &&
      !declaredSet.has(repair.from) &&
      declaredSet.has(repair.to) &&
      uniqueDeclaredKeyForSpelling(repair.from, declared) === repair.to,
  );
  const sourcesByTarget = new Map<string, Set<string>>();
  for (const repair of applicable) {
    const sources = sourcesByTarget.get(repair.to) ?? new Set<string>();
    sources.add(repair.from);
    sourcesByTarget.set(repair.to, sources);
    // Refuse the whole transaction, including unrelated otherwise-safe aliases.
    if (Object.hasOwn(args, repair.to) || sources.size > 1) return { args, changed: false };
  }
  if (applicable.length === 0) return { args, changed: false };
  const out = { ...args };
  for (const [target, sources] of sourcesByTarget) {
    const source = [...sources][0]!;
    Object.defineProperty(out, target, {
      value: args[source], enumerable: true, writable: true, configurable: true,
    });
    delete out[source];
  }
  // Stored mappings are not proof that the resulting live input is valid.
  try {
    if (Value.Check(schema, out)) return { args: out, changed: true };
  } catch {
    // Unsupported or malformed live schemas cannot authorize a repair.
  }
  return { args, changed: false };
};

export const applyActionAliasRepairs = (
  provider: string,
  actionName: string,
  repairs: readonly CatalogRepair[],
  declared: readonly string[],
): string | undefined => {
  if (declared.includes(actionName)) return undefined;
  const liveTarget = repairActionName(declared, actionName).repaired;
  if (!liveTarget) return undefined;
  for (const repair of repairs) {
    if (repair.kind !== "actionAlias") continue;
    if (repair.provider !== provider) continue;
    if (repair.from !== actionName) continue;
    if (repair.to !== liveTarget) continue;
    return repair.to;
  }
  return undefined;
};

export const applyCatalogArgRepairs = (
  ref: string,
  args: Record<string, unknown>,
  repairs: readonly CatalogRepair[],
  schema: Record<string, unknown>,
): { args: Record<string, unknown>; changed: boolean } =>
  applyKeyAliasRepairs(ref, args, repairs, schema);
