import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Cross-process cost budget ledger for a Fabric recursion tree.
 *
 * A recursion tree spans one Pi process per node. Each node's AgentManager
 * records the cost of the children it spawns into a single append-only JSONL
 * file, and checks the accumulated spend before spawning another child. The
 * ledger path and budget travel to descendants through PI_FABRIC_BUDGET*
 * environment variables, which the worker forwards to child Pi processes via
 * `{ ...process.env }`.
 *
 * This mirrors ypi's RLM_BUDGET / RLM_COST_FILE model: the check is best-effort
 * (concurrent children can each pass the check before any cost lands, so a tree
 * may slightly overshoot), while the race-free ceiling remains the per-execution
 * call count (agents.maxPerExecution). Cost is recorded only after a child
 * finishes, matching ypi's append-after-completion semantics.
 */

export interface BudgetLedgerEntry {
  id: string;
  depth: number;
  cost: number;
  tokens: number;
  ts: number;
}

export interface BudgetLedgerSummary {
  cost: number;
  tokens: number;
}

export interface BudgetLedgerState {
  budget: number;
  file: string;
  id: string;
}

const ENV_BUDGET = "PI_FABRIC_BUDGET";
const ENV_BUDGET_FILE = "PI_FABRIC_BUDGET_FILE";
const ENV_BUDGET_ID = "PI_FABRIC_BUDGET_ID";

const parseFloatFinite = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/**
 * Read the active budget state inherited from the recursion-tree root.
 * Returns undefined when no budget is active for this process.
 */
export function activeBudgetState(): BudgetLedgerState | undefined {
  const file = process.env[ENV_BUDGET_FILE];
  const budget = parseFloatFinite(process.env[ENV_BUDGET]);
  if (!file || budget === undefined || budget <= 0) return undefined;
  return { budget, file, id: process.env[ENV_BUDGET_ID] ?? "" };
}

/**
 * Initialize a shared ledger for a recursion tree and seed the environment
 * variables that descendants inherit. Only call at the tree root (depth 0)
 * when no budget has been inherited and a positive budget is configured.
 */
export function initBudgetLedger(budget: number): BudgetLedgerState {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-budget-"));
  const file = path.join(directory, "cost.jsonl");
  fs.writeFileSync(file, "", { mode: 0o600 });
  const id = randomUUID().replaceAll("-", "").slice(0, 16);
  process.env[ENV_BUDGET] = String(budget);
  process.env[ENV_BUDGET_FILE] = file;
  process.env[ENV_BUDGET_ID] = id;
  return { budget, file, id };
}

/**
 * Clear the budget environment variables seeded by initBudgetLedger. Called by
 * the owning (depth-0) manager on close so a long-lived host process does not
 * leak an active budget into a later, unrelated session.
 */
export function clearOwnedBudgetEnv(): void {
  delete process.env[ENV_BUDGET];
  delete process.env[ENV_BUDGET_FILE];
  delete process.env[ENV_BUDGET_ID];
}

/**
 * Sum the append-only ledger. Malformed lines are tolerated, matching ypi's
 * rlm_cost parser: a single bad entry must not abort the whole read.
 */
export function readBudgetLedger(file: string): BudgetLedgerSummary {
  let cost = 0;
  let tokens = 0;
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { cost, tokens };
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Partial<BudgetLedgerEntry>;
      cost += Number(parsed.cost) || 0;
      tokens += Number(parsed.tokens) || 0;
    } catch {
      // Ignore malformed cost lines; the ledger is best-effort.
    }
  }
  return { cost, tokens };
}

/**
 * Append a child's incurred cost to the shared ledger. O_APPEND makes small
 * single-line writes atomic across concurrent writers on POSIX, which is
 * sufficient because each manager appends one entry after a child settles.
 */
export function appendBudgetLedger(file: string, entry: BudgetLedgerEntry): void {
  try {
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch {
    // A ledger write failure must not break the agent run; the next check
    // still guards against runaway spend via the per-execution call ceiling.
  }
}
