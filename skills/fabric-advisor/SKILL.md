---
name: fabric-advisor
description: Starts a persistent Pi Fabric peer advisor that reviews the main agent at decision points (idle and tool errors) and surfaces only concrete, material advice. Use for ambient correctness review without another extension.
disable-model-invocation: true
---

# Fabric Advisor

Start an emergent advisor using `fabric_exec`; never install or invoke an external advisor extension.

Treat skill arguments as an optional review focus. Put the completed advisor prompt in `strings.instructions` and the stable name `advisor` in `strings.name`. Optionally set `strings.model` to a Pi `provider/id`, a Claude `claude/<runtime-value>` key, or a model substring. The lookup combines `tools.models()` with `agents.models({ runner: "claude" })` and pins both the matching runner and model; omitted uses the configured default runner and its default model. An actor's runner is fixed at creation, while its model can be changed from the dashboard for the next activation. Then call `fabric_exec` once with:

```ts
await workflow.configure({
  name: `Advisor · ${π.name}`,
  description: "Persistent ambient peer review",
});
await phase("Start actor", { total: 1 });
const current = await agents.actors();
const existing = current.find((actor) => actor.name === π.name && actor.status !== "stopped");
if (existing) {
  const migrated: string[] = [];
  await agents.setInstructions({ id: existing.id, instructions: π.instructions });
  if (
    existing.events.length !== 2 ||
    !existing.events.includes("agent_settled") ||
    !existing.events.includes("tool_error")
  ) {
    await agents.setEvents({ id: existing.id, events: ["agent_settled", "tool_error"] });
    migrated.push("events");
  }
  if (existing.delivery !== "steer" || existing.triggerTurn !== false) {
    await agents.setDeliveryPolicy({
      id: existing.id,
      delivery: "steer",
      triggerTurn: false,
    });
    migrated.push("deliveryPolicy");
  }
  const warnings = [
    ...(existing.responseMode !== "directive" ? ["responseMode should be directive; recreate the actor"] : []),
    ...(existing.coalesce !== true ? ["coalesce should be true; recreate the actor"] : []),
  ];
  return {
    reused: true,
    actor: await agents.actorStatus({ id: existing.id }),
    migrated,
    warnings,
  };
}

let model;
let runner: FabricAgentRunner | undefined;
if (π.model) {
  const piModels = (await tools.models()).map((entry) => ({ ...entry, runner: "pi" as const }));
  let claudeModels: Array<FabricModelInfo & { runner: "claude" }> = [];
  try {
    claudeModels = (await agents.models({ runner: "claude" })).map((entry) => ({
      ...entry,
      runner: "claude" as const,
    }));
  } catch {
    // Claude Code is optional; Pi model lookup still works without it.
  }
  const models = [...piModels, ...claudeModels];
  const needle = π.model.toLowerCase();
  const hit = models.find(
    (entry) =>
      entry.key.toLowerCase() === needle ||
      entry.id.toLowerCase().includes(needle) ||
      entry.name.toLowerCase().includes(needle),
  );
  if (!hit) {
    throw new Error(
      `Advisor model "${π.model}" not found. Available: ${models.map((entry) => entry.key).join(", ")}`,
    );
  }
  model = hit.key;
  runner = hit.runner;
}
const actor = await agents.create({
  name: π.name,
  instructions: π.instructions,
  events: ["agent_settled", "tool_error"],
  responseMode: "directive",
  delivery: "steer",
  triggerTurn: false,
  coalesce: true,
  tools: ["read", "grep", "find", "ls"],
  ...(runner ? { runner } : {}),
  ...(model ? { model } : {}),
});
return {
  started: true,
  actor,
  inspect: `/fabric messages ${actor.id.slice(0, 8)}`,
  stop: `/fabric stop ${actor.id.slice(0, 8)}`,
};
```

Use this prompt and append the requested focus when one was supplied:

```text
You are an ambient peer advisor for the main coding agent. Review the supplied parent-session event and recent transcript as an outside observer, not a second executor. Focus on correctness, missed user constraints, risky assumptions, edge cases, and cheaper paths to the requested outcome. You may inspect the workspace with read-only tools when evidence is needed.

Prefer silence. Return {"action":"silent"} when the agent is on track or productively advancing. Return {"action":"message","message":"..."} only for one concrete, material observation that could prevent wasted work or a defect, raised at a moment it can still help. Cite the evidence and recommendation tersely and frame it as advice to weigh, not an order. Do not repeat advice already visible in the recent transcript. Ignore minor style preferences unless the user made them requirements.
```

## Heuristic: review on good signals, not every turn

The advisor subscribes to `agent_settled` and `tool_error` by default, so it runs at decision points (idle and on failures) and stays silent otherwise rather than invoking a model review on every turn. The prompt is event-agnostic: it reviews whatever event is supplied, so you may subscribe it to other events (for example `turn_end`) for tighter per-turn review, at the cost of a model run per event. Intervene only on a concrete, high-confidence signal: a material correctness gap, a missed constraint, a risky assumption, or a tool error worth surfacing.

After creation, report the focus, actor short ID, and inspect/stop commands. Do not wait for it. `triggerTurn: false` is intentional: delivered advice joins the main loop without forcing a new turn (advice to weigh, not an order).

## Steering running subagents

The same primitive that delivers the advisor's own output (`steer`) lets any Fabric-equipped Pi participant redirect a running worker (or discover Main with `agents.main()`) without losing its context: `agents.steer({ id, message })` is delivered between the child's turns, and `agents.status({ id }).pendingMessages` shows the queued steers. See the `agents` reference. Prefer it over stopping and respawning a worker that has accumulated useful context but is drifting.
