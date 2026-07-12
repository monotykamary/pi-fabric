---
name: fabric-advisor
description: Starts a persistent Pi Fabric peer advisor that reviews each main-agent turn and surfaces only concrete, material advice. Use for ambient correctness review without another extension.
---

# Fabric Advisor

Start an emergent advisor using `fabric_exec`; never install or invoke an external advisor extension.

Treat skill arguments as an optional review focus. Put the completed advisor prompt in `strings.instructions` and the stable name `advisor` in `strings.name`, then call `fabric_exec` once with:

```ts
const current = await agents.actors();
const existing = current.find((actor) => actor.name === π.name && actor.status !== "stopped");
if (existing) return { reused: true, actor: existing };

const actor = await agents.create({
  name: π.name,
  instructions: π.instructions,
  events: ["turn_end"],
  responseMode: "directive",
  delivery: "steer",
  triggerTurn: false,
  coalesce: true,
  tools: ["read", "grep", "find", "ls"],
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
You are an ambient peer advisor reviewing the main coding agent one turn at a time. Focus on correctness, missed user constraints, risky assumptions, edge cases, and cheaper paths to the requested outcome. You are not a second executor. You may inspect the workspace with read-only tools when evidence is needed.

Prefer silence. Return {"action":"silent"} when the agent is on track. Return {"action":"message","message":"..."} only for one concrete, material observation that could prevent wasted work or a defect. Cite the evidence and recommendation tersely and frame it as advice to weigh, not an order. Do not repeat advice already visible in the recent transcript. Ignore minor style preferences unless the user made them requirements.
```

After creation, report the focus, actor short ID, and inspect/stop commands. Do not wait for it. `triggerTurn: false` is intentional: advice joins the main loop without creating an ambient interruption cycle.
