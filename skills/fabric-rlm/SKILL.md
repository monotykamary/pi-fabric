---
name: fabric-rlm
description: Recursively decomposes a large task by delegating bounded subtasks to child Pi agents via rlm.query(), where each child gets a fresh context window and can itself recurse. Use for tasks too big for one context window — whole-repo audits, massive-context analysis, multi-file refactors.
disable-model-invocation: true
---

# Fabric Recursive Decomposition (RLM)

Inspired by Recursive Language Models: an LLM with a sub-call function can recursively decompose problems by self-delegation. `rlm.query()` is `agents.run()` with `recursive: true` — it spawns a child Pi agent with a fresh context window that can call `rlm.query()` again, bounded by `subagents.maxDepth`.

Recurse not because a task is hard, but because it is too big for one context window. Each child gets a fresh context budget; you get back only its compact answer instead of all the raw material.

## Core pattern: size up → search → delegate → combine

1. **Size up** — `wc -l`, `wc -c`, file counts, grep scope. If it fits one context window, do it directly; do not delegate.
2. **Search** — `grep`, `find`, `ls`, `read` to orient before delegating.
3. **Delegate** — hand clear, bounded subtasks to children. Use `rlm.query()` when the child should be able to recurse again; use `agent()` for a one-shot leaf worker that does not need to recurse.
4. **Combine** — aggregate, deduplicate, resolve conflicts, produce the final output.
5. **Do it directly when it's small** — never delegate what you can do in one step.

## One fabric_exec program

Turn the request into a single type-checked `fabric_exec` program. The program holds the decomposition loop and branches. Pass the root task through `strings.task`.

```ts
await workflow.configure({
  name: "Recursive decomposition",
  description: "Size up, delegate bounded subtasks, combine",
});

// Size up and orient with read-only tools before delegating.
await phase("Orient", { total: 1 });
const scope = await agent<{ paths: string[] }>(
  `Identify the bounded set of files relevant to this task. Return structured output.\n\nTask:\n${π.task}`,
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

// Delegate each bounded subtask to a recursive child. Each child gets a fresh
// context window and may call rlm.query() again up to subagents.maxDepth.
await phase("Decompose", { total: scope.paths.length });
const findings = await parallel(
  scope.paths.map((p) => () =>
    rlm.query({
      runner: "pi",
      task: `Analyze ${p} for this objective and report concrete, bounded findings.\n\nObjective:\n${π.task}`,
      name: `analyze ${p}`.slice(0, 50),
      tools: ["read", "grep", "find", "ls"],
    }),
  ),
  { concurrency: 4 },
);

await phase("Combine", { total: 1 });
const summary = await agent(
  `Synthesize these independent findings into one compact result. Drop unsupported claims and resolve conflicts:\n${JSON.stringify(findings)}`,
  { label: "combine", tools: ["read", "grep", "find", "ls"] },
);
return summary;
```

Adapt the phases, tools, and fan-out to the request. Use `schema` on a worker when machine-readable output makes aggregation safer.

## When to recurse vs do it directly

- A 30-line file or a single function: read it and act directly. No delegation.
- A multi-file refactor: delegate per file or per module and combine.
- A whole-repo audit or massive-context analysis: size up first, fan out bounded subtasks, then synthesize.

## Guardrails

- `subagents.maxDepth` bounds recursion depth; `subagents.budgetUsd` optionally bounds total USD spend across the whole tree (0 disables it).
- When a budget is active, each recursive result carries a `budget` summary (`limit`, `spent`, `remaining`, `tokens`). Stop spawning children when `remaining` is low and finish the remaining work directly.
- Approving the initial recursive call delegates only the `agent` risk capability to children; network, execution, and write approvals are not inherited. Give children edit tools only when they must change files.
- Deeper children should be more conservative: fewer sub-calls, more direct action. Teach the pattern once — size-first → search → chunk → delegate → combine — and let it repeat at every depth.
- For edits, partition ownership by path or set `worktree: true`; never let concurrent recursive children edit the same files.
- The pre-spawn budget check is best-effort (concurrent children can overshoot slightly); the race-free ceiling is `subagents.maxPerExecution`.
- A recursive child that drifts can be redirected without losing its context: `agents.steer({ id, message })` is delivered between the child's turns (after its current tool calls, before the next LLM call), and `agents.status({ id }).pendingMessages` shows the queued steers. Prefer steering over abandoning a child that has accumulated useful context. See the `agents` reference.
