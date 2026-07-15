---
name: fabric-supervisor
description: Starts a persistent, event-driven Pi Fabric supervisor that watches the main session toward a concrete goal and steers only when needed. Use for long-running goal supervision without another extension.
disable-model-invocation: true
---

# Fabric Supervisor

Start an emergent supervisor using `fabric_exec`; never install or invoke an external supervisor extension.

Derive the goal from the skill arguments. If arguments are empty, use the active user request and conversation. Make the goal concrete and measurable without asking for information already present.

Call `fabric_exec` once. Put the completed supervisor prompt in `strings.instructions` and the stable name `supervisor` in `strings.name`, then execute:

```ts
await workflow.configure({
  name: `Supervisor · ${π.name}`,
  description: "Persistent ambient goal supervision",
});
await phase("Start actor", { total: 1 });
const current = await agents.actors();
const existing = current.find((actor) => actor.name === π.name && actor.status !== "stopped");
if (existing) {
  // Re-apply the current goal/persona so re-running the skill updates a stale
  // supervisor instead of silently reusing it. Events and run settings are
  // left as the user configured them.
  await agents.setInstructions({ id: existing.id, instructions: π.instructions });
  return { reused: true, actor: existing, migrated: true };
}

const actor = await agents.create({
  name: π.name,
  instructions: π.instructions,
  events: ["agent_settled", "tool_error"],
  responseMode: "directive",
  delivery: "steer",
  triggerTurn: true,
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

Use this prompt, replacing `GOAL`:

```text
You are an ambient supervisor for this goal:

<goal>
GOAL
</goal>

Review each supplied parent-session event and recent transcript as an outside observer, not a second implementer.

Return {"action":"silent"} while work is productively advancing. Return {"action":"message","message":"..."} only when the main agent is idle with material work missing, is drifting from the goal, is stuck after a tool error, or needs one concrete next action. Keep a steer direct and at most three sentences. Do not repeat prior guidance. Never request credentials or invent a decision only the user can make.

The goal is complete only when the requested result and its relevant validation are evident in the transcript. At that point return {"action":"stop","message":"Goal verified complete."}.
```

## Heuristic: steer on good signals, not every turn

The supervisor subscribes to `agent_settled` and `tool_error`, not `turn_end` or `input`. It runs at decision points (idle and on failures) and stays silent while work is productively advancing, so it does not invoke a model review on every turn. Intervene only on a concrete, high-confidence signal: material work missing at idle, drift from the goal, a stuck state after a tool error, or verified completion.

After creation, report the goal, actor short ID, and inspect/stop commands. Do not wait for it; host events drive it across later turns.

## Steering running subagents

A supervisor (or any orchestrator) can redirect a running worker without discarding its context: `agents.steer({ id, message })` delivers between the child's turns, and `agents.status({ id }).pendingMessages` shows the queued steers. See the `agents` reference. Prefer this over stopping and respawning a worker that has accumulated useful context but is drifting from the goal. Because actors run with Fabric, the supervisor can call `agents.steer` from inside `fabric_exec` to redirect a running subagent directly, or publish a `fabric.steer` mesh event to steer an agent in another process.
