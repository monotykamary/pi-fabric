import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  activeBudgetState,
  appendBudgetLedger,
  clearOwnedBudgetEnv,
  initBudgetLedger,
  readBudgetLedger,
} from "../src/agents/budget-ledger.js";

const temporaryFiles: string[] = [];

afterEach(() => {
  clearOwnedBudgetEnv();
  for (const file of temporaryFiles.splice(0)) {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

describe("budget ledger", () => {
  it("reports no active budget by default", () => {
    expect(activeBudgetState()).toBeUndefined();
  });

  it("initializes a ledger and round-trips through the environment", () => {
    const state = initBudgetLedger(0.25);
    temporaryFiles.push(state.file);
    expect(state.budget).toBe(0.25);
    expect(fs.existsSync(state.file)).toBe(true);
    const inherited = activeBudgetState();
    expect(inherited).toBeDefined();
    expect(inherited?.budget).toBe(0.25);
    expect(inherited?.file).toBe(state.file);
    expect(inherited?.id).toBe(state.id);
  });

  it("treats a non-positive budget as inactive", () => {
    process.env.PI_FABRIC_BUDGET = "0";
    process.env.PI_FABRIC_BUDGET_FILE = "/tmp/ignored";
    process.env.PI_FABRIC_BUDGET_ID = "x";
    try {
      expect(activeBudgetState()).toBeUndefined();
    } finally {
      clearOwnedBudgetEnv();
    }
  });

  it("sums appended entries and tolerates malformed lines", () => {
    const state = initBudgetLedger(1);
    temporaryFiles.push(state.file);
    appendBudgetLedger(state.file, {
      id: "a",
      depth: 1,
      cost: 0.06,
      tokens: 30,
      ts: 1,
    });
    appendBudgetLedger(state.file, {
      id: "b",
      depth: 2,
      cost: 0.04,
      tokens: 70,
      ts: 2,
    });
    fs.appendFileSync(state.file, "not json\n\n");
    const summary = readBudgetLedger(state.file);
    expect(summary.cost).toBeCloseTo(0.1);
    expect(summary.tokens).toBe(100);
  });

  it("returns zero for a missing ledger file", () => {
    expect(readBudgetLedger(path.join(os.tmpdir(), "pi-fabric-missing-cost.jsonl"))).toEqual({
      cost: 0,
      tokens: 0,
    });
  });
});
