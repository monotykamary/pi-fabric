---
name: fabric-rlm
description: Recursively decomposes oversized tasks into bounded child Pi agents with fresh context windows. Use for whole-repo audits, massive-context analysis, and multi-file refactors that do not fit one context.
disable-model-invocation: true
---

# Fabric Recursive Decomposition

Use recursion for context size, not mere difficulty. If the relevant material fits one context, work directly. Otherwise pass the root task as `strings.task` and use one `fabric_exec` program to orient → delegate non-overlapping context-sized partitions → combine available results.

`rlm.query()` is `agents.run({ runner: "pi", recursive: true })`. Use plain `agent()` for a partition that fits one child context; reserve `rlm.query()` for a partition that remains oversized.

```ts
type Partition = { label: string; paths: string[]; recursive: boolean };
type RecursiveOutcome =
  | { partition: string; status: "completed"; finding: string }
  | { partition: string; paths: string[]; status: "failed" | "not_started"; error: string };

await workflow.configure({
  name: "Recursive decomposition",
  description: "Orient, delegate bounded partitions, combine available results",
});
await phase("Orient", { total: 1 });
const scope = await agent<{ partitions: Partition[] }>(
  `Partition only the material relevant to this task into at most 12 non-overlapping, context-sized groups. Set recursive=true only when one group still cannot fit a child context.\n\nTask:\n${π.task}`,
  {
    label: "scope",
    tools: ["read", "grep", "find", "ls"],
    schema: {
      type: "object",
      properties: {
        partitions: {
          type: "array",
          maxItems: 12,
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              paths: { type: "array", items: { type: "string" } },
              recursive: { type: "boolean" },
            },
            required: ["label", "paths", "recursive"],
            additionalProperties: false,
          },
        },
      },
      required: ["partitions"],
      additionalProperties: false,
    },
  },
);

const normalizePath = (raw: string) => raw.trim()
  .replace(/\\/g, "/")
  .replace(/^(?:\.\/)+/, "")
  .replace(/\/+/g, "/")
  .replace(/\/$/, "");
const proposedCount = scope.partitions.length;
const candidates: Array<{ index: number; label: string; path: string }> = [];
const preflightFailures: RecursiveOutcome[] = [];
for (const [index, partition] of scope.partitions.entries()) {
  const label = partition.label.trim() || `partition-${index + 1}`;
  const paths = partition.paths.map(normalizePath);
  const invalid = paths.length === 0 || paths.some((path) =>
    !path || path === "." || path === "~" || path.startsWith("~/") ||
    path.startsWith("/") || /^[A-Za-z]:\//.test(path) ||
    path.split("/").includes("..")
  );
  if (invalid) {
    preflightFailures.push({
      partition: label,
      paths,
      status: "not_started",
      error: "partition paths must be non-empty project-relative paths without '~' or '..'",
    });
    continue;
  }
  candidates.push(...paths.map((path) => ({ index, label, path })));
}
candidates.sort((a, b) =>
  a.path.split("/").length - b.path.split("/").length || a.path.length - b.path.length
);
const selected: Array<{ path: string; index: number }> = [];
const grouped = new Map<number, string[]>();
const promoteRecursive = new Set<number>();
const mergedOverlaps: Array<{ partition: string; path: string; coveredBy: string }> = [];
for (const candidate of candidates) {
  const coveredBy = selected.find((entry) =>
    candidate.path === entry.path || candidate.path.startsWith(`${entry.path}/`)
  );
  if (coveredBy) {
    mergedOverlaps.push({
      partition: candidate.label, path: candidate.path, coveredBy: coveredBy.path,
    });
    if (scope.partitions[candidate.index]?.recursive) {
      promoteRecursive.add(coveredBy.index);
    }
    continue;
  }
  selected.push({ path: candidate.path, index: candidate.index });
  grouped.set(candidate.index, [...(grouped.get(candidate.index) ?? []), candidate.path]);
}
const partitions = scope.partitions.flatMap((proposed, index): Partition[] => {
  const paths = grouped.get(index) ?? [];
  return paths.length === 0
    ? []
    : [{
        ...proposed,
        label: proposed.label.trim() || paths[0],
        paths,
        recursive: proposed.recursive || promoteRecursive.has(index),
      }];
});
let normalization = {
  proposed: proposedCount,
  effective: partitions.length,
  dispatched: 0,
  mergedOverlaps,
};
if (partitions.length === 0) {
  return proposedCount === 0
    ? {
        status: "success",
        coverage: { requested: 0, dispatched: 0, completed: 0 },
        failures: [],
        normalization,
        result: "No relevant partitions were found.",
      }
    : {
        status: "failed",
        coverage: { requested: proposedCount, dispatched: 0, completed: 0 },
        failures: preflightFailures,
        normalization,
        result: null,
      };
}

await phase("Delegate", { total: partitions.length });
const outcomes: RecursiveOutcome[] = [...preflightFailures];
const runnable: Partition[] = [];
let recursiveRoots = 0;
for (const partition of partitions) {
  if (partition.recursive && recursiveRoots >= 2) {
    outcomes.push({
      partition: partition.label,
      paths: partition.paths,
      status: "not_started",
      error: "recursive root limit reached",
    });
    continue;
  }
  if (partition.recursive) recursiveRoots += 1;
  runnable.push(partition);
}
const batchSize = 4;
for (let offset = 0; offset < runnable.length; offset += batchSize) {
  const batch = runnable.slice(offset, offset + batchSize);
  const settled = await parallel(
    batch.map((partition) => async (): Promise<RecursiveOutcome> => {
      const task = `Analyze this bounded partition for the objective; return concrete evidence.\n\nPartition: ${partition.label}\nPaths:\n${partition.paths.join("\n")}\n\nObjective:\n${π.task}`;
      try {
        if (!partition.recursive) {
          const finding = await agent(task, {
            label: `analyze ${partition.label}`.slice(0, 50),
            tools: ["read", "grep", "find", "ls"],
          });
          return { partition: partition.label, status: "completed", finding };
        }
        const result = await rlm.query({
          task,
          name: `recurse ${partition.label}`.slice(0, 50),
          tools: ["read", "grep", "find", "ls"],
        });
        if (result.status !== "completed") {
          return {
            partition: partition.label,
            paths: partition.paths,
            status: "failed",
            error: result.error ?? result.status,
          };
        }
        const finding = result.value === undefined
          ? result.text
          : typeof result.value === "string"
            ? result.value
            : JSON.stringify(result.value);
        return { partition: partition.label, status: "completed", finding };
      } catch (error) {
        return {
          partition: partition.label,
          paths: partition.paths,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
    { concurrency: batch.length },
  );
  outcomes.push(...settled);
  if (settled.every((outcome) => outcome.status === "failed")) {
    for (const skipped of runnable.slice(offset + batch.length)) {
      outcomes.push({
        partition: skipped.label,
        paths: skipped.paths,
        status: "not_started",
        error: "not started after an all-failed batch",
      });
    }
    break;
  }
}

const completed = outcomes.filter(
  (outcome): outcome is Extract<RecursiveOutcome, { status: "completed" }> =>
    outcome.status === "completed",
);
const failures = outcomes.filter(
  (outcome): outcome is Extract<RecursiveOutcome, { status: "failed" | "not_started" }> =>
    outcome.status !== "completed",
);
const dispatched = outcomes.filter((outcome) => outcome.status !== "not_started").length;
normalization = { ...normalization, dispatched };
const coverage = {
  requested: proposedCount,
  dispatched,
  completed: completed.length,
};
if (completed.length === 0) {
  return { status: "failed", coverage, failures, normalization, result: null };
}
if (completed.length === 1) {
  return {
    status: failures.length === 0 ? "success" : "partial",
    coverage,
    failures,
    normalization,
    result: completed[0].finding,
    synthesisSkipped: "One partition completed; another agent would only restate it.",
  };
}

await phase("Combine", { total: 1 });
try {
  const result = await agent(
    `Synthesize only these completed findings. Reconcile duplicates and contradictions, drop unsupported claims, and do not infer anything about failed partitions.\n\nObjective:\n${π.task}\n\nFindings:\n${JSON.stringify(completed)}`,
    { label: "combine", tools: ["read", "grep", "find", "ls"] },
  );
  return {
    status: failures.length === 0 ? "success" : "partial",
    coverage,
    failures,
    normalization,
    result,
  };
} catch (error) {
  return {
    status: "partial",
    coverage,
    failures,
    normalization,
    result: null,
    synthesisError: error instanceof Error ? error.message : String(error),
    fallback: completed,
  };
}
```

