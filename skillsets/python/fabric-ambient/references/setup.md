# Ambient actor setup — Python

Pass `payloads.name`, `payloads.instructions`, JSON `payloads.events`, `payloads.triggerTurn` (`"true"`/`"false"`), and `payloads.model` (key/substring; empty when unset). Run the whole program in one Python `fabric_exec`; do not switch interpreters or load another tree.

```python
import json

events = json.loads(π.events)
trigger_turn = π.triggerTurn == "true"
desired_tools = ["read", "grep", "find", "ls"]
model = None
runner = None
if π.model:
    models = [dict(entry, runner="pi") for entry in await tools.models()]
    try:
        models.extend([dict(entry, runner="claude") for entry in await agents.models(runner="claude")])
    except Exception:
        pass
    needle = π.model.lower()
    matches = [entry for entry in models if entry["key"].lower() == needle]
    if not matches:
        matches = [entry for entry in models if needle in entry["id"].lower() or needle in entry["name"].lower()]
    if len(matches) != 1:
        raise ValueError("Model not found or ambiguous: " + π.model + "; candidates: " + ", ".join([entry["key"] for entry in matches or models]))
    model = matches[0]["key"]
    runner = matches[0]["runner"]
existing = None
for actor in await agents.actors():
    if actor["name"] == π.name and actor["status"] != "stopped":
        existing = actor
        break
if existing:
    warnings = []
    if existing["status"] != "idle":
        warnings.append("actor is " + existing["status"] + "; wait until idle or stop it before reconfiguration")
    if existing["responseMode"] != "directive":
        warnings.append("recreate for responseMode=directive")
    if existing.get("coalesce") is not True:
        warnings.append("recreate for coalesce=true")
    if existing["topics"]:
        warnings.append("recreate without topic subscriptions")
    if runner and existing["runner"] != runner:
        warnings.append("runner requires recreation")
    if model and existing["model"] != model:
        warnings.append("model requires a dashboard change or recreation")
    if existing["runner"] == "pi" and existing.get("kernel") != "python":
        warnings.append("kernel requires recreation")
    if warnings:
        return {"reused": False, "actor": existing, "warnings": warnings}
    await agents.setInstructions(id=existing["id"], instructions=π.instructions)
    if sorted(existing.get("tools") or []) != sorted(desired_tools):
        await agents.setTools(id=existing["id"], tools=desired_tools)
    if sorted(existing["events"]) != sorted(events):
        await agents.setEvents(id=existing["id"], events=events)
    if existing["delivery"] != "steer" or existing.get("triggerTurn") != trigger_turn:
        await agents.setDeliveryPolicy(id=existing["id"], delivery="steer", triggerTurn=trigger_turn)
    return {"reused": True, "actor": await agents.actorStatus(id=existing["id"]), "warnings": []}
request = {"name": π.name, "instructions": π.instructions, "events": events, "responseMode": "directive", "delivery": "steer", "triggerTurn": trigger_turn, "coalesce": True, "tools": desired_tools}
if runner:
    request["runner"] = runner
if model:
    request["model"] = model
actor = await agents.create(request)
return {"started": True, "actor": actor}
```

Reuse updates instructions/events/delivery/native tools only after checking compatibility. Runner, model, kernel, response mode, coalescing, or topic changes require operator remediation; never automatically recreate or retry. Extension/provider availability follows the configured runner and actor extension policy. Pi actors inherit the Python kernel at creation; Claude actors stay native. Report ID, warnings, and messages/stop commands; do not wait.
