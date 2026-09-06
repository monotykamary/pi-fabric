import { afterEach, describe, expect, it } from "vitest";
import { repairCatalogInput, validateCatalogArgs } from "../src/core/action-arguments.js";
import { boundedPreviewValue, boundedResult, failedResultError, failedResultOutcome, previewArgs, previewResult } from "../src/core/action-result.js";
import { setActiveRepairCompiler } from "../src/repairs/active.js";

afterEach(() => setActiveRepairCompiler(undefined));

describe("action argument policy", () => {
  const schema = {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  };

  it("preserves valid arguments through repair and validation", () => {
    const args = { value: "ok" };
    const prepared = repairCatalogInput("demo.echo", schema, args);
    expect(prepared).toEqual({ args, observedUnexpected: undefined });
    expect(validateCatalogArgs("demo.echo", schema, prepared.args, prepared.observedUnexpected)).toEqual({ args });
  });

  it("reports unexpected property names without exposing their values", () => {
    const prepared = repairCatalogInput("demo.echo", schema, { value: "ok", typo: "private-payload" });
    expect(prepared.observedUnexpected).toBe("typo");
    const result = validateCatalogArgs("demo.echo", schema, prepared.args, prepared.observedUnexpected);
    expect(result.invalid).toContain("/typo: must not have additional properties");
    expect(result.invalid).not.toContain("private-payload");
  });
});

describe("action result policy", () => {
  it("retains the larger write-content preview and caps argument keys", () => {
    const content = "x".repeat(20_000);
    expect(previewArgs("pi.write", { content }).content).toBe(content.slice(0, 16_000) + "…");
    expect(previewArgs("demo.echo", { content }).content).toBe(content.slice(0, 2_000) + "…");
    expect(Object.keys(previewArgs("demo.echo", Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`key${i}`, i]))))).toHaveLength(32);
  });

  it("copies bounded previews and truncates oversized nested values", () => {
    const value = { nested: [1, 2] };
    expect(boundedPreviewValue(value, 100)).toEqual(value);
    expect(boundedPreviewValue(value, 100)).not.toBe(value);
    expect(boundedPreviewValue({ content: "x".repeat(500) }, 200)).toMatchObject({ fabricTruncated: true, originalChars: 514 });
    expect(previewResult("x".repeat(20_000))).toBe("x".repeat(16_000) + "…");
  });

  it("bounds serialized results but rejects non-JSON payloads", () => {
    const value = { ok: true };
    expect(boundedResult(value, 100)).toEqual({ value, chars: 11, truncated: false });
    expect(boundedResult("x".repeat(500), 256)).toEqual({ value: { fabricTruncated: true, originalChars: 502, preview: '"' + "x".repeat(55) }, chars: 502, truncated: true });
    expect(boundedResult(undefined, 100)).toEqual({ value: undefined, chars: 4, truncated: false });
    expect(() => boundedResult(1n, 100)).toThrow("non-JSON-serializable");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => boundedResult(circular, 100)).toThrow("non-JSON-serializable");
  });

  it("maps failure statuses without treating ordinary data as failures", () => {
    expect(failedResultError({ status: "completed", error: "data" })).toBeUndefined();
    expect(failedResultError({ status: "failed", error: " reason " })).toBe("reason");
    expect(failedResultError({ status: "stopped" })).toBe("Fabric action returned stopped");
    expect(failedResultOutcome({ status: "stopped" })).toBe("aborted");
    expect(failedResultOutcome({ status: "timed_out" })).toBe("timed_out");
    expect(failedResultOutcome({ status: "failed" })).toBe("failed");
  });
});
