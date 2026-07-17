---
name: fabric-fusion
description: Multi-model deliberation. A panel of up to 8 distinct models answers a task in parallel (each with web access), then a judge model compares their responses into structured analysis (consensus, contradictions, coverage gaps, unique insights, blind spots) that the caller turns into a better final answer. Use for research, expert critique, and compare-and-contrast where the cost of being wrong outweighs the cost of a few extra completions.
disable-model-invocation: true
---

# Fabric Fusion

Use one `fabric_exec` call. A panel of up to 8 distinct models answers the task in parallel, each with web access, then a judge model compares (does not merge) their responses and returns structured analysis: consensus, contradictions, partial coverage, unique insights, blind spots. Return that analysis; the caller writes the final answer from it. This mirrors OpenRouter's Fusion Router (`openrouter/fusion`): the panel and the judge are the inner deliberation, and the program hands back analysis rather than a merged answer.

Use when a single model is not enough: research questions, expert critique, compare-and-contrast, or anything where the cost of being wrong outweighs the cost of a few extra completions. Do not use it for a short tactical prompt or a lookup with no meaningful competing considerations.

Pass the task and panel through `strings` and reference them as `π.*`. `π.task` is the prompt. `π.panel` is OpenRouter's `analysis_models`, a JSON `Array<{ model, label? }>` of 1–8 models; `label` defaults to the model id and is used only for attribution in the judge's input and the dashboard, never injected into a member's prompt. `π.judge` is OpenRouter's judge `model` (defaults to the first panel model). `π.tools` is the panel+judge tool allowlist (defaults to read, grep, find, ls, and bash; `bash` is the `web_search`/`web_fetch` analog via `gsearch`/`curl`). `π.thinking` is the reasoning effort for panel+judge (maps to OpenRouter's `reasoning`; defaults to `subagents.thinking`, medium). Pass every referenced key, using empty string for the optionals (`judge`, `tools`, `thinking`) when not setting them.

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

The default panel size is 3 (OpenRouter's Quality preset). Pick a panel by intent; these mirror OpenRouter's presets, which you encode directly since pi-fabric has no model catalog: the strongest all-round models you have (`general-high`), a cheaper panel with one frontier judge (`general-budget`), or a latency-homogeneous panel (models with similar TTFT, so none gates the fan-out) for fast agentic turns (`general-fast`).

Cost is N panel + 1 judge: a 3-model panel is roughly 4× a single answer. The run counts toward `budget.spent()` and the `tokenBudget` guard; `subagents.budgetUsd` bounds total spend. Set `agentBudget` and `tokenBudget` on `fabric_exec` when the panel or per-member work is large.

Deliberation is bounded to one level. Members and the judge run as plain `agent()` calls without `recursive: true`, so they do not receive `fabric_exec` and cannot launch their own fusion panel, the same invariant OpenRouter enforces with its `x-openrouter-fusion-depth` header. Unlike OpenRouter, where the outer model decides per request whether to call `openrouter:fusion`, here the caller decides by running this skill; once invoked, the panel + judge always run.

Web access requires `bash`, which is gated by the `execute` approval policy; without it, members answer from their own knowledge (a panel without web tools). Members run concurrently up to `subagents.maxConcurrent` (default 4); raise it in `fabric.json` or `/fabric` settings to run larger panels fully in parallel. OpenRouter exposes `max_tool_calls`, `max_completion_tokens`, and `temperature` per inner call; pi-fabric has no per-call equivalents, so members and the judge inherit provider defaults, with `thinking` for reasoning effort.

Do not use fusion for a single-model lookup, a simple edit, or a decision with no meaningful competing considerations; use a plain `agent()` or `council.run()` instead. For same-model, role-diverse review (one model, several perspectives), `/skill:fabric-council` is the closer match; fusion is for model-diverse deliberation.
