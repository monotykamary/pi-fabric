---
name: fabric-rlm
description: Recursively decomposes oversized tasks into bounded child Pi agents with fresh context windows. Use for whole-repo audits, massive-context analysis, and multi-file refactors that do not fit one context.
disable-model-invocation: true
---

# Fabric Recursive Decomposition — Python

Use recursion for context size, not mere difficulty. Pass only the objective as `payloads.task`. Orient → delegate non-overlapping context-sized partitions → combine in one Python `fabric_exec`. Python calls `agents.run(runner="pi", recursive=True, ...)` directly for oversized partitions, not guest callback helpers. Plain leaves explicitly use `recursive=False`.

## Context is an external variable

Keep source handles, partitions, and intermediate findings guest-local for this invocation. Children inspect paths or receive bounded slices, never the whole corpus. Guest bindings end with each call. For continuation across turns, persist JSON under root-scoped `rlm/<rootId>/bindings/...` mesh keys; send keys rather than values. For values above the mesh event limit use project-relative files plus digests. Mesh data is project-visible with no automatic TTL: no secrets; clean it up after completion. `state` is for claims and evidence, not scratch data.

```python
import asyncio
import json

async def ask(task, name, recursive=False, output_schema=None):
    request = {"task": task, "name": name, "runner": "pi", "recursive": recursive, "tools": ["read", "grep", "find", "ls"]}
    if output_schema:
        request["schema"] = output_schema
    result = await agents.run(request)
    if result["status"] != "completed":
        raise RuntimeError(result.get("error") or result["status"])
    return result["value"] if result.get("value") is not None else result["text"]

partition_schema = {"type": "object", "properties": {"partitions": {"type": "array", "maxItems": 12, "items": {"type": "object", "properties": {"label": {"type": "string"}, "paths": {"type": "array", "items": {"type": "string"}}, "recursive": {"type": "boolean"}}, "required": ["label", "paths", "recursive"], "additionalProperties": False}}}, "required": ["partitions"], "additionalProperties": False}
scope = await ask("Partition relevant material into at most 12 non-overlapping context-sized groups. Set recursive=true only if a group cannot fit a child context.\nTask:\n" + π.task, "scope", output_schema=partition_schema)
proposed = scope["partitions"]
failures = []
candidates = []
for index in range(len(proposed)):
    partition = proposed[index]
    label = partition["label"].strip() or "partition-" + str(index + 1)
    paths = []
    for raw in partition["paths"]:
        value = raw.strip().replace("\\", "/")
        while value.startswith("./"):
            value = value[2:]
        while "//" in value:
            value = value.replace("//", "/")
        paths.append(value.rstrip("/"))
    invalid = not paths or any(not value or value in [".", "~"] or value.startswith("~/") or value.startswith("/") or value[1:3] == ":/" or ".." in value.split("/") for value in paths)
    if invalid:
        failures.append({"partition": label, "paths": paths, "status": "not_started", "error": "partition paths must be non-empty project-relative paths without '~' or '..'"})
        continue
    for value in paths:
        candidates.append([len(value.split("/")), len(value), index, label, value])
selected = []
grouped = {}
promoted = []
merged = []
for candidate in sorted(candidates):
    index, label, value = candidate[2], candidate[3], candidate[4]
    covered = None
    for entry in selected:
        if value == entry["path"] or value.startswith(entry["path"] + "/"):
            covered = entry
            break
    if covered:
        merged.append({"partition": label, "path": value, "coveredBy": covered["path"]})
        if proposed[index]["recursive"]:
            promoted.append(covered["index"])
        continue
    selected.append({"path": value, "index": index})
    if index not in grouped:
        grouped[index] = []
    grouped[index].append(value)
partitions = []
for index in range(len(proposed)):
    if index in grouped:
        partitions.append({"label": proposed[index]["label"].strip() or grouped[index][0], "paths": grouped[index], "recursive": proposed[index]["recursive"] or index in promoted})
normalization = {"proposed": len(proposed), "effective": len(partitions), "dispatched": 0, "mergedOverlaps": merged}
if not partitions:
    return {"status": "failed" if proposed else "success", "coverage": {"requested": len(proposed), "dispatched": 0, "completed": 0}, "failures": failures, "normalization": normalization, "result": None if proposed else "No relevant partitions were found."}
runnable = []
recursive_roots = 0
for partition in partitions:
    if partition["recursive"] and recursive_roots >= 2:
        failures.append({"partition": partition["label"], "paths": partition["paths"], "status": "not_started", "error": "recursive root limit reached"})
        continue
    if partition["recursive"]:
        recursive_roots += 1
    runnable.append(partition)

async def analyze(partition):
    task = "Analyze this bounded partition using paths as external context. Return compact evidence-backed findings.\nPartition: " + partition["label"] + "\nPaths:\n" + "\n".join(partition["paths"]) + "\nObjective:\n" + π.task
    try:
        finding = await ask(task, (("recurse " if partition["recursive"] else "analyze ") + partition["label"])[:50], recursive=partition["recursive"])
        return {"partition": partition["label"], "status": "completed", "finding": finding}
    except Exception as error:
        return {"partition": partition["label"], "paths": partition["paths"], "status": "failed", "error": str(error)}

outcomes = []
for offset in range(0, len(runnable), 4):
    batch = runnable[offset:offset + 4]
    settled = await asyncio.gather(*[analyze(partition) for partition in batch])
    outcomes.extend(settled)
    if all(item["status"] == "failed" for item in settled):
        failures.extend([{"partition": item["label"], "paths": item["paths"], "status": "not_started", "error": "not started after an all-failed batch"} for item in runnable[offset + len(batch):]])
        break
completed = [item for item in outcomes if item["status"] == "completed"]
failures.extend([item for item in outcomes if item["status"] == "failed"])
normalization["dispatched"] = len(outcomes)
coverage = {"requested": len(proposed), "dispatched": len(outcomes), "completed": len(completed)}
if not completed:
    return {"status": "failed", "coverage": coverage, "failures": failures, "normalization": normalization, "result": None}
if len(completed) == 1:
    return {"status": "partial" if failures else "success", "coverage": coverage, "failures": failures, "normalization": normalization, "result": completed[0]["finding"], "synthesisSkipped": "One partition completed"}
try:
    result = await ask("Synthesize only completed findings, reconcile duplicates and contradictions, drop unsupported claims, and never infer failed partitions.\nObjective:\n" + π.task + "\nFindings:\n" + json.dumps(completed), "combine")
    return {"status": "partial" if failures else "success", "coverage": coverage, "failures": failures, "normalization": normalization, "result": result}
except Exception as error:
    return {"status": "partial", "coverage": coverage, "failures": failures, "normalization": normalization, "result": None, "synthesisError": str(error), "fallback": completed}
```

Reserve agent capacity for orientation and synthesis. At most two top-level partitions recurse, batches are four, and an all-failed batch stops new spend. The host depth ceiling bounds descendants; `agents.maxDepth=0` disables spawning. Settled usage is observational under concurrency, not a reservation. Initial recursive approval delegates only agent risk, not network/execute/write. Partition edit ownership or use `worktree=True`. Redirect valuable running children rather than discarding their context.

Only compact findings return on fallback, never full FabricAgentResult objects. Preserve paths for targeted retries. `partial` is useful evidence with named gaps; never automatically rerun successful partitions or the whole tree.
