---
name: fabric-fusion
description: Multi-model deliberation. Two to 8 distinct models answer in parallel with web-capable tools, then a judge compares consensus, contradictions, coverage gaps, unique insights, and blind spots. Use when the cost of being wrong justifies multiple completions.
disable-model-invocation: true
---

# Fabric Fusion

Use one `fabric_exec` call for a 2–8 model panel and a judge when at least two responses complete. The judge compares rather than merges responses; return a compact status/coverage/analysis envelope so the caller writes the final answer. Use fusion for model-diverse research or critique, not tactical work or a lookup.

Pass every key: `strings.task`; JSON `strings.panel` as `Array<{ model, label? }>`; and optional `strings.judge`, `strings.tools`, and `strings.thinking` as empty strings when unset. Labels are attribution only. Tools default to `read`, `grep`, `find`, `ls`, and `bash`; thinking defaults to configured agent thinking.

```ts
type FusionAnalysis = {
  consensus: string[];
  contradictions: string[];
  partial_coverage: string[];
  unique_insights: string[];
  blind_spots: string[];
};

const task = π.task;
const panel = JSON.parse(π.panel) as Array<{ model: string; label?: string }>;
if (panel.length < 2 || panel.length > 8) {
  throw new Error("Fusion panel (analysis_models) must have 2–8 members.");
}
const toolset = π.tools ? (JSON.parse(π.tools) as string[]) : ["read", "grep", "find", "ls", "bash"];
const thinking = π.thinking ? (π.thinking as FabricThinking) : undefined;

await workflow.configure({
  name: "Fusion deliberation",
  description: `${panel.length}-model panel + judge (compare, don't merge)`,
});

// Resolve models across Pi's registry and Claude Code's runtime catalog.
// Prefix Claude aliases with claude/ (for example claude/haiku) to select the
// official CLI runner unambiguously. Claude Code is optional, so discovery is
// best-effort when the panel contains only Pi models.
type RunnerModel = FabricModelInfo & { runner: FabricAgentRunner };
const models: RunnerModel[] = (await tools.models()).map((entry) => ({
  ...entry,
  runner: "pi" as const,
}));
try {
  models.push(
    ...(await agents.models({ runner: "claude" })).map((entry) => ({
      ...entry,
      runner: "claude" as const,
    })),
  );
} catch {
  // The installed Claude CLI is optional; report the combined available list below.
}
const resolve = (needle: string): RunnerModel => {
  const n = needle.toLowerCase();
  const exact = models.filter((entry) => entry.key.toLowerCase() === n);
  if (exact.length === 1) return exact[0];
  const fuzzy = models.filter(
    (entry) =>
      entry.id.toLowerCase().includes(n) || entry.name.toLowerCase().includes(n),
  );
  if (fuzzy.length !== 1) {
    throw new Error(
      fuzzy.length === 0
        ? `Fusion: model "${needle}" not found. Available: ${models.map((entry) => entry.key).join(", ")}`
        : `Fusion: model "${needle}" is ambiguous. Matches: ${fuzzy.map((entry) => entry.key).join(", ")}`,
    );
  }
  return fuzzy[0];
};
const members = panel.map((member) => ({
  ...resolve(member.model),
  label: (member.label || member.model).trim(),
}));
const modelIdentities = members.map((member) =>
  `${member.runner}:${member.provider}:${member.resolvedModel ?? member.id}`
);
if (new Set(modelIdentities).size !== members.length) {
  throw new Error("Fusion requires distinct resolved models, not aliases of the same model.");
}
if (members.some((member) => !member.label) ||
    new Set(members.map((member) => member.label)).size !== members.length) {
  throw new Error("Fusion requires distinct non-empty labels.");
}
const explicitJudge = π.judge ? resolve(π.judge) : undefined;

type PanelOutcome =
  | { label: string; model: string; runner: FabricAgentRunner; status: "completed"; response: string }
  | { label: string; model: string; runner: FabricAgentRunner; status: "failed"; error: string };

