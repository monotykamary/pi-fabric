---
name: fabric-exec
description: >-
  Troubleshooting and advanced API reference for `fabric_exec` TypeScript
  programs, dynamic providers, agents, and schema recovery. Routine `pi.*`
  coding calls are documented by ambient guidance; load this skill only after
  an argument-shape error or when an advanced surface needs exact contracts.
---

# fabric_exec — core reference

One type-checked TS program in a fresh executor (isolated QuickJS by default). Only the `return` value reaches the model; `print()`/`console.log` go to the activity panel. `π` is not a tool.

## `pi` core tools (full code mode only)
`pi.<tool>(arg)` — single arg: bare string (primary field) or options object, or a two-arg `(primary, options)` merge for the string-primary tools (`read`/`bash`/`powershell`/`ls`/`grep`/`find`): `pi.read('index.ts', { limit: 120 })` becomes `{ path: 'index.ts', limit: 120 }`, the positional string winning the primary field on conflict; a non-object second arg on those is still a type error. Positional tuple calls are accepted for `grep`/`find` (`pattern, path, limit`), `write` (`path, content`), and `edit` (`path, oldText, newText`).

| Tool | Form | Returns |
|------|------|---------|
| `read` | `path` \| `{path,offset?,limit?}` \| `(path, options?)` | `string` |
| `bash` | `command` \| `{command,timeout?,cwd?}` \| `(command, options?)` | `{ok:true,output,details}`; rejects on a nonzero exit (`settle:true` returns `{ok:false,output,details:null,exitCode,error}` instead) |
| `powershell` | Windows only; same forms and result contract as `bash` | `{ok:true,output,details}`; supports `settle:true` |
| `grep` | `pattern` \| `{pattern,path?,glob?,ignoreCase?,literal?,context?,limit?}` \| `(pattern, path?, limit?)` | `string` |
| `find` | `pattern` \| `{pattern,path?,limit?}` \| `(pattern, path?, limit?)` | `string` |
| `ls` | `path?` \| `{path?,limit?}` \| `(path, options?)` | `string` |
| `edit` | `{path,edits:[{oldText,newText,all?}],all?}` \| `{path,oldText,newText,all?}` \| `(path, oldText, newText)` | `{ok,output,details}` |
| `write` | `{path,content}` \| `(path, content)` | `{ok,output,details}` |

`pi.bash` and `pi.powershell` have no `stdin` option. When a command needs content input, write it to a file with `pi.write(path, content)`, then pass that path to the command or redirect the file into it; do not interpolate untrusted content into shell code.

For `pi.edit`, entry-level `all:true` applies that replacement to every non-overlapping occurrence; top-level `all:true` applies every entry that way. Omit it for unique anchors.

Shell tools reject on an ordinary nonzero exit; pass `settle:true` to get `{ok:false,output,details:null,exitCode,error}` instead of a rejection. Timeout, cancellation, approval, security, and spawn failures still reject. Other Pi core tool errors reject normally.

Aliases are normalized to canonical fields before host validation. Command aliases include `cmd`/`shell`/`cmdline`/`script`/`commandLine`; pattern aliases include `query`/`regex`/`search` plus `q`/`expression`/`text` for grep and `name`/`filename`/`glob`/`include` for find. Path aliases include `file`, `file_path`, camel-case path variants, `dir`/`folder`/`directory`, and target-file variants. Edit text accepts `old`/`from`/`old_string`-style and `new`/`to`/`replacement`/`new_string`-style spellings, including inside `edits`; write content accepts `contents`/`body`/`text`/`data`/`fileContent`. `ic`/`caseInsensitive`→`ignoreCase`, `globPattern`→`glob`, `ctx`→`context`, `max`→`limit`, and `start`→`offset`.

Shell `timeout` is in seconds; `timeoutMs` is converted from milliseconds. Numeric strings in `limit`, `timeout`, `offset`, and `context` coerce to numbers. `null`/`undefined` is omitted only for known optional fields; required fields remain invalid so authoritative host validation still reports them. Canonical fields win when both canonical and alias spellings are present. Unknown keys still fail the excess-property type check.

`bash`/`powershell`/`edit`/`write` always resolve an envelope `{ ok, output, details }`, never a bare string, and the executor guards those envelopes: a string method or iteration applied to the envelope itself (`r.trim()`, `for (const line of r)`) throws a TypeError naming the fix (`.output`) instead of a context-free "not a function".

