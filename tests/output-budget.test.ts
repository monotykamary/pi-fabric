import { rm, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  boundModelOutput,
  MAX_FAILURE_MODEL_OUTPUT_CHARS,
  modelOutputBudget,
} from "../src/output-budget.js";

describe("modelOutputBudget", () => {
  it("caps failures without reducing successful or stricter configured budgets", () => {
    expect(modelOutputBudget(50_000, true)).toBe(50_000);
    expect(modelOutputBudget(50_000, false)).toBe(MAX_FAILURE_MODEL_OUTPUT_CHARS);
    expect(modelOutputBudget(10_000, false)).toBe(10_000);
  });
});

describe("boundModelOutput", () => {
  it("leaves output under budget untouched", async () => {
    const writer = vi.fn(async () => "/tmp/full.txt");
    await expect(boundModelOutput("small", 1_000, "small", writer)).resolves.toEqual({
      text: "small",
      originalChars: 5,
      omittedChars: 0,
    });
    expect(writer).not.toHaveBeenCalled();
  });

  it("bounds visible text and links the complete artifact", async () => {
    const full = `start-${"x".repeat(4_000)}-end`;
    const writer = vi.fn(async () => "/tmp/pi-fabric-output/output.txt");
    const result = await boundModelOutput(full, 1_000, full, writer);

    expect(result.text.length).toBeLessThanOrEqual(1_000);
    expect(result.text).toContain("start-");
    expect(result.text).toContain("-end");
    expect(result.text).toContain("Full output (4010 chars) saved to:");
    expect(result.artifactPath).toBe("/tmp/pi-fabric-output/output.txt");
    expect(result.omittedChars).toBeGreaterThan(0);
    expect(writer).toHaveBeenCalledWith(full);
  });
  it("never cuts the artifact path when the budget barely fits the suffix", async () => {
    const full = "x".repeat(4_000);
    const artifactPath = "/tmp/pi-fabric-output/output.txt";
    const writer = vi.fn(async () => artifactPath);
    const result = await boundModelOutput(full, 100, full, writer);

    expect(result.text.length).toBeLessThanOrEqual(100);
    expect(result.text).toContain(artifactPath);
    expect(result.artifactPath).toBe(artifactPath);
    expect(result.omittedChars).toBeGreaterThan(0);
  });


  it("persists retrievable artifacts with private POSIX permissions", async () => {
    const result = await boundModelOutput("x".repeat(4_000), 1_000);
    expect(result.artifactPath).toBeDefined();
    const info = await stat(result.artifactPath!);
    if (process.platform !== "win32") {
      expect(info.mode & 0o777).toBe(0o600);
    }
    await rm(path.dirname(result.artifactPath!), { recursive: true, force: true });
  });

  it("stays bounded if artifact persistence fails", async () => {
    const writer = vi.fn(async () => { throw new Error("disk full"); });
    const result = await boundModelOutput("x".repeat(4_000), 1_000, undefined, writer);

    expect(result.text.length).toBeLessThanOrEqual(1_000);
    expect(result.artifactPath).toBeUndefined();
    expect(result.text).toContain("characters omitted by Pi Fabric");
  });
});
