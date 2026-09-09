// Internal compatibility plans. The declared schema is never rewritten.
// A proof is a re-derivation from a bounded rule language, not a claim made
// by an imported artifact. No observation can authorize a new semantic map.
import { Value } from "typebox/value";
import { stableJsonHash } from "../core/stable-hash.js";
import { shapeSignature } from "./fingerprint.js";

export interface NormalFormEvidenceSummary {
  normalizedCalls: number;
  rulesApplied: number;
  succeeded: number;
  subsequentFailures: number;
}

// Witness counts are observations, not manufactured task successes. A call
// can be normalized and still fail authorization, approval, or execution.
export const normalFormEvidenceSummary = (
  traces: readonly import("./types.js").EntropyTraceInput[],
): NormalFormEvidenceSummary => {
  const summary = { normalizedCalls: 0, rulesApplied: 0, succeeded: 0, subsequentFailures: 0 };
  for (const trace of traces) for (const operation of trace.operations) {
    if (!operation.normalization || !isNormalFormWitness(operation.normalization)) continue;
    summary.normalizedCalls++;
    summary.rulesApplied += operation.normalization.rules.length;
    if (operation.outcome === "succeeded") summary.succeeded++;
    else summary.subsequentFailures++;
  }
  return summary;
};

export const NORMAL_FORM_VERSION = 1 as const;
export const MAX_NORMAL_FORM_RULES = 128;
export const MAX_NORMAL_FORM_PLANS = 1_000;
const RULE_KINDS = ["key-form", "enum-form", "numeric-string", "optional-null"] as const;
export type NormalFormRuleKind = typeof RULE_KINDS[number];
export interface NormalFormRule { kind: NormalFormRuleKind; key: string }
export interface NormalFormPlan {
  version: typeof NORMAL_FORM_VERSION;
  ref: string;
  baseSchemaDigest: string;
  rules: NormalFormRule[];
}
export interface NormalFormWitness {
  version: typeof NORMAL_FORM_VERSION;
  baseSchemaDigest: string;
  beforeShape: string;
  afterShape: string;
  rules: NormalFormRule[];
}
export interface NormalFormResult {
  args: Record<string, unknown>;
  witness?: NormalFormWitness;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const safeKey = (key: string): boolean => key.length <= 128 &&
  !["__proto__", "prototype", "constructor"].includes(key);
const form = (value: string): string | undefined =>
  /^[a-zA-Z][a-zA-Z0-9 _-]*$/.test(value) ? value.toLowerCase().replace(/[ _-]/g, "") : undefined;
const accepts = (schema: unknown, args: unknown): boolean => {
  try { return isRecord(schema) && Value.Check(schema, args); } catch { return false; }
};
const uniqueForms = (values: readonly string[]): Map<string, string> => {
  const groups = new Map<string, string[]>();
  for (const value of values) {
    const key = form(value);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }
  return new Map([...groups].filter(([, group]) => group.length === 1).map(([key, group]) => [key, group[0]!]));
};

// These four conventions are host-authored compatibility semantics:
// spelling-only key/enum forms, lossless numeric encoding, and omission of
// non-nullable optional fields. Open objects and schema combinators are not
// grounds for inventing an interpretation. Unsupported schemas pass through.
export const deriveNormalFormPlan = (ref: string, schema: unknown): NormalFormPlan | undefined => {
  if (!ref || ref.length > 1_024 || !isRecord(schema) || schema.type !== "object" ||
      schema.additionalProperties !== false || !isRecord(schema.properties) ||
      ["patternProperties", "oneOf", "anyOf", "allOf", "$ref", "if", "not"].some((key) => Object.hasOwn(schema, key))) return undefined;
  const keys = Object.keys(schema.properties).sort();
  if (keys.length > MAX_NORMAL_FORM_RULES || !keys.every(safeKey)) return undefined;
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const forms = new Set(uniqueForms(keys).values());
  const rules: NormalFormRule[] = [];
  for (const key of keys) {
    const property = schema.properties[key];
    if (!isRecord(property)) continue;
    if (forms.has(key)) rules.push({ kind: "key-form", key });
    if (!required.has(key) && !accepts(property, null)) rules.push({ kind: "optional-null", key });
    if (property.type === "number" || property.type === "integer") rules.push({ kind: "numeric-string", key });
    if (property.type === "string" && Array.isArray(property.enum) &&
        property.enum.every((value) => typeof value === "string") &&
        uniqueForms(property.enum).size > 0) rules.push({ kind: "enum-form", key });
  }
  if (rules.length === 0) return undefined;
  return { version: NORMAL_FORM_VERSION, ref, baseSchemaDigest: stableJsonHash(schema), rules: rules.slice(0, MAX_NORMAL_FORM_RULES) };
};

const isRule = (value: unknown): value is NormalFormRule => isRecord(value) &&
  Object.keys(value).length === 2 && typeof value.key === "string" && safeKey(value.key) &&
  RULE_KINDS.includes(value.kind as NormalFormRuleKind);
const isDigest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const isNormalFormPlan = (value: unknown): value is NormalFormPlan => isRecord(value) &&
  Object.keys(value).length === 4 && value.version === NORMAL_FORM_VERSION &&
  typeof value.ref === "string" && value.ref.length > 0 && value.ref.length <= 1_024 &&
  isDigest(value.baseSchemaDigest) && Array.isArray(value.rules) &&
  value.rules.length > 0 && value.rules.length <= MAX_NORMAL_FORM_RULES && value.rules.every(isRule);
export const isNormalFormWitness = (value: unknown): value is NormalFormWitness => isRecord(value) &&
  Object.keys(value).length === 5 && value.version === NORMAL_FORM_VERSION &&
  isDigest(value.baseSchemaDigest) && isDigest(value.beforeShape) && isDigest(value.afterShape) &&
  Array.isArray(value.rules) && value.rules.length > 0 && value.rules.length <= MAX_NORMAL_FORM_RULES && value.rules.every(isRule);

export const provesNormalFormPlan = (plan: NormalFormPlan, schema: unknown): boolean => {
  if (!isNormalFormPlan(plan)) return false;
  try {
    const derived = deriveNormalFormPlan(plan.ref, schema);
    return derived !== undefined && stableJsonHash(derived) === stableJsonHash(plan);
  } catch { return false; }
};

export const applyNormalFormPlan = (
  ref: string,
  schema: unknown,
  args: Record<string, unknown>,
  plan?: NormalFormPlan,
): NormalFormResult => {
  const unchanged = { args };
  // This early identity law protects every canonical capability, including
  // rare enum members and nullable values. Successful candidates satisfy it
  // too, which establishes idempotence without a corpus-dependent gate.
  if (!plan || plan.ref !== ref || accepts(schema, args) || !provesNormalFormPlan(plan, schema)) return unchanged;
  const properties = (schema as { properties: Record<string, Record<string, unknown>> }).properties;
  const candidate = { ...args };
  const applied: NormalFormRule[] = [];
  const keyRules = plan.rules.filter((rule) => rule.kind === "key-form");
  const forms = uniqueForms(keyRules.map((rule) => rule.key));
  const targets = new Set<string>();
  for (const key of Object.keys(args).sort()) {
    if (Object.hasOwn(properties, key)) continue;
    const normalized = form(key);
    const target = normalized ? forms.get(normalized) : undefined;
    if (!target) continue;
    // Never discard a competing canonical value or choose between aliases.
    if (Object.hasOwn(args, target) || targets.has(target)) return unchanged;
    targets.add(target);
    Object.defineProperty(candidate, target, { value: args[key], enumerable: true, configurable: true, writable: true });
    delete candidate[key];
    applied.push({ kind: "key-form", key: target });
  }
  for (const rule of plan.rules) {
    if (rule.kind === "key-form" || !Object.hasOwn(candidate, rule.key)) continue;
    const value = candidate[rule.key];
    const property = properties[rule.key]!;
    if (accepts(property, value)) continue;
    if (rule.kind === "optional-null" && (value === null || value === undefined)) {
      delete candidate[rule.key];
      applied.push(rule);
    } else if (rule.kind === "numeric-string" && typeof value === "string") {
      const number = Number(value);
      if (Number.isFinite(number) && String(number) === value && accepts(property, number)) {
        candidate[rule.key] = number;
        applied.push(rule);
      }
    } else if (rule.kind === "enum-form" && typeof value === "string") {
      const normalized = form(value);
      const target = normalized ? uniqueForms(property.enum as string[]).get(normalized) : undefined;
      if (target !== undefined && accepts(property, target)) {
        candidate[rule.key] = target;
        applied.push(rule);
      }
    }
  }
  // A partial repair is not a successful correction. Return original input
  // on every refusal so authoritative validation reports the real failure.
  if (applied.length === 0 || !accepts(schema, candidate)) return unchanged;
  return {
    args: candidate,
    witness: {
      version: NORMAL_FORM_VERSION,
      baseSchemaDigest: plan.baseSchemaDigest,
      beforeShape: stableJsonHash(shapeSignature(args)),
      afterShape: stableJsonHash(shapeSignature(candidate)),
      rules: applied,
    },
  };
};
