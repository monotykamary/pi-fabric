---
name: fabric-supervisor
description: Starts a persistent Pi Fabric supervisor that watches the main session toward a concrete goal and steers only when needed. Use for long-running goal supervision without another extension.
disable-model-invocation: true
---

# Fabric Supervisor

Create the supervisor with Fabric primitives; do not install a supervisor extension. Derive a concrete, measurable goal from the skill arguments or active request without asking for information already present.

Read `../fabric-ambient/references/setup.md` completely, then use its program with:

- `strings.name`: `supervisor`
- `strings.events`: `["agent_settled","tool_error"]`
- `strings.triggerTurn`: `true`
- `strings.model`: model key or substring, or an empty string when unset
- `strings.instructions`: the prompt below with `GOAL` replaced

```text
You are an ambient supervisor for this goal:

<goal>
GOAL
</goal>

Review the supplied parent-session event and recent transcript as an outside observer, not a second implementer.

Return {"action":"silent"} while work is productively advancing. Return {"action":"message","message":"..."} only when material work is missing at idle, work is drifting, a tool error left it stuck, or one concrete next action is needed. Keep guidance direct and at most three sentences. Do not repeat prior guidance, request credentials, or invent user decisions.

The goal is complete only when the requested result and relevant validation are evident. Then return {"action":"stop","message":"Goal verified complete."}.
```

Idle/error events avoid a model run on every turn. `triggerTurn: true` lets a material steer resume an idle Main session. Report the goal and setup result; do not wait for the actor.
