---
name: fabric-council
description: Runs a bounded multi-perspective Pi Fabric council with independent reviewers and best-effort synthesis. Use for architecture choices, plans, reviews, and adversarial cross-checking.
disable-model-invocation: true
---

# Fabric Council — Python

Use one Python `fabric_exec`. Pass `payloads.task` and a JSON array in `payloads.roles`. Choose 3–5 distinct non-empty roles with useful disagreements, not redundant reviewers. Label the outer `display` and every child.

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

roles = []
for role in json.loads(π.roles):
    role = role.strip()
    if role and role not in roles:
        roles.append(role)
if len(roles) < 3 or len(roles) > 5:
    raise ValueError("Council requires 3–5 distinct non-empty roles.")

async def review(role):
    try:
        report = await ask("Act as the " + role + " council member. Independently analyze:\n" + π.task, role)
        return {"role": role, "status": "completed", "report": report}
    except Exception as error:
        return {"role": role, "status": "failed", "error": str(error)}

outcomes = await asyncio.gather(*[review(role) for role in roles])
completed = [item for item in outcomes if item["status"] == "completed"]
failures = [item for item in outcomes if item["status"] == "failed"]
coverage = {"requested": len(roles), "completed": len(completed)}
if not completed:
    return {"status": "failed", "coverage": coverage, "failures": failures, "result": None}
if len(completed) == 1:
    return {"status": "partial", "coverage": coverage, "failures": failures, "result": completed[0]["report"], "synthesisSkipped": "Only one role completed; another agent adds no diversity."}
try:
    result = await ask("Synthesize only the completed reports into one decision. Reject unsupported claims, preserve material disagreements, and attribute concerns to roles. Never infer views of failed roles.\nTask:\n" + π.task + "\nReports:\n" + json.dumps(completed), "council synthesis")
    return {"status": "partial" if failures else "success", "coverage": coverage, "failures": failures, "result": result}
except Exception as error:
    return {"status": "partial", "coverage": coverage, "failures": failures, "result": None, "synthesisError": str(error), "fallback": completed}
```

Reserve at least the role count plus one agent call. Concurrency remains host-limited; usage settles afterward, not as a hard token reservation. Successful synthesis returns only the compact decision; raw reports return only on synthesis failure. A partial result is useful evidence with named gaps, not permission for an automatic whole-council rerun. Retry only the failed role or synthesis when needed. Do not use a council for a lookup.
