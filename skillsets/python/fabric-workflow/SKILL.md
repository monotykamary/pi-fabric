---
name: fabric-workflow
description: Runs a dynamic Pi Fabric workflow with code-held phases, fan-out, pipelines, structured agents, and best-effort verification. Use for large audits, migrations, parallel research, or explicit workflow requests.
disable-model-invocation: true
---

# Fabric Dynamic Workflow — Python

Use one Python `fabric_exec` with top-level `payloads.task`. Keep phases in code and label the outer `display` and every agent. Python uses host `agents.run` plus bounded `asyncio.gather`, not guest workflow/callback helpers. Child structured output is in the native result dictionary's `value`; a returned failed status is not success.

```python
import asyncio
import json

async def ask(task, name, options=None):
    request = {"task": task, "name": name, "tools": ["read", "grep", "find", "ls"]}
    if options:
        request.update(options)
    result = await agents.run(request)
    if result["status"] != "completed":
        raise RuntimeError(result.get("error") or result["status"])
    return result["value"] if result.get("value") is not None else result["text"]

inventory = await ask("Discover at most 32 bounded work items for this objective:\n" + π.task, "inventory", {
    "schema": {"type": "object", "properties": {"items": {"type": "array", "maxItems": 32, "items": {"type": "string"}}}, "required": ["items"], "additionalProperties": False}
})
items = []
for item in inventory["items"]:
    item = item.strip()
    if item and item not in items:
        items.append(item)
if not items:
    return {"status": "success", "coverage": {"requested": 0, "completed": 0}, "failures": [], "result": "No bounded work items were found."}

async def analyze(item):
    try:
        finding = await ask("Analyze this bounded item with evidence: " + item + "\nObjective:\n" + π.task, ("analyze " + item)[:50])
        return {"item": item, "status": "completed", "finding": finding}
    except Exception as error:
        return {"item": item, "status": "failed", "error": str(error)}

outcomes = []
for offset in range(0, len(items), 8):
    batch = items[offset:offset + 8]
    settled = await asyncio.gather(*[analyze(item) for item in batch])
    outcomes.extend(settled)
    if all(item["status"] == "failed" for item in settled):
        outcomes.extend([{"item": item, "status": "not_started", "error": "not started after an all-failed batch"} for item in items[offset + len(batch):]])
        break
completed = [item for item in outcomes if item["status"] == "completed"]
failures = [item for item in outcomes if item["status"] != "completed"]
coverage = {"requested": len(items), "completed": len(completed)}
if not completed:
    return {"status": "failed", "coverage": coverage, "failures": failures, "result": None}
try:
    result = await ask("Adversarially verify only these completed findings; drop unsupported claims and do not infer anything about failed items.\nObjective:\n" + π.task + "\nFindings:\n" + json.dumps(completed), "verify synthesis")
    return {"status": "partial" if failures else "success", "coverage": coverage, "failures": failures, "result": result}
except Exception as error:
    return {"status": "partial", "coverage": coverage, "failures": failures, "result": None, "verificationError": str(error), "fallback": completed}
```

Adapt tools to the request. Partition path ownership or use `worktree=True` before concurrent editing. Keep intermediate data guest-local; successful verification returns compact output. `partial` is usable: never automatically rerun the whole workflow or successful items. Retry only missing coverage. Stop new work after an all-failed batch. Reserve agent capacity for discovery and verification; usage/budget checks are observational under concurrency. Python has no top-level `tokenBudget` callback-helper budget. Use `agents.spawn` and `agents.steer` only when a long-running worker benefits from redirection between turns.
