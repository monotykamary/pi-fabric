# Memory & Recall

Pi Fabric's `memory` provider is a search engine over **every Pi session timeline
on this machine**. It is the redistilled, first-principles version of
pi-vcc's `recall` — no pi-vcc dependency, no regex over prose in the core path.

## Why: the context is a cache, not the store

Principle 0 of the schema work: *the context window is a cache*. Ground truth
persists outside it — in the session JSONL files Pi already appends to, the
mesh log, the filesystem, git. Memory is the **re-fetch path** that brings
back what compaction or eviction dropped from the cache.

Memory never copies re-fetchable content into long-term state either. The
normalized index stores **addresses and a working set** (session file, entry
index, role, tool name, truncated text), not full transcripts. Full text is
re-read on demand via `memory.expand`.

## Design

```
session JSONL (append-only truth)
        │  normalize.ts        structural extraction only
        ▼
NormalizedEntry[]  ──►  hot entry shards ────────► entry BM25
        │
        └──────────►  cold session digests ──────► digest BM25
                                                       │
                                                       ▼
                                           segments + session pointers
                                                       │
                                                       ▼
                          memory.recall / memory.expand / memory.sessions
```

The four properties the schema harness proved:

1. **Derived views are pure functions of the log.** A shard is a deterministic
   projection of one session file's current bytes; nothing about a previous view
   is read.
2. **Structure over semantics.** `normalize.ts` extracts only what typed event
   structure gives — `role`, `toolName`, content-array `text` parts, tool-call
   name + arg summary, tool-result content, `bashExecution` command + output,
   `isError`, timestamps. No regex over prose lives in core code.
3. **Salience is computed, not remembered.** BM25 scores every query fresh from
   the loaded shards.
4. **Erasure is a first-class objective.** The index has a sleep cycle: recent
   sessions retain entry detail, while old sessions discard that derived detail
   and retain only a compact address-bearing digest. The source JSONL is never
   erased and can always rehydrate the detail.

Determinism: same input bytes ⇒ same output bytes, stable ordering. Entry and
session-digest BM25 are implemented by hand with no dependencies. Ordering is
`score desc → session mtime desc → entry index asc`; at equal score and mtime,
a digest hit sorts after an entry hit, followed by source-file lexical order.

## Scopes

`memory.recall({ scope })` selects which session files to search:

| Scope | Meaning |
| ----- | ------- |
| `session` (default) | The current session file — from the invocation context if available, else the newest session for the current cwd. |
| `project` | All sessions stored under the current cwd's default session dir (`<agentDir>/sessions/<encoded-cwd>/`). |
| `global` | All sessions under the agent dir, newest first, bounded by `memory.maxSessions`. |
| `session:<id-or-path>` | One specific session, by its header UUID, file stem, or absolute `.jsonl` path. If cold, its source JSONL is hydrated and searched at entry granularity without promoting or persisting a shard. |

Session discovery resolves the agent dir the same way fabric does
(`getAgentDir()`), and the cwd → directory encoding matches Pi's own
(`--<cwd-with-separators-replaced-by-dashes>--` under `<agentDir>/sessions/`).

## Query syntax

`memory.recall({ query })`:

- **No query** → browse mode: the 25 most recent entries in scope (newest
  session mtime first), each marked with `>`.
- **Query compiles as a regex** → applied directly (case-insensitive) against
  `role toolName text`. Use this for `error code 4[0-9]`, `TODO:.*auth`, etc.
- **Otherwise** → split into multiword OR terms, ranked by BM25 over the
  normalized entry texts.

Optional filters narrow the candidate set *before* scoring, structurally:

- `role` — e.g. `"user"`, `"assistant"`, `"toolResult"`, `"bashExecution"`.
- `tool` — matches `toolName` (assistant tool-call name, tool-result name, or
  `bash` for bash executions).
- `since` / `until` — Unix-ms timestamp bounds on the entry timestamp.

## Result shape: segments

Hits are grouped into **conversation segments** (turns). A segment begins at a
`user`, `bashExecution`, or `compaction` entry and runs to the next one —
computed from typed entry roles, never by regex over rendered text. Matched
entries are prefixed with `>`; the other entries in the same segment are
included as context (prefix ` `) so the caller sees the conversation flow
around each hit.

```
3 matches across 2 segments for "auth":

--- #0-#1 (2/2 match) ---
> #0 [user] remember the auth refactor
> #1 [assistant] the auth refactor touched login.ts

--- #2-#4 (1/3 match) ---
  #2 [user] now check the deployment scripts
  #3 [assistant] checking deploy.sh
> #4 [assistant] auth also appears here in a comment …[truncated]
```

