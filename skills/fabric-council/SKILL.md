---
name: fabric-council
description: Runs a bounded multi-perspective Pi Fabric council with independent reviewers and an optional synthesis decision. Use for architecture choices, plans, reviews, and adversarial cross-checking.
disable-model-invocation: true
---

# Fabric Council

Use one `fabric_exec` call and `council.run()`. Choose roles that disagree usefully rather than duplicating one another.

A council runs N role agents concurrently plus a sequential synthesizer, all inside the single `fabric_exec` sandbox. The sandbox has a hard wall-clock ceiling (`executor.timeoutMs`, default 120s; raise it in `fabric.json` or `/fabric` settings for read-heavy councils). Keep roles and per-role tool work bounded so `max(role durations) + synthesizer` fits the ceiling, or the sandbox times out and aborts every in-flight agent. Council and `rlm.query` usage counts toward `budget.spent()` and the `tokenBudget` guard.

```ts
const roles = JSON.parse(π.roles) as string[];
await workflow.configure({
  name: "Council review",
  description: `${roles.length} independent perspectives with synthesis`,
});
await phase("Deliberate", { total: roles.length });
const decision = await council.run({
  task: π.task,
  roles,
  tools: ["read", "grep", "find", "ls"],
  synthesize: true,
});
return decision;
```

Pass the full task and role array through `strings`. Usually use three to five roles. Examples:

- implementation correctness reviewer
- security and abuse-case reviewer
- test and operability reviewer
- simplicity and maintenance reviewer
- user-requirements skeptic

Council members must inspect evidence independently. The synthesizer must preserve material disagreement, reject unsupported claims, and make a concrete recommendation. Use `synthesize: false` only when the user asked for raw independent opinions.

Do not use a council for a simple lookup or a decision with no meaningful competing considerations.

For a long-running deliberation where a member drifts, you can run members with `agents.spawn` and redirect one between its turns via `agents.steer({ id, message })` instead of `council.run`'s blocking fan-out; `agents.status({ id }).pendingMessages` shows the queued steers. See the `agents` reference.
