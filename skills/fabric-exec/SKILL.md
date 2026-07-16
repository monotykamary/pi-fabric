---
name: fabric-exec
description: >-
  Reference for writing `fabric_exec` TypeScript programs in the QuickJS
  sandbox: the mental model (one program, return only the final value), the
  core `pi` tools (read/bash/edit/write/grep/find/ls) with exact signatures,
  `tools` discovery and introspection, `π` named strings,
  and the validate, describe, retry error loop. Load before your first
  `fabric_exec` call and whenever a call errors on argument shape. MCP is
  discoverable via `tools`; see `references/mcp.md`.
---

# fabric_exec — core reference

One type-checked TS program in a QuickJS sandbox. Only the `return` value reaches the model; `print()`/`console.log` go to the activity panel. `π` is not a tool.

## `pi` core tools (full code mode only)
`pi.<tool>(arg)` — single arg: bare string (primary field) or options object. Multi-arg positional calls are accepted for `grep`/`find` (`pattern, path, limit`), `write` (`path, content`), and `edit` (`path, oldText, newText`); one-field tools (`read`/`bash`/`ls`) stay single-arg — a 2-arg call on those is a type error so the extra arg isn't silently dropped.

| Tool | Form | Returns |
|------|------|---------|
| `read` | `path` \| `{path,offset?,limit?}` | `string` |
| `bash` | `command` \| `{command,timeout?}` | `{ok,output,details}` |
| `grep` | `pattern` \| `{pattern,path?,glob?,ignoreCase?,literal?,context?,limit?}` \| `(pattern, path?, limit?)` | `string` |
| `find` | `pattern` \| `{pattern,path?,limit?}` \| `(pattern, path?, limit?)` | `string` |
| `ls` | `path?` \| `{path?,limit?}` | `string` |
| `edit` | `{path,edits:[{oldText,newText}]}` \| `{path,oldText,newText}` \| `(path, oldText, newText)` | `{ok,output,details}` |
| `write` | `{path,content}` \| `(path, content)` | `{ok,output,details}` |

Aliases (normalized to canonical before the host validates args): `cmd`/`shell`/`cmdline`→`command`, `timeoutMs`→`timeout`; `query`/`regex`/`search`→`pattern`; `ic`/`caseInsensitive`→`ignoreCase`; `globPattern`→`glob`; `ctx`→`context`; `max`→`limit`; `file`/`dir`→`path`; `start`→`offset`; `old`→`oldText`; `new`/`replacement`→`newText`; `contents`/`body`/`text`→`content`. Misspelled keys still fail the excess-property type check.

## `tools` — discovery & generic calls
Refs namespaced: `pi.grep`, `extensions.<tool>`, `mcp.<server>.<tool>`; bare names rejected. `tools.providers()`→`[{name,description}]` · `tools.search({query,limit?})`→`FabricAction[]`(`ref,name,description,inputSchema,risk`) · `tools.describe({ref})`→full `FabricAction` (read `inputSchema` first) · `tools.call({ref,args?})` · `tools.list({provider?,namespace?,query?,limit?})` · `tools.models()`→`[{provider,id,name,key}]` (canonical `key` is `"provider/id"`; pass it to `agents.run`/`agents.create` `model` — a bare id may not resolve) · `extensions.<tool>(args)` (full code mode only). Calling a core-tool name on `tools` (e.g. `tools.read(...)`) throws with a hint to use `pi.read(...)` instead of a generic not-a-function error.

## Error recovery: read, describe, retry
Read the line-numbered error → `await tools.describe({ref})` for the schema → match `inputSchema`, rerun (don't guess). Common mistakes: bare ref (`grep`→`pi.grep`); 2 positional args on `read`/`bash`/`ls` (use an options object — positional is supported only for `grep`/`find`/`write`/`edit`).

## Other surfaces (opt-in)
MCP tools are discoverable via `tools` (`mcp.<server>.<tool>`); see `references/mcp.md`. Multi-agent orchestration is opt-in: load `/skill:fabric-workflow`, `/skill:fabric-council`, `/skill:fabric-rlm`, or `/skill:fabric-fusion` (API detail in `references/agents.md`, `references/mesh.md`).
