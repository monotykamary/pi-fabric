---
name: fabric-council
description: Runs a bounded multi-perspective Pi Fabric council with independent reviewers and best-effort synthesis. Use for architecture choices, plans, reviews, and adversarial cross-checking.
disable-model-invocation: true
---

# Fabric Council

Use one `fabric_exec` call with bounded role fan-out. Choose three to five roles that disagree usefully rather than duplicating one another, such as correctness, security, operability, maintainability, and requirements skepticism.

```ts
type CouncilOutcome =
  | { role: string; status: "completed"; report: string }
  | { role: string; status: "failed"; error: string };

const roles = [...new Set(
  (JSON.parse(π.roles) as string[]).map((role) => role.trim()).filter(Boolean),
)];
if (roles.length < 3 || roles.length > 5) {
  throw new Error("Council requires 3–5 distinct non-empty roles.");
}
await workflow.configure({
  name: "Council review",
  description: `${roles.length} independent perspectives with best-effort synthesis`,
});
await phase("Deliberate", { total: roles.length + 1 });
const outcomes = await parallel(
  roles.map((role) => async (): Promise<CouncilOutcome> => {
    try {
      const report = await agent(
        `Act as the ${role} council member. Independently analyze this task:\n\n${π.task}`,
        { label: role, tools: ["read", "grep", "find", "ls"] },
      );
      return { role, status: "completed", report };
    } catch (error) {
      return {
        role,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }),
  { concurrency: roles.length },
);
const completed = outcomes.filter(
  (outcome): outcome is Extract<CouncilOutcome, { status: "completed" }> =>
    outcome.status === "completed",
);
const failures = outcomes.filter(
  (outcome): outcome is Extract<CouncilOutcome, { status: "failed" }> =>
    outcome.status === "failed",
);
const coverage = { requested: roles.length, completed: completed.length };
if (completed.length === 0) {
  return { status: "failed", coverage, failures, result: null };
}
if (completed.length === 1) {
  return {
    status: "partial",
    coverage,
    failures,
    result: completed[0].report,
    synthesisSkipped: "Only one role completed; another agent would add no diversity.",
  };
}

try {
  const result = await agent(
    `Synthesize these completed reports into one decision. Reject unsupported claims, preserve material disagreements, attribute each concern to its role. Do not infer the views of failed roles.\n\nTask:\n${π.task}\n\nReports:\n${JSON.stringify(completed)}`,
    { label: "council synthesis", tools: ["read", "grep", "find", "ls"] },
  );
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
    synthesisError: error instanceof Error ? error.message : String(error),
    fallback: completed,
  };
}
```

Pass the task as `strings.task` and the JSON role array as `strings.roles`. Successful synthesis returns only the compact decision, coverage, and failures. Raw completed reports return only when synthesis fails; one surviving role returns directly without spending another agent call.

Concurrent calls can overshoot an observational `tokenBudget` because usage settles afterward. Reserve at least `roles.length + 1` top-level agent calls when synthesis may run, and use a finite role set rather than relying on token accounting as a hard concurrent ceiling.

Status is `success`, `partial`, or `failed`. A partial result is usable evidence with named gaps and must not trigger an automatic whole-council rerun. If a missing perspective matters, retry that role with one plain agent using the original task and role; do not invoke a new council or rerun successful roles. Do not use a council for a lookup or a decision with no meaningful competing considerations.
