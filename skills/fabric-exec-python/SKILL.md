---
name: fabric-exec-python
description: >-
  Python-only troubleshooting and advanced host API reference for fabric_exec.
  Routine pi.* coding calls are documented by ambient guidance; load this skill
  only after an argument-shape error or when an advanced surface needs exact contracts.
metadata:
  fabric-kernel: python
---

# fabric_exec — Python reference

Write a Python async function body in `code`: top-level `await` and `return`, no enclosing function or event-loop runner. Every invocation starts fresh. Only the returned JSON-compatible value reaches the model; `print()` goes to activity logs. Use `True`, `False`, `None`, native dicts/lists, and dict access for results. Never switch interpreters through shell commands to perform Fabric orchestration.

## Runtime boundary

The default Python backend is Monty, a sandboxed Python subset. Arbitrary imports, third-party packages, native filesystem/network/environment access, and some Python syntax are unavailable. Use host tools for effects. `import asyncio` and `asyncio.gather` are supported. Missing native dependencies fail without fallback. Explicit CPython is trusted native code outside Schema enforce; enforce requires OS isolation and fails closed when unavailable. Neither backend exposes guest-local workflow helpers, memory visitor callbacks, or handoff predicates.

## Core tools

Full code mode (also Schema enforce) exposes `pi` and captured `extensions`; orchestration-only mode leaves these on Pi's direct tool path instead.

```python
import asyncio
manifest, matches = await asyncio.gather(
    pi.read("package.json"),
    pi.grep(pattern="TODO", path="src", limit=20),
)
return {"manifest": manifest, "matches": matches}
```

Search before bounded reads: `await pi.find(pattern="*.py", path="src", limit=20)`, then `await pi.read(path="src/main.py", offset=1, limit=80)`. Read continuation notices; unbounded reads cap at 2000 lines or 50KB. `read`, `grep`, `find`, and `ls` return strings. Shell, edit, and write return dictionaries:

```python
r = await pi.bash(command="git status --short", settle=True)
return {"ok": r["ok"], "output": r["output"], "exitCode": r.get("exitCode")}
```

Shell nonzero exits raise unless `settle=True`; timeout, cancellation, security and approval failures still raise. Shell `timeout` is seconds. No stdin option: write content to a file first, then use its path. Do not interpolate untrusted content into shell commands.

Use top-level `payloads` for multiline content. Only exact keys supplied in this call exist: `π.body` or `payloads["body"]`. `π` is an attribute object; `payloads` is a separate dict. For a supplied `body` key, write with `await pi.write(path="notes.txt", content=π.body)`. Edit with `await pi.edit(path="notes.txt", edits=[{"oldText": "before", "newText": "after"}])`. Coalesce independent edits from one snapshot; use `all=True` only for intentional repeated anchors.

## Discovery and host actions

Known actions use `await mcp.<server>.<tool>(...)`, `await extensions.<name>(...)`, or stable providers `memory`, `state`, `schema`, `compact`, `components`, `agents`, and `mesh`. Underscore-prefixed capability names require `tools.call` with the exact discovered ref. Host methods accept one dict or keyword arguments, not callback functions. Supply acyclic JSON-compatible arguments.

```python
hits = await tools.search(query="deployment status", limit=3)
if not hits:
    return None
return await tools.describe(ref=hits[0]["ref"])
```

Inspect `inputSchema` and `outputSchema` before calling a dynamic action. `await tools.call(ref=ref, args=args)` invokes a computed ref; bare tool names are invalid. `tools` provides discovery and generic calls, not core I/O. Captured extension results are dicts containing `text`, `content`, `details`, and `isError`; MCP results are server-defined. Do not assume attribute access on returned dictionaries.

## Memory, state, and orchestration

`memory.recall` searches evidence; catalog descriptions are navigation, not evidence. Follow returned `follow` and `next` dictionaries with `await tools.call(hit["follow"])` and `await tools.call(result["next"])`. Use `memory.expand` and explicit loops for paging, not guest callback helpers. Do not parse Pi session JSONL manually. Discover exact schemas with `tools.describe` rather than guessing fields.

`state` records claims and verification. Under Schema enforce, protected changes must use `schema.hypothesize`, `schema.verify`, and `schema.commit` in one invocation; do not bypass host gates. `compact.request` requests compaction rather than running an alternate executor.

Advanced agent/mesh workflows require explicit user intent. Peer means another root Pi session: query `await agents.peers()` first, not child-agent lists. Agent calls inherit this kernel unless a child's language is explicitly selected; that does not change this program's language. Omit agent `timeoutMs` unless requesting longer than the configured default. Use discovered host actions with ordinary loops and `asyncio.gather`; do not load incompatible workflow skills or launch another interpreter to run their programs.

## Recovery

Read the reported user line and recovery hint, describe the failing action, then repair only the failed syntax or call. Do not replay successful effects blindly. Convert sets, bytes, paths, and datetimes to JSON-compatible data before returning. Unsupported Monty syntax/imports are not permission to enable native execution or switch languages.
