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
  const sourceCountByTarget = new Map<string, number>();
  for (const repair of applicable) {
    sourceCountByTarget.set(repair.to, (sourceCountByTarget.get(repair.to) ?? 0) + 1);
  }
  let out = args;
  let changed = false;
  for (const repair of applicable) {
    const canonicalPresent = Object.hasOwn(args, repair.to);
    if (!canonicalPresent && sourceCountByTarget.get(repair.to) !== 1) continue;
    if (out === args) out = { ...args };
    if (!Object.hasOwn(out, repair.to)) {
      Object.defineProperty(out, repair.to, {
        value: out[repair.from], enumerable: true, writable: true, configurable: true,
      });
    }
    delete out[repair.from];
    changed = true;
  }
  return { args: out, changed };
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
