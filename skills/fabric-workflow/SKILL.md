---
name: fabric-workflow
description: Runs a dynamic Pi Fabric workflow with code-held phases, fan-out, pipelines, structured agents, and best-effort verification. Use for large audits, migrations, parallel research, or explicit workflow requests.
disable-model-invocation: true
---

# Fabric Dynamic Workflow

Put the complete loop, phases, and branches in one type-checked `fabric_exec` program. Pass the objective as `strings.task`.

Core surfaces:

- `agent(prompt, { label, tools?, schema?, ... })` for a bounded worker; label every call.
- `parallel(thunks, { concurrency })` for fan-out; pass functions, not promises.
- `pipeline(items, ...stages)` for sequential stages per item with cross-item concurrency.
- `workflow.configure`, `phase`, `workflow.item`, `workflow.event`, and `workflow.log` for dashboard progress.
- `workflow.budget` plus top-level `agentBudget`/`tokenBudget` for bounded runs.

Use JSON Schema when machine-readable output makes aggregation safer. A reliable shape is discover → analyze in checked batches → verify available findings:

```ts
type WorkOutcome =
  | { item: string; status: "completed"; finding: string }
  | { item: string; status: "failed" | "not_started"; error: string };

await workflow.configure({
  name: "Request analysis",
  description: "Discover, analyze, and verify bounded work items",
});
await phase("Discover", { total: 1 });
const inventory = await agent<{ items: string[] }>(
  `Discover the bounded work items for this objective.\n\nObjective:\n${π.task}`,
  {
    label: "inventory",
    tools: ["read", "grep", "find", "ls"],
    schema: {
      type: "object",
      properties: {
        items: { type: "array", maxItems: 32, items: { type: "string" } },
      },
      required: ["items"],
      additionalProperties: false,
    },
  },
);
const items = [...new Set(inventory.items.map((item) => item.trim()).filter(Boolean))];
if (items.length === 0) {
  return {
    status: "success",
    coverage: { requested: 0, completed: 0 },
    failures: [],
    result: "No bounded work items were found.",
  };
}

await phase("Analyze", { total: items.length });
const outcomes: WorkOutcome[] = [];
const batchSize = 8;
for (let offset = 0; offset < items.length; offset += batchSize) {
  const batch = items.slice(offset, offset + batchSize);
  const settled = await parallel(
    batch.map((item) => async (): Promise<WorkOutcome> => {
      try {
        const finding = await agent(
          `Analyze this bounded item with evidence: ${item}\n\nObjective:\n${π.task}`,
          {
            label: `analyze ${item}`.slice(0, 50),
            tools: ["read", "grep", "find", "ls"],
          },
        );
        return { item, status: "completed", finding };
      } catch (error) {
        return {
          item,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
    { concurrency: batch.length },
  );
  outcomes.push(...settled);
  if (settled.every((outcome) => outcome.status === "failed")) {
    outcomes.push(...items.slice(offset + batch.length).map((item): WorkOutcome => ({
      item,
      status: "not_started",
      error: "not started after an all-failed batch",
    })));
    break;
  }
}

const completed = outcomes.filter(
  (outcome): outcome is Extract<WorkOutcome, { status: "completed" }> =>
    outcome.status === "completed",
);
const failures = outcomes.filter(
  (outcome): outcome is Extract<WorkOutcome, { status: "failed" | "not_started" }> =>
    outcome.status !== "completed",
);
const coverage = { requested: items.length, completed: completed.length };
if (completed.length === 0) {
  return { status: "failed", coverage, failures, result: null };
}

await phase("Verify", { total: 1 });
try {
  const result = await agent(
    `Adversarially verify only these completed findings, remove unsupported claims, and do not infer anything about failed items.\n\nObjective:\n${π.task}\n\nFindings:\n${JSON.stringify(completed)}`,
    { label: "verify synthesis", tools: ["read", "grep", "find", "ls"] },
  );
  await workflow.event({ message: "Verification complete", level: "success" });
  return {
    status: failures.length === 0 ? "success" : "partial",
    coverage,
    failures,
    result,
  };
} catch (error) {
  return {
    status: "partial",
    coverage,
    failures,
    result: null,
    verificationError: error instanceof Error ? error.message : String(error),
    fallback: completed,
  };
}
```

Adapt phases and tools to the request. For edits, partition path ownership or use `worktree: true`; never let concurrent workers edit the same files. Successful verification returns compact output; raw findings return only if verification fails. `partial` is usable and must not trigger an automatic whole-workflow rerun—retry only failed items when their coverage matters.

Use `agents.spawn` plus `status`/`steer` instead of blocking `agent()` only when a valuable long-running worker must be observed and redirected between turns. Inventory is capped and checked batches stop new work after a systemic all-failed batch. Concurrent calls can still overshoot observational budgets because usage settles afterward.
