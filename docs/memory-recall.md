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
NormalizedEntry[]  ──►  shard cache (index.ts)  ──►  in-memory BM25
        │                                              │
        │                                              ▼
        │                                       search.ts (regex | OR terms)
        │                                              ▼
        │                                       segments (structural turns)
        ▼
memory.recall / memory.expand / memory.sessions   (memory-provider.ts)
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
4. **Decay is graded, not binary.** Ranking is `score desc → session mtime desc
   → entry index asc`. Older sessions tie-break behind newer ones; nothing is
   hard-dropped by age.

Determinism: same input bytes ⇒ same output bytes, stable ordering. BM25 is
implemented by hand with no dependencies.

## Scopes

`memory.recall({ scope })` selects which session files to search:

| Scope | Meaning |
| ----- | ------- |
| `session` (default) | The current session file — from the invocation context if available, else the newest session for the current cwd. |
| `project` | All sessions stored under the current cwd's default session dir (`<agentDir>/sessions/<encoded-cwd>/`). |
| `global` | All sessions under the agent dir, newest first, bounded by `memory.maxSessions`. |
| `session:<id-or-path>` | One specific session, by its header UUID, file stem, or absolute `.jsonl` path. |

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
slice the segment list.

## Indexing behavior

`index.ts` keeps a per-session shard cache under `memory.indexDir`
(default `<agentDir>/fabric/memory-index/`). Each shard is keyed by the
session file path + its current `mtime` + `size`:

- On access, the shard is loaded from disk. If `mtime`/`size` match the file,
  the cached shard is reused.
- If the file changed (a new line was appended, or it was rewritten), the
  shard is **re-parsed lazily** from the JSONL. No background daemon, no
  global rebuild.
- Stored entry text is truncated to `memory.maxEntryChars` (default 2000);
  the full text stays addressable via `memory.expand`, which re-reads the
  source line on demand.

This is the "context is a cache" principle applied to the index itself: the
shard is a cache of the JSONL, invalidated by structural change, never the
ground truth.

## Actions

All `memory.*` actions are **read risk** — they read local session files and
the on-disk index, and write only to the index cache.

### `memory.recall({ query?, scope?, page?, pageSize?, role?, tool?, since?, until? })`

Returns `{ scope, query, matchedCount, segmentCount, segments[], page, pageSize, text }`.
`text` is the deterministic rendered view (the snippet above) ready to drop
into the model context.

### `memory.expand({ session, indices })`

Re-reads the source JSONL and returns full, untruncated text for the given
entry indices. `session` is a file path, header UUID, or file stem. Use this
when a recalled entry shows `…[truncated]` and you need the complete content.

### `memory.sessions({ scope? })`

Lists known sessions in scope as `{ id, file, cwd, mtime, entryCount }[]`,
loading each shard to count entries.

## Configuration

Append a `memory` block to `fabric.json` (global or project):

```json
{
  "memory": {
    "enabled": true,
    "indexDir": "~/.pi/agent/fabric/memory-index",
    "maxSessions": 500,
    "maxEntryChars": 2000
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