// Plain, non-recursive members preserve one level of deliberation.
await phase("Panel", { total: members.length });
const outcomes = await parallel(
  members.map((member) => async (): Promise<PanelOutcome> => {
    try {
      const response = await agent<string>(
        `Independently answer this task. Use web search (run gsearch or curl via bash) when fresh sources help, and cite them inline.\n\nTask:\n${task}`,
        {
          label: `panel · ${member.label}`.slice(0, 50),
          runner: member.runner,
          model: member.key,
          tools: toolset,
          ...(thinking ? { thinking } : {}),
        },
      );
      return {
        label: member.label, model: member.key, runner: member.runner,
        status: "completed", response,
      };
    } catch (error) {
      return {
        label: member.label, model: member.key, runner: member.runner,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }),
  { concurrency: members.length },
);
const completed = outcomes.filter(
  (outcome): outcome is Extract<PanelOutcome, { status: "completed" }> =>
    outcome.status === "completed",
);
const failures = outcomes.filter(
  (outcome): outcome is Extract<PanelOutcome, { status: "failed" }> =>
    outcome.status === "failed",
);
const coverage = { requested: members.length, completed: completed.length };
if (completed.length === 0) {
  return { status: "failed", coverage, failures, analysis: null };
}
if (completed.length === 1) {
  return {
    status: "partial",
    coverage,
    failures,
    analysis: null,
    judgeSkipped: "At least two model responses are required for comparison.",
    fallback: completed,
  };
}

const judgeModel = explicitJudge ?? {
  key: completed[0].model,
  runner: completed[0].runner,
};
await phase("Judge", { total: 1 });
try {
  const analysis = await agent<FusionAnalysis>(
    `You are the fusion judge. Compare these ${completed.length} completed panel responses — do NOT merge them into one answer or infer claims from failed models.\n` +
      `Return structured analysis: consensus (points all or most agree on, higher-confidence), ` +
      `contradictions (where they disagreed), partial_coverage (what only some covered), ` +
      `unique_insights (insights from individual models), blind_spots (gaps none addressed). ` +
      `You may search the web to verify claims.\n\nTask:\n${task}\n\nPanel responses:\n` +
      JSON.stringify(completed),
    {
      label: "fusion judge",
      runner: judgeModel.runner,
      model: judgeModel.key,
      tools: toolset,
      ...(thinking ? { thinking } : {}),
      schema: {
        type: "object",
        properties: {
          consensus: { type: "array", items: { type: "string" } },
          contradictions: { type: "array", items: { type: "string" } },
          partial_coverage: { type: "array", items: { type: "string" } },
          unique_insights: { type: "array", items: { type: "string" } },
          blind_spots: { type: "array", items: { type: "string" } },
        },
        required: ["consensus", "contradictions", "partial_coverage", "unique_insights", "blind_spots"],
        additionalProperties: false,
      },
    },
  );
  await workflow.event({ message: `Fusion complete · ${completed.length}/${members.length} models judged`, level: "success" });
  return {
    status: failures.length === 0 ? "success" : "partial",
    coverage,
    failures,
    analysis,
  };
} catch (error) {
  return {
    status: "partial",
    coverage,
    failures,
    analysis: null,
    judgeError: error instanceof Error ? error.message : String(error),
    fallback: completed,
  };
}
```

Choose distinct models by intent: strongest available, budget-balanced with a frontier judge, or similar-latency models for faster fan-out. The default panel size is three. Cost is N panel calls plus a judge when comparison is possible. Reserve `panel.length + 1` top-level agent calls. Concurrent calls can overshoot observational token/USD checks because usage settles afterward; those settings are not hard concurrent reservations.

Panel members and the judge are plain, non-recursive agents, so deliberation is one level. `bash` enables web access through local search/fetch commands and requires execute approval. Concurrency is capped by `agents.maxConcurrent`; inner calls otherwise inherit provider limits and use `thinking` for reasoning effort.

For same-model role diversity, recommend `/skill:fabric-council` for the user to invoke; do not invoke another user-only skill yourself. Use a plain agent when competing model perspectives do not justify the cost.

## Completion criterion

Return `success`, `partial`, or `failed` with explicit panel coverage. Successful judging returns only the structured comparison; raw responses return only when judging fails or fewer than two models complete. A partial result is usable and must not trigger an automatic full-panel rerun. Failures retain label, canonical model key, and runner; retry only failed models or the judge when that missing coverage matters.
