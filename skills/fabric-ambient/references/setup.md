# Ambient actor setup

Use this shared setup after the active skill has chosen the actor profile. Pass these strings to one `fabric_exec` call:

- `name`: stable actor name
- `instructions`: complete directive-mode prompt
- `events`: JSON `FabricActorHostEvent[]`
- `triggerTurn`: `"true"` or `"false"`
- `model`: Pi `provider/id`, Claude `claude/<runtime-value>`, or model substring; pass an empty string when unset

```ts
const desiredEvents = JSON.parse(π.events) as FabricActorHostEvent[];
const desiredTriggerTurn = π.triggerTurn === "true";
await workflow.configure({
  name: `Ambient · ${π.name}`,
  description: "Persistent event-driven actor setup",
});
await phase("Start actor", { total: 1 });

const existing = (await agents.actors()).find(
  (actor) => actor.name === π.name && actor.status !== "stopped",
);
if (existing) {
  const migrated: string[] = [];
  await agents.setInstructions({ id: existing.id, instructions: π.instructions });
  if (
    existing.events.length !== desiredEvents.length ||
    desiredEvents.some((event) => !existing.events.includes(event))
  ) {
    await agents.setEvents({ id: existing.id, events: desiredEvents });
    migrated.push("events");
  }
  if (existing.delivery !== "steer" || existing.triggerTurn !== desiredTriggerTurn) {
    await agents.setDeliveryPolicy({
      id: existing.id,
      delivery: "steer",
      triggerTurn: desiredTriggerTurn,
    });
    migrated.push("deliveryPolicy");
  }
  return {
    reused: true,
    actor: await agents.actorStatus({ id: existing.id }),
    migrated,
    warnings: [
      ...(existing.responseMode !== "directive" ? ["recreate to set responseMode=directive"] : []),
      ...(existing.coalesce !== true ? ["recreate to set coalesce=true"] : []),
    ],
  };
}

let model: string | undefined;
let runner: FabricAgentRunner | undefined;
if (π.model) {
  const models: Array<FabricModelInfo & { runner: FabricAgentRunner }> = (
    await tools.models()
  ).map((entry) => ({ ...entry, runner: "pi" as const }));
  try {
    models.push(
      ...(await agents.models({ runner: "claude" })).map((entry) => ({
        ...entry,
        runner: "claude" as const,
      })),
    );
  } catch {
    // Claude Code is optional.
  }
  const needle = π.model.toLowerCase();
  const hit = models.find(
    (entry) =>
      entry.key.toLowerCase() === needle ||
      entry.id.toLowerCase().includes(needle) ||
      entry.name.toLowerCase().includes(needle),
  );
  if (!hit) throw new Error(`Model "${π.model}" not found: ${models.map((entry) => entry.key).join(", ")}`);
  model = hit.key;
  runner = hit.runner;
}

const actor = await agents.create({
  name: π.name,
  instructions: π.instructions,
  events: desiredEvents,
  responseMode: "directive",
  delivery: "steer",
  triggerTurn: desiredTriggerTurn,
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

Reuse updates instructions, events, and delivery policy. `responseMode` and `coalesce` are immutable; recreate an incompatible actor. After setup, report the actor name, short ID, events, and inspect/stop commands. Do not wait for it.