A captured extension that registers an exact core name may provide a compatible additive override. Fabric derives a bounded object overload from the current override schema and adds it to the familiar `pi.<name>` surface wherever execution is effectively full-code, including Schema enforce mode; built-in positional calls, bare strings, shorthand, aliases, and normalized result contracts remain Fabric-owned. Override-specific prompt metadata is appended under that same `pi.<name>` identity. Schema enforce still applies its host restrictions to protected mutations and external effects. Unsupported or over-budget schemas use a loose object overload and still pass through authoritative registry validation, so use the effective schema and retry from the validation error when needed.

## Read economy

Search before reading. Run `pi.grep`/`pi.find` first, then `pi.read({ path, offset, limit })` the matching range instead of unbounded whole-file reads:

```ts
// Locate the symbol, then read only the window around the hit.
const hits = await pi.grep({ pattern: "targetSymbol", path: "src", context: 2 });
const window = await pi.read({ path: "src/engine.ts", offset: 120, limit: 80 });
```

An unbounded `pi.read('/x')` returns at most 2000 lines or 50KB (whichever is hit first); truncated output ends with a `[Showing lines a-b of N. Use offset=n to continue.]` notice — continue with `offset` only when you truly need the full file. Reserve whole-file reads for small files you will use in full (configs, tests or files you are about to edit, sources under a few hundred lines). Batching several large whole-file reads into one program inflates the single tool result, and that enlarged result stays in every later turn's context.

Keep multiline or syntax-heavy payloads out of `code`: pass them through `payloads` and read the exact matching key from `π`. For example, `payloads: { content: text }` is read as `π.content`; do not invent a different reference such as `π.task`. Every `π.key` must exist in the same call's top-level `payloads` map. TypeScript still parses template-literal contents, including shell heredocs. The legacy `strings` argument is accepted as an alias.

## Shell payloads: `script`
When the *whole* payload is one shell program, pass it as the outer `script` argument instead of `code`, and skip TypeScript string escaping entirely — heredocs, backticks, quotes, `$`-expansions, and sed backreferences travel literally:

```json
{ "script": "set -eu\ncat > out.txt <<'EOF'\n${literal} `text`\nEOF\nsed -E 's/([a-z]+)/[\\1]/' out.txt" }
```

`code` and `script` are mutually exclusive and exactly one is required. Fabric compiles `script` to a fixed `pi.bash` program over a reserved `strings` key; the payload is never rewritten, escaped, or interpolated.

Two script-only scalars carry the `pi.bash` options that no script text can reproduce: `timeout` (whole seconds, max 86400) and `settle` (return a nonzero exit as `{ ok, exitCode, output }` rather than failing the call). Both require `script`; a `code` program passes them to `pi.bash` directly instead. To change directory, make `cd <path> || exit 1` the script's first line.

Choose by shape, not by size. `script` is one complete shell program; anything that runs a second tool, branches on a result, or post-processes output is `code`. `strings`, `tokenBudget`, and `agentBudget` are rejected alongside `script` because none of them can reach a shell payload — passing one means the payload belonged in `code`.

Two limits are real. The payload is not type-checked at all, so `set -eu` and correct quoting are yours; and neither compiled form returns `details`, so structured truncation metadata needs `code`. `script` requires full code mode: Schema enforce mode rejects it so protected mutations stay reviewable, and orchestration-only sessions use the native bash tool.

## First-class provider calls
Use direct proxies when the action is known. Parallelize only independent calls: provider effect footprints record conflicts for overlapping or unknown non-commutative resources, and Fabric does not silently reorder them. No-argument actions such as `schema.status()`, `state.get()`, and `compact.status()` take no options object. Provider calls still cross the same registry validation, approval, audit, timeout, and cancellation path as generic calls.

### Stable provider return shapes

All calls return promises. Fields ending in `?` are optional; `unknown` marks provider data whose nested schema is not stable at this surface.

