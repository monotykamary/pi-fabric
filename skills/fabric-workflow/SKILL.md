---
name: fabric-workflow
description: Runs a Claude Code-style dynamic workflow in Pi Fabric using code-held phases, fan-out, pipelines, structured agents, and synthesis. Use for large audits, migrations, parallel research, or explicit workflow requests.
---

# Fabric Dynamic Workflow

Turn the request into one type-checked `fabric_exec` program. The program, not the parent context, must hold the loop, branches, and intermediate results.

Use these globals:

- `workflow.agent(prompt, options)` or `agent(...)` for one worker. Set `label` on every call.
- `workflow.parallel(thunks, { concurrency })` or `parallel(...)` for fan-out. Pass functions, not promises.
- `workflow.pipeline(items, ...stages)` or `pipeline(...)` for per-item sequential stages with cross-item concurrency.
- `workflow.phase(name)` or `phase(name)` for progress groups.
- `workflow.log(...)` for compact progress notes.
- `workflow.budget` for token-budget observations.

Use `schema` in agent options when machine-readable output will make aggregation safer. It is ordinary JSON Schema.

A good shape is:

```ts
await phase("Discover");
const inventory = await agent<{ items: string[] }>(
  "Discover the bounded work items for this request. Return structured output.",
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

await phase("Analyze");
const findings = await parallel(
  inventory.items.map((item) => () =>
    agent(`Analyze this bounded item and report evidence: ${item}`, {
      label: `analyze ${item}`.slice(0, 50),
      tools: ["read", "grep", "find", "ls"],
    }),
  ),
  { concurrency: 8 },
);

await phase("Verify");
const result = await agent(
  `Adversarially verify and synthesize these findings. Remove unsupported claims:\n${JSON.stringify(findings)}`,
  { label: "verify synthesis", tools: ["read", "grep", "find", "ls"] },
);

return { ok: true, result };
```

Adapt the phases and worker tools to the request. For edits, partition ownership by path or use `worktree: true`; never have concurrent agents edit the same files. Include a final verifier or synthesizer when conclusions come from multiple workers. Set `agentBudget` and `tokenBudget` on `fabric_exec` when the requested scale is potentially large.

Return only the compact final artifact and meaningful failures. Do not paste every intermediate transcript into the parent context.
