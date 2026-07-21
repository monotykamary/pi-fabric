---
name: fabric-council
description: Runs a bounded multi-perspective Pi Fabric council with independent reviewers and optional synthesis. Use for architecture choices, plans, reviews, and adversarial cross-checking.
disable-model-invocation: true
---

# Fabric Council

Use one `fabric_exec` call and `council.run()`. Choose three to five roles that disagree usefully rather than duplicating one another, such as correctness, security, operability, maintainability, and requirements skepticism.

```ts
const roles = JSON.parse(π.roles) as string[];
await workflow.configure({
  name: "Council review",
  description: `${roles.length} independent perspectives with synthesis`,
});
await phase("Deliberate", { total: roles.length });
return council.run({
  task: π.task,
  roles,
  tools: ["read", "grep", "find", "ls"],
  synthesize: true,
});
```

Pass the task and roles through `strings`. Members inspect evidence independently; synthesis must preserve material disagreement, reject unsupported claims, and make a concrete recommendation. Use `synthesize: false` only for raw opinions.

A council costs N concurrent role agents plus one sequential synthesizer and must fit `executor.timeoutMs`; its usage counts toward the execution budget. Keep roles bounded and set top-level `agentBudget`/`tokenBudget` for large runs. Do not use a council for a simple lookup or a decision with no meaningful competing considerations.
