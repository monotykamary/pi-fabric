# Durable coordination — Python

Mesh is project-scoped event-sourced coordination. Defaults live below `.pi/fabric/mesh`; do not store secrets, and ignore coordination logs unless intentionally versioning them. Every call is awaited with a dict or keyword arguments; results are native dicts/lists. Actor details are in [agents.md](agents.md).

## Identity and topics

`await mesh.self()` returns legacy wire identity id/name/kind/sessionId; `await agents.self()` exposes richer root/agent/actor identity. `mesh.members` and `agents.members` expose participants with owners, capabilities, roots, local/stale flags. Host leases expire together after crashes; stale members are excluded unless explicitly requested for diagnosis.

`mesh.publish` takes topic and optional kind/to/text/data, returning an event. `mesh.read` takes after/topic/to/limit and returns events containing id, sequence, topic, kind, from, optional to/text/data, and createdAt. Persist sequence cursors rather than repeatedly dumping history.

```python
await mesh.publish(topic="team.auth", kind="finding", text="Refresh-token rotation is not atomic", data={"path": "src/auth/refresh.ts"})
return await mesh.read(topic="team.auth", limit=50)
```

## Compare-and-swap state

`mesh.get(key=...)` returns an entry or None; entries have key/value/version/updatedAt/updatedBy. `mesh.put` takes key/value and optional ifVersion; create with 0, update/claim with the observed version. `mesh.delete` accepts key/ifVersion and returns deleted/version. `mesh.list` accepts prefix/limit.

```python
task = await mesh.put(key="tasks/auth-review", value={"status": "ready", "owner": None}, ifVersion=0)
return await mesh.put(key=task["key"], value={"status": "claimed", "owner": "security-reviewer"}, ifVersion=task["version"])
```

A failed claim means stop and re-read; never overwrite a competitor's version. Check dependencies before claiming ready work and CAS-unblock dependents only after every dependency completes. Application prefixes such as tasks/ or runs/ are appropriate; topology/, sessions/, and actors/ are host-reserved.

Use `agents.steer`, `followUp`, and `stop` for participant control. fabric.control.* and fabric.participant.lifecycle are reserved protocol topics, not application channels. Direct legacy fabric.steer publication is not an acknowledged control API. Actors subscribe with topics on agents.create; event delivery uses mesh:<topic>. mesh.enabled=False disables mesh actions and ambient restoration. Keep coordination pull-based at decision points; no model-authored polling loops.