| Call | Resolves to |
|------|-------------|
| `memory.recall(args?)` | `{total,hits:MemoryRecallHit[],next:{ref:"memory.recall",args}|null,coverage:MemoryCoverage,error?}` |
| `memory.expand(args)` | `{session?,sourceHash?,branches?,lineageFingerprint?,entryCount?,entries:ExpandedSessionEntry[],next?:{ref:"memory.expand",args}|null,error?}` |
| `memory.walk(args, visitor)` | `{visited,stopped,error?}`; guest-local paging and full-entry reassembly over `memory.expand` |
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
| `components.list()` | `{definitions:Array<{name,description?,revision,requirements,provisions}>,components:FabricComponentInfo[]}` |
| `components.status({id})` | `FabricComponentInfo` with state, requirements, provisions, targetDigest?, error?, cleanupErrors? |
| `components.graph()` | `{components:FabricComponentInfo[],edges:Array<{from,to,ref}>,cycles:string[][]}` |
| `components.reload({id?}?)` | `{components:FabricComponentInfo[]}`; rolls back activation failure when cleanup succeeds |
| `compact.request(args?)` | `{requested:true,intent:{reason?,instructions?,preserve?,requestedBy,requestedAt}}` |
| `compact.status()` | `{pending?:CompactIntent,last?:{at,requestedBy,status,summary?,tokensBefore?,estimatedTokensAfter?,error?}}` |
| `compact.cancel()` | `{cancelled:true}` |

`memory.recall` multi-term literal queries default to ranked `queryMatch: "any"` so wording differences do not hide evidence; use `"all"` to require every canonical term in one indexed entry, and `queryMode: "phrase"` when adjacency matters. Results are hard-bounded either way. Structural filters (`ref`, `provider`, `action`, `outcome`) use exact persisted trace fields. Use `tools.catalog()`/`tools.search()` only to choose a current action head—catalog descriptions are navigation metadata and never become session evidence.

Recall returns one bounded flat hit stream. Every hit has the same copy-ready `{ref,args}` field: `await tools.call(hit.follow)` expands an entry or resolves a cold session. Continue any result with `await tools.call(result.next)` when `next !== null`; `total` is the retained pre-page hit count. Do not locate or parse Pi session JSONL yourself: follow calls, integrity bindings, and continuations are the supported retrieval API.

`memory.expand(args)` requires `session` plus a selector: `indices`, `entryIds`, `operationAddresses`, or `entryRange:{first,last}`. Optional `before`/`after` add adjacent entries. It returns normalized records in `entries`, with one uniform `tool` field and Pi `parentId` links. Long entries use lossless `textRange` chunks. For arbitrary filter/map/reduce/join/traversal work, use guest-local `memory.walk(args, async (entry, index) => { ... })`: it follows every expansion page, reassembles complete entries, awaits nested tool calls, and stops early when the visitor returns `false`. `memory.sessions` accepts an optional `limit`.

Stable-provider arguments normalize near-miss spellings the way `pi.*` does: known aliases and casing/singular variants repair to the canonical key, numeric strings coerce for numeric fields, and scope spellings such as `cwd` repair to `project`. Unknown keys are never silently ignored—they fail validation with the offending property path named (e.g. `/befroe: must NOT have additional properties`).

`SessionInfo` is `{id,file,cwd,mtime,entryCount,tier:"hot"|"cold",branches,lineageFingerprint}`. Memory failures are returned in `error: {code,message,...}`; ambiguous-session failures may return only `{error}`. Check `error` before relying on optional success fields.

### Dynamic provider return shapes

- `mcp.<sanitized_server>.<sanitized_tool>(args)` resolves to the server-defined result, commonly `{text:string,content:unknown[],structuredContent:unknown}`; for example `mcp.fal_ai.get_model_schema({ endpoint_id: "openai/gpt-image-2" })`. `<skill-dir>/references/mcp.md` is a branch pointer for MCP naming and management only when the task needs MCP.
- `extensions.<tool>(args)` in full code mode resolves to `{content:Array<{type,text?,...}>,text:string,details?,isError:boolean,terminate?,source:{path,source,scope,origin,baseDir?}}`.
- Captured Fovea tools therefore use refs such as `extensions.fovea_focus`. Discover dynamically with `await tools.search({ query: "fovea_focus" })` (the string shorthand `tools.search("fovea_focus")` is also accepted), then pass the returned `action.ref` to `tools.call({ ref, args })`; never invent a bare or `fovea.*` ref.

