---
name: fabric-workflow
description: Runs a dynamic Pi Fabric workflow with code-held phases, fan-out, pipelines, structured agents, and synthesis. Use for large audits, migrations, parallel research, or explicit workflow requests.
disable-model-invocation: true
---

# Fabric Dynamic Workflow

Put the complete loop, phases, and branches in one type-checked `fabric_exec` program.

Core surfaces:

- `agent(prompt, { label, tools?, schema?, ... })` for a bounded worker; label every call.
- `parallel(thunks, { concurrency })` for fan-out; pass functions, not promises.
- `pipeline(items, ...stages)` for sequential stages per item with cross-item concurrency.
- `workflow.configure`, `phase`, `workflow.item`, `workflow.event`, and `workflow.log` for dashboard progress.
- `workflow.budget` plus top-level `agentBudget`/`tokenBudget` for bounded runs.

Use JSON Schema when machine-readable output makes aggregation safer. A reliable shape is discover → analyze in parallel → adversarially verify:

```ts
await workflow.configure({
  name: "Request analysis",
  description: "Discover, analyze, and verify bounded work items",
});

await phase("Discover", { total: 1 });
const inventory = await agent<{ items: string[] }>(
  "Discover the bounded work items. Return structured output.",
  {
    label: "inventory",
    tools: ["read", "grep", "find", "ls"],
    schema: {
      type: "object",
      properties: { items: { type: "array", items: { type: "string" } } },
      required: ["items"],
      additionalProperties: false,
    },
  },
);

await phase("Analyze", { total: inventory.items.length });
const findings = await parallel(
  inventory.items.map((item) => () =>
    agent(`Analyze this bounded item with evidence: ${item}`, {
      label: `analyze ${item}`.slice(0, 50),
      tools: ["read", "grep", "find", "ls"],
    }),
  ),
  { concurrency: 8 },
);

await phase("Verify", { total: 1 });
const result = await agent(
  `Adversarially verify these findings, remove unsupported claims, and synthesize:\n${JSON.stringify(findings)}`,
  { label: "verify synthesis", tools: ["read", "grep", "find", "ls"] },
);
await workflow.event({ message: "Verification complete", level: "success" });
return result;
```

Adapt phases and tools to the request. For edits, partition path ownership or use `worktree: true`; never let concurrent workers edit the same files. Include a verifier when conclusions combine multiple workers. Use `agents.spawn` plus `status`/`steer` instead of blocking `agent()` only when a valuable long-running worker must be observed and redirected between turns.
