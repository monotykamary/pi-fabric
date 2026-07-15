# Durable coordination reference

`mesh` is a project-scoped, event-sourced coordination substrate. With persistent actors (see `agents.md`) it is sufficient to express messenger-style swarms without a daemon or fixed planner/worker roles. For the sandbox model, see the parent `fabric-exec` skill.

Every method takes a single options object. Mesh data defaults to `<project>/.pi/fabric/mesh`; relocate it with `mesh.root` in config, and add `.pi/fabric/mesh/` to your ignore file unless you intentionally version the coordination log.

## Identity and presence

- `mesh.self()` returns `{ id, name, kind, sessionId? }` where `kind` is `main`, `actor`, or `agent`.
- `mesh.members({ limit? })` returns actor presence across live Fabric sessions as entries with `{ key, value, version, updatedAt, updatedBy }` (the `value` is a `FabricActorInfo`).

## Topics (durable channels)

- `mesh.publish({ topic, kind?, to?, text?, data? })` returns a `FabricMeshEvent`. Use `to` for a direct message.
- `mesh.read({ after?, topic?, to?, limit? })` returns `FabricMeshEvent[]` by cursor, topic, or recipient. Each event has `{ id, sequence, topic, kind, from, to?, text?, data?, createdAt }`.

Topics provide durable channel and direct-message semantics with sequence cursors.

```ts
await mesh.publish({ topic: "team.auth", kind: "finding", text: "Refresh-token rotation is not atomic", data: { path: "src/auth/refresh.ts" } });
const events = await mesh.read({ topic: "team.auth", limit: 50 });
```

## Shared state (compare-and-swap)

- `mesh.get({ key })` returns a `FabricMeshStateEntry` or null.
- `mesh.put({ key, value, ifVersion? })` creates or updates; `ifVersion` enables optimistic compare-and-swap.
- `mesh.delete({ key, ifVersion? })` returns `{ deleted, version? }`.
- `mesh.list({ prefix?, limit? })` returns matching entries.

Each entry is `{ key, value, version, updatedAt, updatedBy }`. Use `ifVersion` for task claims, leases, reservations, and decisions: create with `ifVersion: 0`, claim by passing the current `version`.

```ts
const task = await mesh.put({ key: "tasks/auth-review", value: { status: "ready", owner: null }, ifVersion: 0 });
const claimed = await mesh.put({ key: task.key, value: { status: "claimed", owner: "security-reviewer" }, ifVersion: task.version });
return claimed;
```

## Steering across processes

`fabric.steer` is a reserved topic the ActorManager relays to a local subagent or actor, so any agent in one Pi process can steer an agent in another. `agents.steer({ id, message })` publishes to it automatically when the id is not local to this process; you can also publish directly:

```ts
await mesh.publish({
  topic: "fabric.steer",
  kind: "steer",
  to: actorOrSubagentId,
  text: "redirect from a peer",
});
```

Use `kind: "followUp"` for a follow-up. The owning process's poll reads the event and forwards it as a steer (between turns) to a one-shot subagent, or as a mailbox message to a persistent actor. An event addressed to a target no process owns is dropped best-effort.

## Notes

- Actors subscribe to topics via `agents.create({ topics: [...] })` (see `agents.md`); published events are delivered as `mesh:<topic>` messages.
- Set `mesh.enabled: false` in config to disable both mesh actions and ambient actor restoration.