The guest TypeScript declarations contain the complete argument and return contracts. For a discovered or dynamic action, use `tools.describe({ref})`; inspect `outputSchema` when supplied, otherwise treat the result as `unknown`.

## `tools` — discovery & generic calls
Refs are namespaced (`pi.grep`, `extensions.<tool>`, `mcp.<server>.<tool>`, `schema.<action>`, `components.<action>`); bare names are rejected. `tools.providers()`→`[{name,description}]` · `tools.catalog({provider?,limit?})`→current provider/action head tree (navigation metadata, not session evidence) · `tools.search({query,limit?})`→`FabricAction[]`(`ref,name,description,inputSchema,risk`) · `tools.describe({ref})`→full `FabricAction` (read `inputSchema` first) · `tools.call({ref,args?})` · `tools.list({provider?,namespace?,query?,limit?})` · `tools.models()`→Pi `[{provider,id,name,key}]`; `agents.models({runner:"claude"})`→Claude Code runtime models with canonical `claude/<value>` keys. Use `tools.call()` for refs discovered or computed at runtime, or names that cannot use property access—not as the default for known actions. Calling a core-tool name on `tools` (e.g. `tools.read(...)`) throws with a hint to use `pi.read(...)`.

## Error recovery: read, describe, retry
Read the line-numbered error → `await tools.describe({ref})` for the schema → match `inputSchema`, rerun (don't guess). Common mistakes: bare ref (`grep`→`pi.grep`); a non-object second arg on `read`/`bash`/`powershell`/`ls` (`(primary, optionsObject)` already merges on the string-primary tools; positional tuples exist only for `grep`/`find`/`write`/`edit`).

## Orchestration surfaces (opt-in)
Advanced workflow skills are user-invoked; never load them autonomously. When the user has explicitly invoked an agent or mesh workflow, `<skill-dir>/references/agents.md` and `<skill-dir>/references/mesh.md` are branch pointers for low-level API detail.

`agents.self()` and `agents.members({scope?,kinds?})` expose one leased directory of intrinsic roots, agents, and actors. `agents.main()` and `agents.peers()` are compatibility views of root participants. **Peer is a reserved Fabric term for another root Pi session, not a child agent.** When the user says “peer,” query `agents.peers()` first; do not infer peer state from `agents.list()` or from `agents.members({ kinds: ["agent"] })`. `agents.list()` defaults to local child agents; use `scope: "lineage" | "project"` for federated agent discovery. Cross-process `steer`, `followUp`, and `stop` resolve `ownerHostId` and return only after the owner acknowledges. `agents.subscribe()` creates a durable source-qualified Pi/run lifecycle route; use it instead of model-authored status polling when another participant boundary should notify Main or an agent. Detached `agents.spawn()` already sends Main a terminal follow-up by default unless the caller later waits. Set `residency: "durable"` on `agents.spawn()` or `agents.create()` only when the participant must outlive the current Pi host; Fabric lazily transfers it to the hidden resident host in a trusted mesh-enabled project.

For an explicit implementation handoff, `agents.handoff({ model, task?, when? })` schedules a visible Pi child at the completed outer `fabric_exec` boundary; later calls in the same program still run, and Main blocks only after the finalized native outer result is ready. `when` is a guest-only pure synchronous predicate over immutable earlier successful-call facts from any resolved Fabric provider and is stripped before the host call. `/fabric prewalk [task]` defaults to in-place Main model switching plus a hidden same-session continuation; child trajectory mode is an opt-in setting. See `<skill-dir>/references/agents.md`.

Persistent actors may declare `requires: ["provider.action", { ref: "provider.optional", optional: true }]`. Each run records and verifies a closed-world descriptor commitment; missing required refs fail the activation instead of widening authority.

Agent requests and persistent actors accept `runner: "pi" | "claude"`. Pi is the default and is required for `recursive: true`, `rlm.query()`, and actors that must call Fabric or mesh APIs themselves. Claude invokes the official `claude -p` harness; it supports mapped Claude Code tools and host-managed persistent actors, but not recursive/direct Fabric APIs. Use `agents.models({ runner: "claude" })` for runtime-enumerated `claude/<value>` model keys.

Omit `timeoutMs` for agents and actors unless requesting longer than the configured `agents.timeoutMs` (60 minutes by default). Per-call values below the configured default are ignored.
