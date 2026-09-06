---
name: fabric-swarm
description: Creates a self-organizing team of persistent Pi Fabric actors with durable topics, mailboxes, and compare-and-swap tasks. Use for messenger-like collaboration and long-lived delegated work.
disable-model-invocation: true
---

# Fabric Swarm — Python

Build from persistent actors and durable mesh primitives, not an external swarm extension. Pass `payloads.run`, JSON `payloads.tasks` (id, title, detail, optional dependencies), and JSON `payloads.roles` (name, instructions). Choose a fresh run key; seed with `ifVersion=0`.

Actor instructions must require: verify dependencies are complete; claim only ready tasks with the observed version; stop after a failed claim; publish progress; update blocked/completed state using each successful operation's returned version; CAS-unblock dependents only when all dependencies complete; direct questions via `mesh.publish(topic=..., to=...)`; respect path ownership; emit directives only for blockers/final results.

```python
import json
run = π.run
topic = "team." + run
tasks = json.loads(π.tasks)
roles = json.loads(π.roles)
seeded = []
actors = []
dispatched = []
try:
    for task in tasks:
        value = dict(task)
        value.update({"dependencies": task.get("dependencies", []), "status": "blocked" if task.get("dependencies") else "ready", "owner": None, "progress": [], "result": None})
        await mesh.put(key="runs/" + run + "/tasks/" + task["id"], value=value, ifVersion=0)
        seeded.append(task["id"])
    for role in roles:
        actor = await agents.create(name=role["name"], runner="pi", instructions=role["instructions"], topics=[topic], responseMode="directive", delivery="mailbox", coalesce=False)
        actors.append({"id": actor["id"], "name": actor["name"]})
    for actor in actors:
        await agents.tell(id=actor["id"], message="Join " + topic + ". Inspect ready tasks under runs/" + run + "/tasks/ and atomically claim one matching your role.")
        dispatched.append(actor["id"])
    await mesh.publish(topic=topic, kind="run.started", data={"run": run, "actors": actors})
    return {"status": "success", "run": run, "topic": topic, "actors": actors, "taskPrefix": "runs/" + run + "/tasks/"}
except Exception as error:
    return {"status": "partial" if seeded or actors else "failed", "run": run, "topic": topic, "seeded": seeded, "actors": actors, "dispatched": dispatched, "error": str(error)}
```

Seeding, actor creation, and dispatch are sequential so failures retain exact completed identities. On partial setup, inspect state/mailboxes before retrying; never automatically replay successful creation or messages. Keep coordination pull-based at decision points, not continuous polling. Persistent actors receive `tell`/`ask`; `agents.steer` redirects running one-shot workers. Do not return transcripts or task bodies unnecessarily.
