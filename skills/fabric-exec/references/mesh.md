# Durable coordination reference

`mesh` is a project-scoped, event-sourced coordination substrate. With persistent actors (see `agents.md`) it is sufficient to express messenger-style swarms without a daemon or fixed planner/worker roles. For the sandbox model, see the parent `fabric-exec` skill.

Every method takes a single options object. Mesh data defaults to `<project>/.pi/fabric/mesh`; relocate it with `mesh.root` in config, and add `.pi/fabric/mesh/` to your ignore file unless you intentionally version the coordination log.

## Identity and presence

- `mesh.self()` returns the caller's wire identity `{ id, name, kind, sessionId? }`, where the legacy wire `kind` is `main`, `actor`, or `agent`.
- `mesh.members({ scope?, kinds?, includeStale?, limit? })` returns the same `FabricParticipantInfo[]` as `agents.members`: intrinsic roots, agents, and actors with `rootId`, optional `parentId`, `ownerHostId`, status, capabilities, and `local`/`stale` flags. `scope` defaults to `"project"`.
- `agents.self()` is the richer intrinsic identity (`kind: "root" | "agent" | "actor"`). `agents.main()` and `agents.peers()` are compatibility views derived from root participants.

The directory stores participant records separately from short-lived execution-host leases. If a host crashes, all records owned by that host become stale atomically from the reader's perspective. Normal discovery excludes them; `includeStale: true` is diagnostic.

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

Each entry is `{ key, value, version, updatedAt, updatedBy }`. Use `ifVersion` for task claims, leases, reservations, and decisions: create with `ifVersion: 0`, claim by passing the current `version`. Keys below `topology/`, `sessions/`, and `actors/` are host-reserved and reject guest `put`/`delete`; use an application prefix such as `tasks/` or `team/`.

```ts
const task = await mesh.put({ key: "tasks/auth-review", value: { status: "ready", owner: null }, ifVersion: 0 });
const claimed = await mesh.put({ key: task.key, value: { status: "claimed", owner: "security-reviewer" }, ifVersion: task.version });
return claimed;
```

## Steering across processes

Use `agents.steer`, `agents.followUp`, or `agents.stop` rather than publishing a control topic yourself. Fabric resolves the target in the participant directory, addresses `fabric.control.command` to its `ownerHostId`, and waits for a version/target/owner-identity-matched `fabric.control.ack`. Unknown targets, stale owners, rejection, and acknowledgement timeout fail explicitly. The stable `"main"` alias is resolved locally to the caller's exact root id before routing.

The entire `fabric.control.*` namespace is reserved for internal protocol topics, not application channels. `fabric.steer` remains a mixed-version compatibility path for older Fabric participants; direct publication on it has legacy best-effort semantics and no acknowledgement.

## Notes

- Actors subscribe to topics via `agents.create({ topics: [...] })` (see `agents.md`); published events are delivered as `mesh:<topic>` messages.
- Set `mesh.enabled: false` in config to disable both mesh actions and ambient actor restoration.
