---
name: fabric-supervisor
description: Starts a persistent, event-driven Pi Fabric supervisor that watches the main session toward a concrete goal and steers only when needed. Use for long-running goal supervision without another extension.
---

# Fabric Supervisor

Start an emergent supervisor using `fabric_exec`; never install or invoke an external supervisor extension.

Derive the goal from the skill arguments. If arguments are empty, use the active user request and conversation. Make the goal concrete and measurable without asking for information already present.

Call `fabric_exec` once. Put the completed supervisor prompt in `strings.instructions` and the stable name `supervisor` in `strings.name`, then execute:

```ts
const current = await agents.actors();
const existing = current.find((actor) => actor.name === π.name && actor.status !== "stopped");
if (existing) return { reused: true, actor: existing };

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

After creation, report the goal, actor short ID, and inspect/stop commands. Do not wait for it; host events drive it across later turns.