Coverage keeps the original proposal count, dispatched normalized partitions, completed work, and any merged overlaps. The result is compact on successful synthesis. Raw compact findings appear only when synthesis fails; full `FabricAgentResult` objects never return to the parent. `partial` is usable evidence with named gaps, not a request to rerun the tree. Failure records retain paths: retry only those paths with a plain agent or a targeted recursive query when their coverage matters, and never rerun successful partitions automatically.

Guardrails:

- Deduplicate and partition before spawning. Plain agents handle context-sized leaves; recursion is only for oversized partitions.
- Work in batches so an all-failed batch stops new spend. At most two top-level partitions may recurse; additional recursive proposals return as `not_started` with their paths.
- Partition edit ownership by path or use `worktree: true`; concurrent children must not edit the same files.
- `subagents.maxDepth` bounds each recursive branch. The shared `subagents.budgetUsd` check and `tokenBudget` are best-effort under concurrency because usage settles afterward; batches reduce, but cannot eliminate, overshoot.
- Reserve current-execution agent capacity for orientation and optional synthesis. Recursive descendants enforce their own process limits.
- `budget.remaining()` reflects completed usage only. When the ceiling matters, keep batches small rather than treating it as a reservation.
- Initial approval delegates only agent risk; network, execution, and write approvals are not inherited. Redirect a valuable drifting child with `agents.steer` rather than discarding its context.
