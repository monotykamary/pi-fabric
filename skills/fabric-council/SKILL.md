---
name: fabric-council
description: Runs a bounded multi-perspective Pi Fabric council with independent reviewers and an optional synthesis decision. Use for architecture choices, plans, reviews, and adversarial cross-checking.
---

# Fabric Council

Use one `fabric_exec` call and `council.run()`. Choose roles that disagree usefully rather than duplicating one another.

```ts
const decision = await council.run({
  task: π.task,
  roles: JSON.parse(π.roles),
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
