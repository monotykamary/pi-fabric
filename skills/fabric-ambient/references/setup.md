# Ambient actor setup

Pass `strings.name`, `strings.instructions`, JSON `strings.events`, `strings.triggerTurn` (`"true"`/`"false"`), and `strings.model` (key/substring; empty when unset).

```ts
const events = JSON.parse(π.events) as FabricActorHostEvent[];
const triggerTurn = π.triggerTurn === "true";
const desiredTools = ["read", "grep", "find", "ls"];
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
  const exact = models.filter((entry) => entry.key.toLowerCase() === needle);
  const fuzzy = exact.length === 0
    ? models.filter((entry) =>
        entry.id.toLowerCase().includes(needle) ||
        entry.name.toLowerCase().includes(needle)
      )
    : exact;
  if (fuzzy.length !== 1) {
    throw new Error(
      fuzzy.length === 0
        ? `Model "${π.model}" not found: ${models.map((entry) => entry.key).join(", ")}`
        : `Model "${π.model}" is ambiguous: ${fuzzy.map((entry) => entry.key).join(", ")}`,
    );
  }
  model = fuzzy[0].key;
  runner = fuzzy[0].runner;
}

const existing = (await agents.actors()).find(
  (actor) => actor.name === π.name && actor.status !== "stopped",
);
if (existing) {
  const runnerMatches = !runner || existing.runner === runner;
  const warnings = [
    ...(existing.status !== "idle" ? [`actor is ${existing.status}; wait until idle or stop it before reconfiguration`] : []),
    ...(existing.responseMode !== "directive" ? ["recreate for responseMode=directive"] : []),
    ...(existing.coalesce !== true ? ["recreate for coalesce=true"] : []),
    ...(existing.topics.length !== 0 ? ["recreate without topic subscriptions"] : []),
    ...(!runnerMatches ? [`runner "${runner}" requires recreation`] : []),
    ...(runnerMatches && model && existing.model !== model ? [`model "${model}" requires a dashboard change or recreation`] : []),
  ];
  if (warnings.length) return { reused: false, actor: existing, warnings };

  await agents.setInstructions({ id: existing.id, instructions: π.instructions });
  if (
    existing.tools?.length !== desiredTools.length ||
    desiredTools.some((tool) => !existing.tools?.includes(tool))
  ) {
    await agents.setTools({ id: existing.id, tools: desiredTools });
  }
  if (existing.events.length !== events.length || events.some((event) => !existing.events.includes(event))) {
    await agents.setEvents({ id: existing.id, events });
  }
  if (existing.delivery !== "steer" || existing.triggerTurn !== triggerTurn) {
    await agents.setDeliveryPolicy({ id: existing.id, delivery: "steer", triggerTurn });
  }
  return {
    reused: true,
    actor: await agents.actorStatus({ id: existing.id }),
    warnings: [],
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
  tools: desiredTools,
  ...(runner ? { runner } : {}),
  ...(model ? { model } : {}),
});
return { started: true, actor };
```

Reuse updates instructions/events/delivery/native tools. Recreate for runner, model, `responseMode`, `coalesce`, or topics. Extension and provider availability follows the configured runner and actor extension policy. Report ID/warnings and messages/stop; do not wait.
