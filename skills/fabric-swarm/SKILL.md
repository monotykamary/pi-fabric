---
name: fabric-swarm
description: Creates a self-organizing team of persistent Pi Fabric actors with durable topics, direct mailboxes, and compare-and-swap shared tasks. Use for messenger-like multi-agent collaboration and long-lived delegated work.
disable-model-invocation: true
---

# Fabric Swarm

Build the team from Pi Fabric primitives; do not install or invoke pi-messenger or another swarm extension.

Use:

- `agents.create()` for persistent identities and mailbox processors.
- `agents.tell()` for asynchronous direct delegation.
- `agents.ask()` only when the coordinator truly must block for a response.
- `mesh.publish()` for durable channel-like events.
- `mesh.read()` for feed history and cursors.
- `mesh.members()` for project-wide actor presence.
- `mesh.put(..., ifVersion)` for atomic task claims, leases, and shared decisions.

Choose a short run key and topic, such as `team.auth-migration`. Seed task records under `runs/<run-key>/tasks/<task-id>` with `ifVersion: 0`. Each value should include `title`, `status`, `owner`, `dependencies`, `progress`, and `result`.

Create role-shaped actors subscribed to the team topic. Their instructions must require:

1. Read the assigned task from mesh state.
2. Claim it with compare-and-swap using the observed version; do not work after a failed claim.
3. Publish progress to the team topic.
4. Update the task with compare-and-swap when blocked or complete.
5. Address questions with `mesh.publish({ topic, to, ... })`.
6. Avoid files owned by another task or actor.
7. Return a directive message only for a blocker or final result; otherwise stay silent.

Example coordinator skeleton:

```ts
const run = π.run;
const topic = `team.${run}`;
await workflow.configure({
  name: `Swarm · ${run}`,
  description: "Persistent actors coordinating through durable shared tasks",
});

const tasks = JSON.parse(π.tasks) as Array<{ id: string; title: string; detail: string }>;
await phase("Seed tasks", { total: tasks.length });
for (const task of tasks of JSON.parse(π.tasks) as Array<{ id: string; title: string; detail: string }>) {
  await mesh.put({
    key: `runs/${run}/tasks/${task.id}`,
    value: { ...task, status: "ready", owner: null, progress: [], result: null },
    ifVersion: 0,
  });
}

await phase("Create actors", { total: (JSON.parse(π.roles) as unknown[]).length });
const actors = await Promise.all(
  (JSON.parse(π.roles) as Array<{ name: string; instructions: string }>).map((role) =>
    agents.create({
      name: role.name,
      instructions: role.instructions,
      topics: [topic],
      responseMode: "directive",
      delivery: "mailbox",
      coalesce: false,
    }),
  ),
);

await phase("Dispatch", { total: actors.length });
for (const actor of actors) {
  await agents.tell({
    id: actor.id,
    message: `Join ${topic}. Inspect ready tasks under runs/${run}/tasks/ and atomically claim one matching your role.`,
  });
}

await mesh.publish({
  topic,
  kind: "run.started",
  data: { run, actors: actors.map(({ id, name }) => ({ id, name })) },
});

await workflow.event({ message: `${actors.length} actors dispatched`, level: "success" });
return { run, topic, actors, taskPrefix: `runs/${run}/tasks/` };
```

Pass generated role instructions and tasks through `strings`, not large inline literals. Keep the coordinator pull-based: inspect `mesh.read({ topic })`, task state, and actor mailboxes at decision points rather than continuously polling in one Fabric execution.

## Steering running workers across the team

`agents.tell` enqueues mail for a persistent actor; for a **running one-shot subagent** use `agents.steer({ id, message })`, which is delivered between the child's turns and preserves its context. Any agent can steer any other: `agents.steer` routes to a local subagent/actor directly, and for an id in another process it publishes a `fabric.steer` mesh event the owner relays. Use `agents.steer` to redirect a teammate's running worker without discarding its work.
