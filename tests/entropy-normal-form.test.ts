import { afterEach, describe, expect, it } from "vitest";
import {
  NORMAL_FORM_VERSION, MAX_NORMAL_FORM_RULES, MAX_NORMAL_FORM_PLANS,
  applyNormalFormPlan, deriveNormalFormPlan, isNormalFormPlan, isNormalFormWitness,
  provesNormalFormPlan, normalFormEvidenceSummary, type NormalFormPlan,
} from "../src/entropy/normal-form.js";
import {
  setActiveCompiledSurface, clearActiveCompiledSurface, effectiveInputSchema,
  activeQuarantinedRefNames, isActiveQuarantine, normalizeActiveArguments,
} from "../src/entropy/active.js";
import { emptyCompiledSurface } from "../src/entropy/compiled-surface.js";

const ref = "demo.render";
const schema = {
  type: "object", additionalProperties: false, required: ["outputFormat", "pageCount"],
  properties: {
    outputFormat: { type: "string", enum: ["pdf", "html", "docx", "plainText"] },
    pageCount: { type: "integer", minimum: 1, maximum: 100 },
    note: { type: "string" }, nullable: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
};
const plan = deriveNormalFormPlan(ref, schema)!;
const apply = (args: Record<string, unknown>) => applyNormalFormPlan(ref, schema, args, plan);
afterEach(clearActiveCompiledSurface);

describe("normal-form static proof and laws", () => {
  it("exports bounded v1 plans, derived deterministically from the strict declaration", () => {
    expect(NORMAL_FORM_VERSION).toBe(1);
    expect(MAX_NORMAL_FORM_RULES).toBe(128);
    expect(MAX_NORMAL_FORM_PLANS).toBe(1000);
    expect(plan).toEqual(deriveNormalFormPlan(ref, JSON.parse(JSON.stringify(schema))));
    expect(isNormalFormPlan(plan)).toBe(true);
    expect(provesNormalFormPlan(plan, schema)).toBe(true);
    expect(new Set(plan.rules.map(rule => rule.kind))).toEqual(new Set(["key-form", "enum-form", "numeric-string", "optional-null"]));
  });

  it.each([undefined, {}, { ...schema, additionalProperties: true }, ...["oneOf", "anyOf", "allOf", "$ref", "if", "not", "patternProperties"].map(key => ({ ...schema, [key]: [] }))])("refuses unsupported schemas %j", unsupported => {
    expect(deriveNormalFormPlan(ref, unsupported)).toBeUndefined();
  });

  it("preserves every canonical enum member and nullable value by identity", () => {
    for (const outputFormat of schema.properties.outputFormat.enum) {
      const args = { outputFormat, pageCount: 1, nullable: null };
      expect(apply(args)).toEqual({ args });
      expect(apply(args).args).toBe(args);
    }
  });

  it("composes spelling, enum, numeric and optional-null rules without mutating input; is idempotent", () => {
    const args = Object.freeze({ "OUTPUT-FORMAT": "PLAIN_TEXT", "page count": "2", note: null, nullable: null });
    const result = apply(args);
    expect(result.args).toEqual({ outputFormat: "plainText", pageCount: 2, nullable: null });
    expect(isNormalFormWitness(result.witness)).toBe(true);
    expect(result.witness?.rules).toEqual(expect.arrayContaining([
      { kind: "key-form", key: "outputFormat" }, { kind: "enum-form", key: "outputFormat" },
      { kind: "numeric-string", key: "pageCount" }, { kind: "optional-null", key: "note" },
    ]));
    expect(apply(result.args).args).toBe(result.args);
    expect(apply(result.args).witness).toBeUndefined();
  });

  it.each(["01", "1.0", " 1", "+1", "1e0", "-0", "Infinity", "NaN", "9007199254740993", "0", "101", "1.5"])("refuses lossy or schema-invalid numeric encoding %s", pageCount => {
    const args = { outputFormat: "PDF", pageCount };
    expect(apply(args).args).toBe(args);
    expect(apply(args).witness).toBeUndefined();
  });

  it.each([
    { outputFormat: "pdf", "OUTPUT-FORMAT": "pdf", pageCount: "2" },
    { "output-format": "pdf", "OUTPUT_FORMAT": "html", pageCount: "2" },
    { outputFormat: "PDF", pageCount: "2", unexpected: true },
    { outputFormat: null, pageCount: "2" },
  ])("rolls back entire invalid/conflicting candidates %j", args => {
    expect(apply(args).args).toBe(args);
    expect(apply(args).witness).toBeUndefined();
  });

  it("accepts lossless finite numeric strings, omits undefined optionals, and respects nullable/required null", () => {
    const numeric = { type: "object", additionalProperties: false, required: ["value"], properties: { value: { type: "number" }, optional: { type: "string" } } };
    const p = deriveNormalFormPlan(ref, numeric)!;
    for (const value of ["0", "-1", "1.5", "1e+21", "0.000001"]) {
      expect(applyNormalFormPlan(ref, numeric, { value, optional: undefined }, p).args).toEqual({ value: Number(value) });
    }
    const requiredNull = { value: null };
    expect(applyNormalFormPlan(ref, numeric, requiredNull, p).args).toBe(requiredNull);
  });

  it("bounds derivation by ref, key and rule counts", () => {
    expect(deriveNormalFormPlan("", schema)).toBeUndefined();
    expect(deriveNormalFormPlan("x".repeat(1025), schema)).toBeUndefined();
    expect(deriveNormalFormPlan(ref, { ...schema, properties: { ["x".repeat(129)]: { type: "number" } } })).toBeUndefined();
    const properties = Object.fromEntries(Array.from({ length: MAX_NORMAL_FORM_RULES }, (_, i) => [`key${i}`, { type: "number" }]));
    expect(deriveNormalFormPlan(ref, { ...schema, required: [], properties })!.rules.length).toBeLessThanOrEqual(MAX_NORMAL_FORM_RULES);
    expect(deriveNormalFormPlan(ref, { ...schema, properties: { ...properties, extra: { type: "number" } } })).toBeUndefined();
  });

  it("does not resolve ambiguous key or enum forms", () => {
    const ambiguous = { type: "object", additionalProperties: false, required: ["mode"], properties: {
      mode: { type: "string", enum: ["foo-bar", "foo_bar", "pdf"] },
      someKey: { type: "string" }, "some-key": { type: "string" },
    } };
    const p = deriveNormalFormPlan(ref, ambiguous)!;
    for (const args of [{ mode: "FOO BAR" }, { mode: "pdf", SOME_KEY: "x" }]) {
      expect(applyNormalFormPlan(ref, ambiguous, args, p).args).toBe(args);
    }
    expect(applyNormalFormPlan(ref, ambiguous, { mode: "foo-bar" }, p).witness).toBeUndefined();
  });

  it("rejects forged plans, wrong refs and live schema drift rather than partially applying", () => {
    const args = { outputFormat: "PDF", pageCount: "2" };
    const forged: NormalFormPlan[] = [
      { ...plan, baseSchemaDigest: "0".repeat(64) },
      { ...plan, rules: plan.rules.slice(1) },
      { ...plan, rules: [...plan.rules, { kind: "numeric-string", key: "outputFormat" }] },
      { ...plan, ref: "other.action" },
    ];
    for (const p of forged) expect(applyNormalFormPlan(ref, schema, args, p).args).toBe(args);
    const drift = { ...schema, required: [...schema.required, "note"] };
    expect(provesNormalFormPlan(plan, drift)).toBe(false);
    expect(applyNormalFormPlan(ref, drift, args, plan).args).toBe(args);
    expect(applyNormalFormPlan(ref, schema, args).args).toBe(args);
  });

  it.each(["__proto__", "constructor", "prototype"])("refuses unsafe schema/plan keys and never pollutes through %s", key => {
    const unsafe = { ...schema, properties: { ...schema.properties, [key]: { type: "string" } } };
    expect(deriveNormalFormPlan(ref, unsafe)).toBeUndefined();
    expect(isNormalFormPlan({ ...plan, rules: [{ kind: "key-form", key }] })).toBe(false);
    const args = JSON.parse(`{"outputFormat":"PDF","pageCount":"2","${key}":{"polluted":true}}`);
    expect(apply(args).args).toBe(args);
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it("validates bounded plan and witness wire shapes", () => {
    const witness = apply({ outputFormat: "PDF", pageCount: "2" }).witness!;
    for (const invalid of [null, {}, { ...plan, version: 2 }, { ...plan, extra: true }, { ...plan, ref: "" }, { ...plan, rules: [] }, { ...plan, rules: Array(MAX_NORMAL_FORM_RULES + 1).fill(plan.rules[0]) }]) expect(isNormalFormPlan(invalid)).toBe(false);
    for (const invalid of [null, {}, { ...witness, extra: true }, { ...witness, beforeShape: "invalid" }, { ...witness, rules: [] }]) expect(isNormalFormWitness(invalid)).toBe(false);
  });

  it("counts actual witnesses without manufacturing subsequent successes", () => {
    const normalization = apply({ outputFormat: "PDF", pageCount: 2 }).witness!;
    expect(normalFormEvidenceSummary([{ operations: [
      { ref, args: {}, outcome: "succeeded", normalization },
      { ref, args: {}, outcome: "failed", normalization },
      { ref, args: {}, outcome: "aborted", normalization },
      { ref, args: {}, outcome: "timed_out", normalization },
      { ref, args: {}, outcome: "succeeded" },
      { ref, args: {}, outcome: "succeeded", normalization: { ...normalization, beforeShape: "invalid" } },
    ] }])).toEqual({ normalizedCalls: 4, rulesApplied: 4, succeeded: 1, subsequentFailures: 3 });
    expect(normalFormEvidenceSummary([]).normalizedCalls).toBe(0);
  });
});

describe("active normalizer", () => {
  it("is explicitly disableable and clearing restores identity", () => {
    const args = { outputFormat: "PDF", pageCount: "2" };
    expect(normalizeActiveArguments(ref, schema, args).args).toBe(args);
    const file = { ...emptyCompiledSurface(), normalizations: [plan] };
    setActiveCompiledSurface(file);
    expect(normalizeActiveArguments(ref, schema, args).args).toEqual({ outputFormat: "pdf", pageCount: 2 });
    setActiveCompiledSurface(file, false);
    expect(normalizeActiveArguments(ref, schema, args).args).toBe(args);
    setActiveCompiledSurface(undefined, true);
    expect(normalizeActiveArguments(ref, schema, args).witness).toBeDefined();
    clearActiveCompiledSurface();
    expect(normalizeActiveArguments(ref, schema, args).args).toBe(args);
  });

  it("keeps declaration/discovery identity even with legacy restrictions and refuses forged stored plans", () => {
    const file = { ...emptyCompiledSurface(), version: 1 as const, actions: [{ ref, inputSchema: {}, baseSchemaDigest: plan.baseSchemaDigest }], quarantined: [{ ref, baseSchemaDigest: plan.baseSchemaDigest }] };
    setActiveCompiledSurface(file);
    expect(effectiveInputSchema(ref, schema)).toBe(schema);
    expect(activeQuarantinedRefNames()).toEqual(new Set());
    expect(isActiveQuarantine("demo", "render", schema)).toBe(false);
    const args = { outputFormat: "PDF", pageCount: "2" };
    setActiveCompiledSurface({ ...emptyCompiledSurface(), normalizations: [{ ...plan, rules: plan.rules.slice(1) }] });
    expect(normalizeActiveArguments(ref, schema, args).args).toBe(args);
    setActiveCompiledSurface({ ...emptyCompiledSurface(), normalizations: [plan] });
    expect(normalizeActiveArguments(ref, { ...schema, required: [...schema.required, "note"] }, args).args).toBe(args);
    // A newly discovered action can use static derivation without a stored plan.
    expect(normalizeActiveArguments("demo.new", schema, args).witness).toBeDefined();
  });
});
