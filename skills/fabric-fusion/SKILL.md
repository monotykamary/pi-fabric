---
name: fabric-fusion
description: Multi-model deliberation. Up to 8 distinct models answer in parallel with web-capable tools, then a judge compares consensus, contradictions, coverage gaps, unique insights, and blind spots. Use when the cost of being wrong justifies multiple completions.
disable-model-invocation: true
---

# Fabric Fusion

Use one `fabric_exec` call for a 1–8 model panel followed by one judge. The judge compares rather than merges responses; return its structured analysis so the caller writes the final answer. Use fusion for model-diverse research or critique, not tactical work or a lookup.

Pass every key through `strings`: `task`; `panel` as JSON `Array<{ model, label? }>`; and optional `judge`, `tools`, `thinking` as empty strings when unset. Labels are attribution only. Tools default to `read`, `grep`, `find`, `ls`, and `bash`; thinking defaults to configured subagent thinking.

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
if (panel.length < 1 || panel.length > 8) {
  throw new Error("Fusion panel (analysis_models) must have 1–8 members.");
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
  const hit = models.find(
    (entry) =>
      entry.key.toLowerCase() === n ||
      entry.id.toLowerCase().includes(n) ||
      entry.name.toLowerCase().includes(n),
  );
  if (!hit) {
    throw new Error(
      `Fusion: model "${needle}" not found. Available: ${models.map((entry) => entry.key).join(", ")}`,
    );
  }
  return hit;
};
const members = panel.map((member) => ({
  ...resolve(member.model),
  label: member.label || member.model,
}));
const judgeModel = π.judge ? resolve(π.judge) : members[0];

// Panel: up to 8 distinct models answer the same task in parallel, each with
// web access (bash → gsearch/curl is the web_search/web_fetch analog). Members
// run as plain agents (no recursive:true), so they cannot launch their own
// fusion panel — one level of deliberation, like x-openrouter-fusion-depth.
await phase("Panel", { total: members.length });
const responses = await parallel(
  members.map((m) => () =>
    agent<string>(
      `Independently answer this task. Use web search (run gsearch or curl via bash) when fresh sources help, and cite them inline.\n\nTask:\n${task}`,
      {
        label: `panel · ${m.label}`.slice(0, 50),
        runner: m.runner,
        model: m.key,
        tools: toolset,
        ...(thinking ? { thinking } : {}),
      },
    ),
  ),
  { concurrency: members.length },
);

// Judge: compare, don't merge. Returns the structured analysis shape
// OpenRouter's fusion judge returns; the caller writes the final answer.
await phase("Judge", { total: 1 });
const analysis = await agent<FusionAnalysis>(
  `You are the fusion judge. Compare these ${members.length} panel responses — do NOT merge them into one answer.\n` +
    `Return structured analysis: consensus (points all or most agree on, higher-confidence), ` +
    `contradictions (where they disagreed), partial_coverage (what only some covered), ` +
    `unique_insights (insights from individual models), blind_spots (gaps none addressed). ` +
    `You may search the web to verify claims.\n\nTask:\n${task}\n\nPanel responses:\n` +
    JSON.stringify(members.map((m, i) => ({ model: m.label, response: responses[i] }))),
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

await workflow.event({ message: `Fusion complete · ${members.length}-model panel judged`, level: "success" });
return analysis;
```

Choose distinct models by intent: strongest available, budget-balanced with a frontier judge, or similar-latency models for faster fan-out. The default panel size is three. Cost is N panel calls plus one judge; set top-level `agentBudget` and `tokenBudget`, while `subagents.budgetUsd` bounds spend.

Panel members and the judge are plain, non-recursive agents, so deliberation is one level. `bash` enables web access through local search/fetch commands and requires execute approval. Concurrency is capped by `subagents.maxConcurrent`; inner calls otherwise inherit provider limits and use `thinking` for reasoning effort.

Use `/skill:fabric-council` instead for same-model, role-diverse review. Use a plain agent when competing model perspectives do not justify the cost.
