---
name: fabric-ambient
description: Creates an emergent supervisor or advisor as a persistent Pi Fabric actor. Use when the user asks for ambient supervision, ongoing peer review, an advisor, or a goal watcher without installing a separate extension.
disable-model-invocation: true
---

# Fabric Ambient Actors

This is the meta-pattern for custom ambient roles. Prefer `/skill:fabric-supervisor` or `/skill:fabric-advisor` when either dedicated pattern matches exactly.

Create the requested behavior with `fabric_exec` and `agents.create()`. Do not install or load pi-supervisor, pi-advisor, or another orchestration extension.

The first skill argument selects the pattern:

- `supervisor <goal>`: watch until the goal is achieved; steer only when work is incomplete or drifting.
- `advisor [focus]`: peer-review turns and surface only material advice.

If the pattern is omitted, infer it from the request. If a supervisor goal is omitted, derive a concrete goal from the current user request. Do not ask for details that are already in the conversation.

Pass long instructions through the `strings` parameter and reference them as `π.instructions`. Set `strings.pattern` to exactly `supervisor` or `advisor`; the profile is then explicit and can repair a stale actor on reuse. Use one Fabric call shaped like this:

```ts
await workflow.configure({
  name: `Ambient · ${π.name}`,
  description: "Persistent event-driven actor setup",
});
await phase("Start actor", { total: 1 });
const advisor = π.pattern === "advisor";
const desiredEvents: FabricActorHostEvent[] = advisor
  ? ["turn_end"]
  : ["agent_settled", "tool_error"];
const desiredTriggerTurn = !advisor;
const current = await agents.actors();
const duplicate = current.find((actor) => actor.name === π.name && actor.status !== "stopped");
if (duplicate) {
  const migrated: string[] = [];
  await agents.setInstructions({ id: duplicate.id, instructions: π.instructions });
  if (
    duplicate.events.length !== desiredEvents.length ||
    desiredEvents.some((event) => !duplicate.events.includes(event))
  ) {
    await agents.setEvents({ id: duplicate.id, events: desiredEvents });
    migrated.push("events");
  }
  if (duplicate.delivery !== "steer" || duplicate.triggerTurn !== desiredTriggerTurn) {
    await agents.setDeliveryPolicy({
      id: duplicate.id,
      delivery: "steer",
      triggerTurn: desiredTriggerTurn,
    });
    migrated.push("deliveryPolicy");
  }
  const warnings = [
    ...(duplicate.responseMode !== "directive" ? ["responseMode should be directive; recreate the actor"] : []),
    ...(duplicate.coalesce !== true ? ["coalesce should be true; recreate the actor"] : []),
  ];
  return {
    reused: true,
    actor: await agents.actorStatus({ id: duplicate.id }),
    migrated,
    warnings,
  };
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
});
return {
  started: true,
  actor,
  inspect: `/fabric messages ${actor.id.slice(0, 8)}`,
  stop: `/fabric stop ${actor.id.slice(0, 8)}`,
};
```

The advisor profile uses `["turn_end"]` with `triggerTurn: false` so advice does not create an interruption loop. The supervisor profile uses idle/error decision points with `triggerTurn: true`.

## Supervisor instructions

Build `π.instructions` from the goal and these rules:

```text
You are an ambient supervisor for this goal:

<goal>
GOAL
</goal>

Review the supplied parent-session event and recent transcript. You are an outside observer, not a second implementer.

Return {"action":"silent"} while work is productively advancing and after the goal is verifiably complete. Return {"action":"message","message":"..."} only when the main agent is idle with material work missing, is drifting from the goal, is stuck after a tool error, or needs one concrete next action. Keep messages direct and at most three sentences. Do not repeat a prior steer. Never request credentials or invent user decisions. Once the goal is clearly complete, return {"action":"stop","message":"Goal verified complete."}.
```

Replace `GOAL` with the actual goal before passing the string.

## Advisor instructions

Build `π.instructions` from the optional focus and these rules:

```text
You are an ambient peer advisor reviewing the main coding agent one turn at a time. Focus on correctness, missed constraints, risky assumptions, and cheaper paths to the user's outcome. You may inspect the workspace with read-only tools when evidence is needed.

Prefer silence. Return {"action":"silent"} when the agent is on track. Return {"action":"message","message":"..."} only for a concrete, material observation that could prevent wasted work or a defect. State the evidence and recommendation tersely; frame it as advice to weigh, not an order. Do not repeat advice already present in the recent transcript.
```

Append the user's requested focus when present.

## After creation

Tell the user the actor name, short ID, subscribed events, and the `/fabric messages` and `/fabric stop` commands. Do not wait for the actor: it is session-persistent and event-driven.

## Steering running subagents

Any Fabric-equipped Pi participant (including a Pi ambient actor) can redirect a running worker or target Main via `agents.main()`; ordinary non-recursive and Claude agents can receive but not initiate Fabric messages. A capable participant can redirect a worker without losing its context via `agents.steer({ id, message })` (delivered between the child's turns) and observe the queue with `agents.status({ id }).pendingMessages`. Across processes, `agents.steer` publishes a `fabric.steer` mesh event automatically. See the `agents` and `mesh` references. Prefer steering over stopping and respawning a worker that has accumulated useful context but is drifting.
