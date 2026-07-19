---
name: fabric-exec
description: >-
  Reference for writing `fabric_exec` TypeScript programs in the QuickJS
  sandbox: the mental model (one program, return only the final value), the
  core `pi` tools (read/bash/edit/write/grep/find/ls) with exact signatures,
  `tools` discovery, `π` named strings, first-class Fabric provider and MCP
  proxies, and the validate, describe, retry error loop. Load before your first
  `fabric_exec` call and whenever a call errors on argument shape. See
  `references/mcp.md` for MCP naming and management.
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

## First-class provider calls
Use direct proxies when the action is known. No-argument actions such as `schema.status()`, `state.get()`, and `compact.status()` take no options object. Provider calls still cross the same registry validation, approval, audit, timeout, and cancellation path as generic calls.

### Stable provider return shapes

All calls return promises. Fields ending in `?` are optional; `unknown` marks provider data whose nested schema is not stable at this surface.

| Call | Resolves to |
|------|-------------|
| `memory.recall(args?)` | `{scope?,branches?,query?,queryMode?,matchedCount?,totalMatches?,totalItems?,segmentCount?,segments?,digestHits?,items?,page?,pageSize?,hasNext?,coverage?,text?,error?}` |
| `memory.expand(args)` | `{session?,sourceHash?,branches?,lineageFingerprint?,expanded?:unknown[],error?}` |
| `memory.sessions(args?)` | `{scope?,branches?,sessions?:SessionInfo[],error?}`; slice `result.sessions ?? []`, not the wrapper |
| `state.transition(args)` | `{event:FabricMeshEvent,head:unknown}` |
| `state.get()` | `{head,goal,complexity,certification,recentLabels:string[]}` |
| `state.history(args?)` | `{transitions:unknown[],labels:string[],certifications:unknown[]}` |
| `state.complexity(args?)` | `{files:ComplexityFile[],netDelta:number}` |
| `state.verify(args?)` | `{certified,violated,certificationStatus,results,failures,certificate?,reportingError?,evidenceDigest,resultDigest}` |
| `state.goal(args)` | mesh state entry `{key,value,version,updatedAt,updatedBy}` |
| `state.checkGoal(args?)` | `{passed:boolean,output:string,exitCode:number\|null,error?}` |
| `schema.status()` | `{mode,certificateTtlMs,maxFiles,maxBytes,trustedCommands,generation,lastOutcome,hypotheses}` |
| `schema.hypothesize(args)` | `{hypothesisId,status,state,fingerprint,generation}` |
| `schema.verify(args)` | `{verified,hypothesisId,certificate?,issuedAt?,expiresAt?,reason?,results}` |
| `schema.commit(args)` | `{outcome,transactionId,generation?,paths?,postconditions?,complexityReductionCertified?,stateTransition?,error?,rollbackError?}` |
| `schema.abort(args)` | `{aborted:true,hypothesisId}` |
| `compact.request(args?)` | `{requested:true,intent:{reason?,instructions?,preserve?,requestedBy,requestedAt}}` |
| `compact.status()` | `{pending?:CompactIntent,last?:{at,requestedBy,status,summary?,tokensBefore?,estimatedTokensAfter?,error?}}` |
| `compact.cancel()` | `{cancelled:true}` |

`SessionInfo` is `{id,file,cwd,mtime,entryCount,tier:"hot"|"cold",branches,lineageFingerprint}`. Memory failures are returned in `error: {code,message,...}`; ambiguous-session failures may return only `{error}`. Check `error` before relying on optional success fields.

### Dynamic provider return shapes

- `mcp.<sanitized_server>.<sanitized_tool>(args)` resolves to the server-defined result, commonly `{text:string,content:unknown[],structuredContent:unknown}`; for example `mcp.fal_ai.get_model_schema({ endpoint_id: "openai/gpt-image-2" })`. See `references/mcp.md`.
- `extensions.<tool>(args)` in full code mode resolves to `{content:Array<{type,text?,...}>,text:string,details?,isError:boolean,terminate?,source:{path,source,scope,origin,baseDir?}}`.

The guest TypeScript declarations contain the complete argument and return contracts. For a discovered or dynamic action, use `tools.describe({ref})`; inspect `outputSchema` when supplied, otherwise treat the result as `unknown`.

## `tools` — discovery & generic calls
Refs are namespaced (`pi.grep`, `extensions.<tool>`, `mcp.<server>.<tool>`, `schema.<action>`); bare names are rejected. `tools.providers()`→`[{name,description}]` · `tools.search({query,limit?})`→`FabricAction[]`(`ref,name,description,inputSchema,risk`) · `tools.describe({ref})`→full `FabricAction` (read `inputSchema` first) · `tools.call({ref,args?})` · `tools.list({provider?,namespace?,query?,limit?})` · `tools.models()`→Pi `[{provider,id,name,key}]`; `agents.models({runner:"claude"})`→Claude Code runtime models with canonical `claude/<value>` keys. Use `tools.call()` for refs discovered or computed at runtime, or names that cannot use property access—not as the default for known actions. Calling a core-tool name on `tools` (e.g. `tools.read(...)`) throws with a hint to use `pi.read(...)`.

## Error recovery: read, describe, retry
Read the line-numbered error → `await tools.describe({ref})` for the schema → match `inputSchema`, rerun (don't guess). Common mistakes: bare ref (`grep`→`pi.grep`); 2 positional args on `read`/`bash`/`ls` (use an options object — positional is supported only for `grep`/`find`/`write`/`edit`).

## Orchestration surfaces (opt-in)
Multi-agent orchestration is opt-in: load `/skill:fabric-workflow`, `/skill:fabric-council`, `/skill:fabric-rlm`, or `/skill:fabric-fusion` (API detail in `references/agents.md`, `references/mesh.md`).

Agent requests and persistent actors accept `runner: "pi" | "claude"`. Pi is the default and is required for `recursive: true`, `rlm.query()`, and actors that must call Fabric or mesh APIs themselves. Claude invokes the official `claude -p` harness; it supports mapped Claude Code tools and host-managed persistent actors, but not recursive/direct Fabric APIs. Use `agents.models({ runner: "claude" })` for runtime-enumerated `claude/<value>` model keys.
