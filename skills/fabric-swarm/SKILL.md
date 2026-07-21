---
name: fabric-swarm
description: Creates a self-organizing team of persistent Pi Fabric actors with durable topics, mailboxes, and compare-and-swap tasks. Use for messenger-like collaboration and long-lived delegated work.
disable-model-invocation: true
---

# Fabric Swarm

Build from Fabric primitives; do not install a messenger or swarm extension.

- Persistent identities: `agents.create`; asynchronous delegation: `agents.tell` (`ask` only when blocking is necessary).
- Durable events and history: `mesh.publish` / `mesh.read`; presence: `mesh.members`.
- Atomic claims, leases, and decisions: `mesh.put({ ..., ifVersion })`.

Choose a short run key and topic such as `team.auth-migration`. Store tasks under `runs/<run>/tasks/<id>` with `ifVersion: 0`; include `title`, `status`, `owner`, `dependencies`, `progress`, and `result`.

Actor instructions must require workers to read and CAS-claim a task, stop after a failed claim, publish progress, CAS-update blocked/completed state, direct questions with `mesh.publish({ topic, to, ... })`, respect path ownership, and emit directives only for blockers or final results.

```ts
const run = π.run;
const topic = `team.${run}`;
const tasks = JSON.parse(π.tasks) as Array<{ id: string; title: string; detail: string }>;
const roles = JSON.parse(π.roles) as Array<{ name: string; instructions: string }>;

await workflow.configure({
  name: `Swarm · ${run}`,
  description: "Persistent actors coordinating through durable shared tasks",
});
await phase("Seed tasks", { total: tasks.length });
for (const task of tasks) {
  await mesh.put({
    key: `runs/${run}/tasks/${task.id}`,
    value: { ...task, status: "ready", owner: null, progress: [], result: null },
    ifVersion: 0,
  });
}

await phase("Create actors", { total: roles.length });
const actors = await Promise.all(
  roles.map((role) =>
    agents.create({
      name: role.name,
      runner: "pi",
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
return { run, topic, actors, taskPrefix: `runs/${run}/tasks/` };
```

Pass tasks and role instructions through `strings`. Keep coordination pull-based: inspect topic history, task state, and mailboxes at decision points rather than polling continuously inside one execution. Partition file ownership. Use `agents.steer` only for a running one-shot worker; persistent actors receive `tell`/`ask` mail.