Pagination: `page` (1-based, default 1) and `pageSize` (default 25, max 200)
slice the combined entry-segment and cold-pointer result list.

## Indexing behavior and the sleep cycle

`index.ts` keeps derived cache files under `memory.indexDir` (default
`<agentDir>/fabric/memory-index/`). The `memory.hotSessions` most
recently-**modified** source sessions are hot and retain per-entry shards.
Every other session is cold and retains a session digest. The default hot
boundary is 50 sessions; source mtime, not last message timestamp, determines
the boundary.

On refresh, a shard crossing out of the hot set is folded into a digest and the
shard is deleted. A cold session crossing back into the hot set drops its
digest and rebuilds a shard when selected. Both cache forms are keyed by source
path + current `mtime` + `size`; append or rewrite invalidates either form.
There is no background daemon.

This is memory garbage collection rather than unbounded accumulation: hot
sessions retain recent detail, cold sessions retain compact addresses, and the
session JSONL remains the truth. Explicit `session:<id-or-path>` recall parses a
cold JSONL into an ephemeral shard, searches its entries, and does not promote
or persist it. Stored hot entry text is truncated to `memory.maxEntryChars`
(default 2000); `memory.expand` also re-reads the source.

### Digest format

A digest is the deterministic pure fold of one session's normalized entries:

```ts
{
  sessionId, file, cwd,
  firstTs, lastTs, entryCount,
  goalLine,       // first user message, first line
  filesTouched,   // unique structurally extracted tool-argument paths, capped at 50
  toolHistogram, errorCount,
  terms           // top memory.digestTerms terms, DF-weighted
}
```

The persisted cache record additionally carries source `mtime` and `size` for
invalidation. `terms` are ranked by the number of session entries containing
them, then frequency, then lexical order. Cold BM25 searches `goalLine`,
`filesTouched`, and `terms`; a hit is a session-level pointer, never copied
transcript content:

```
> session abc (cold, /work/project, 2025-01-02T03:04:05.000Z) matched — re-run with scope "session:abc" to search its entries.
```

## Actions

All `memory.*` actions are **read risk** — they read local session files and
the on-disk index, and write only to the index cache.

### `memory.recall({ query?, scope?, page?, pageSize?, role?, tool?, since?, until? })`

Returns `{ scope, query, matchedCount, segmentCount, segments[], digestHits[], page, pageSize, text }`.
Hot matches appear as entry segments. Cold matches appear in `digestHits` and
as hydration pointers in `text`, which is ready to drop into model context.

### `memory.expand({ session, indices })`

Re-reads the source JSONL and returns full, untruncated text for the given
entry indices. `session` is a file path, header UUID, or file stem. Use this
when a recalled entry shows `…[truncated]` and you need the complete content.

### `memory.sessions({ scope? })`

Lists known sessions in scope as `{ id, file, cwd, mtime, entryCount, tier }[]`,
where `tier` is `hot` or `cold`. Entry counts come from the corresponding shard
or digest.

## Configuration

Append a `memory` block to `fabric.json` (global or project):

```json
{
  "memory": {
    "enabled": true,
    "indexDir": "~/.pi/agent/fabric/memory-index",
    "maxSessions": 500,
    "maxEntryChars": 2000,
    "hotSessions": 50,
    "digestTerms": 200
  }
}
```

- `enabled` (default `true`) registers the `memory` provider. Set `false` to
  disable without uninstalling.
- `indexDir` (optional) overrides the shard cache location. Defaults to
  `<agentDir>/fabric/memory-index/`.
- `maxSessions` (default 500) bounds how many session files `global` scope
  loads, newest first.
- `maxEntryChars` (default 2000) truncates stored entry text; full text is
  re-read on expand.
- `hotSessions` (default 50) retains entry shards for the N most recently
  modified sessions. Set 0 to keep every selected session cold.
- `digestTerms` (default 200) caps the DF-weighted ranking terms in each cold
  digest.

## Integration

The provider is registered in `FabricState.initialize()` (guarded on
`config.memory.enabled`) alongside `McpProvider` and `MeshProvider`. From a
`fabric_exec` program it is reachable through the generic provider protocol:

```ts
const actions = await tools.search({ query: "memory recall" });
const schema = await tools.describe({ ref: actions[0].ref });
const result = await tools.call({
  ref: "memory.recall",
  args: { query: "auth login", scope: "project" },
});
return result.text;
```
