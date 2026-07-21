# Ambient actor setup

Pass `strings.name`, `strings.instructions`, JSON `strings.events`, `strings.triggerTurn` (`"true"`/`"false"`), and `strings.model` (key/substring; empty when unset).

```ts
const events = JSON.parse(π.events) as FabricActorHostEvent[];
const triggerTurn = π.triggerTurn === "true";
let model: string | undefined;
let runner: FabricAgentRunner | undefined;
if (π.model) {
  const models: Array<FabricModelInfo & { runner: FabricAgentRunner }> = (
    await tools.models()
  ).map((entry) => ({ ...entry, runner: "pi" as const }));
  try {
    models.push(...(await agents.models({ runner: "claude" })).map((entry) => ({
      ...entry,
      runner: "claude" as const,
    })));
  } catch {}
  const needle = π.model.toLowerCase();
  const selected = models.find((entry) =>
    entry.key.toLowerCase() === needle ||
    entry.id.toLowerCase().includes(needle) ||
    entry.name.toLowerCase().includes(needle)
  );
  if (!selected) throw new Error(`Model "${π.model}" not found: ${models.map((entry) => entry.key).join(", ")}`);
  model = selected.key;
  runner = selected.runner;
}

const existing = (await agents.actors()).find(
  (actor) => actor.name === π.name && actor.status !== "stopped",
);
if (existing) {
  await agents.setInstructions({ id: existing.id, instructions: π.instructions });
  if (existing.events.length !== events.length || events.some((event) => !existing.events.includes(event))) {
    await agents.setEvents({ id: existing.id, events });
  }
  if (existing.delivery !== "steer" || existing.triggerTurn !== triggerTurn) {
    await agents.setDeliveryPolicy({ id: existing.id, delivery: "steer", triggerTurn });
  }
  const runnerMatches = !runner || existing.runner === runner;
  const modelMatches = !model || existing.model === model;
  return {
    reused: true,
    actor: await agents.actorStatus({ id: existing.id }),
    warnings: [
      ...(existing.responseMode !== "directive" ? ["recreate for responseMode=directive"] : []),
      ...(existing.coalesce !== true ? ["recreate for coalesce=true"] : []),
      ...(!runnerMatches ? [`runner "${runner}" requires recreation`] : []),
      ...(runnerMatches && !modelMatches ? [`model "${model}" requires a dashboard change or recreation`] : []),
    ],
  };
}

const actor = await agents.create({
  name: π.name,
  instructions: π.instructions,
  events,
  responseMode: "directive",
  delivery: "steer",
  triggerTurn,
  coalesce: true,
  tools: ["read", "grep", "find", "ls"],
  ...(runner ? { runner } : {}),
  ...(model ? { model } : {}),
});
return { started: true, actor };
```

Reuse updates instructions/events/delivery. Recreate for runner, `responseMode`, or `coalesce`; use dashboard/recreation for model changes. Report ID, warnings, and messages/stop commands; do not wait.
