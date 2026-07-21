---
name: fabric-rlm
description: Recursively decomposes oversized tasks into bounded child Pi agents with fresh context windows. Use for whole-repo audits, massive-context analysis, and multi-file refactors that do not fit one context.
disable-model-invocation: true
---

# Fabric Recursive Decomposition

Use recursion for context size, not mere difficulty. If the relevant material fits one context, work directly. Otherwise use one `fabric_exec` program to size up → orient → delegate bounded chunks → combine.

`rlm.query()` is `agents.run({ runner: "pi", recursive: true })`: each child gets a fresh context and may recurse up to `subagents.maxDepth`. Use plain `agent()` for leaves that do not need recursion.

```ts
await workflow.configure({
  name: "Recursive decomposition",
  description: "Size up, delegate bounded subtasks, combine",
});

await phase("Orient", { total: 1 });
const scope = await agent<{ paths: string[] }>(
  `Identify only the files relevant to this task.\n\nTask:\n${π.task}`,
  {
    label: "scope",
    tools: ["read", "grep", "find", "ls"],
    schema: {
      type: "object",
      properties: { paths: { type: "array", items: { type: "string" } } },
      required: ["paths"],
      additionalProperties: false,
    },
  },
);

await phase("Decompose", { total: scope.paths.length });
const findings = await parallel(
  scope.paths.map((path) => () =>
    rlm.query({
      task: `Analyze ${path} for this objective; return concrete evidence.\n\nObjective:\n${π.task}`,
      name: `analyze ${path}`.slice(0, 50),
      tools: ["read", "grep", "find", "ls"],
    }),
  ),
  { concurrency: 4 },
);

await phase("Combine", { total: 1 });
return agent(
  `Deduplicate, reconcile, and synthesize these findings; drop unsupported claims:\n${JSON.stringify(findings)}`,
  { label: "combine", tools: ["read", "grep", "find", "ls"] },
);
```

Guardrails:

- Size scope before spawning; deeper children should make fewer calls and act more directly.
- Partition edit ownership by path or use `worktree: true`; concurrent children must not edit the same files.
- `maxDepth`, `maxPerExecution`, `budgetUsd`, and top-level token/agent budgets bound the tree. Concurrent children can slightly overshoot a best-effort spend check.
- Initial approval delegates only agent risk; network, execution, and write approvals are not inherited.
- Stop spawning when a returned budget summary is low. Redirect a valuable drifting child with `agents.steer` rather than discarding its context.
