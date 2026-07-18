# Memory & Recall

Pi Fabric's `memory` provider searches Pi session JSONL files. Session JSONL is
the source of truth; the memory index is derived, disposable state.

The index uses structural extraction only. It does not classify goals,
preferences, errors, or other prose concepts with regexes. Roles, tool names,
timestamps, entry IDs, tool errors, and tool argument paths come from typed
session fields.

## Cache V3

Cache records are JSON with an explicit `cacheVersion: 3` and `kind`. Older or
otherwise invalid records are rejected and rebuilt from source JSONL; old data
is never interpreted as V3 or migrated. V3 accounts for independently indexed
Fabric trace-operation child records.

```ts
// Hot shard
{
  cacheVersion: 3,
  kind: "shard",
  sessionFile, sessionId,
  mtime, size, sourceHash,
  entries: NormalizedEntry[]
}

// Cold digest
{
  cacheVersion: 3,
  kind: "digest",
  sessionId, file, cwd,
  mtime, size, sourceHash,
  firstTs, lastTs, entryCount,
  filesTouched, toolHistogram, errorCount,
  terms,       // bounded DF/frequency-ranked terms; ranking metadata only
  vocabulary,  // sorted [normalizedTerm, sortedEntryIndices[]][]; complete
  addresses    // [index, entryId, role, toolName, timestamp][]
}
```

A cold digest contains no normalized entry text, first-message prose, or full
transcript. `vocabulary` is an exact lexical address index over the full
normalized text of every outer entry and Fabric operation child before hot-text
truncation. `addresses` retains only structural metadata needed to resolve hits
and apply filters. `terms`
remains separately bounded by `memory.digestTerms`; it is not used as the
truth-coverage gate.

The source fingerprint is SHA-256 in addition to mtime and size. An append or
rewrite, including a same-size rewrite with a preserved mtime, rebuilds the
record. Refresh also removes cache records whose source session was deleted.
Cache directories and files are created/chmodded to `0700` and `0600` on a
best-effort basis.

## Exact lexical guarantee

`tokenize.ts` is the one tokenizer used by hot BM25, cold vocabulary creation,
and plain-query planning. It applies Unicode NFKC normalization, Unicode-aware
letter/number/underscore tokenization, and lowercase normalization.

For every cold session that coverage reports as indexed:

- every unique canonical token in normalized source entry text occurs in its
  sorted `vocabulary`;
- every vocabulary token points to every normalized entry containing it;
- a plain query token therefore cannot disappear because it fell outside
  `memory.digestTerms`;
- a regex matching a canonical token is tested against the complete cold
  vocabulary and produces a cold pointer.

This guarantee is **lexical, not semantic**. There is no stemming, synonym
expansion, intent classification, or regex over transcript prose. Cold regex
matching operates on individual canonical vocabulary tokens because entry text
and token order are intentionally discarded; phrase/punctuation regexes are
only exact against hydrated/hot entry text.

## Tiers and refresh

The `memory.hotSessions` most recently modified sessions are hot and retain
truncated normalized entries for BM25 and segment display. Older sessions are
cold and retain only the V3 digest metadata above. A session crossing the hot
boundary loses its shard after its digest is written. A selected cold session
never requires retained transcript content: its source JSONL remains the truth.

The default index directory is `<agentDir>/fabric/memory-index`. Refresh is
synchronous; there is no background daemon or new database dependency.

## Scopes and coverage

| Scope | Meaning |
| --- | --- |
| `session` | Current session, or newest session for the current cwd. |
| `project` | Sessions in the current cwd's Pi session directory. |
| `global` | Sessions under the agent directory. |
| `session:<id-or-path>` | One source session, explicitly hydrated without promotion. |

For a query, `project` and `global` discover and search **all** eligible
sessions. `memory.maxSessions` is not a search-coverage cutoff. It only bounds
no-query browsing and session listing.

Every recall response includes:

```ts
coverage: {
  complete: boolean,
  indexedSessions: number,
  eligibleSessions: number,
  staleSessions: number
}
```

`eligibleSessions` is the complete discovered query scope. `indexedSessions`
is the number successfully refreshed or validated against source.
`staleSessions` counts eligible sources that could not be indexed. `complete`
is true only when no eligible source is stale. `No matches` is authoritative
only with complete coverage; incomplete empty results say `No indexed matches`
and report the gap.

`page` and `pageSize` deterministically slice the globally ranked combined list
of hot segments and cold pointers. Ranking tie-breaks remain score descending,
source mtime descending, entry before digest, entry index ascending, then source
path lexical order.

## Queries

`memory.recall({ query })` supports:

- no query: bounded recent-entry browse;
- plain text: canonical token OR search ranked with BM25-style scoring;
- existing regex syntax: case-insensitive regex against hot entry text and
  against each complete cold vocabulary token.

`role`, `tool`, `since`, and `until` filters are structural. Cold filtering uses
the address metadata rather than retained prose. Nested `pi.read` and `pi.bash`
children have exact `toolName` values `read` and `bash`; provider refs such as
`agents.run`, `state.get`, and `mesh.query` remain naturally searchable through
their bounded structured record.

A hot hit is returned as a conversation segment. A cold hit is a session
pointer containing `matchedEntries`, an inclusive `entryRange`, and up to 50
stable `entryIds` when available (`entryIdsTruncated` reports overflow). This
keeps pointer output bounded. It does not include transcript content.

## Explicit hydration and expansion

A cold pointer is hydrated only by an explicit `session:<id-or-path>` scope.
Hydration re-reads source JSONL, does not promote or persist a hot shard, and is
bounded in returned results by pagination. An optional inclusive `entryRange`
can constrain the hydrated address surface:

```ts
memory.recall({
  scope: "session:abc",
  query: "rare_token",
  entryRange: { first: 12, last: 16 }
})
```

`memory.expand` re-reads full, untruncated source text. Existing index addresses
remain supported, and stable entry IDs or an inclusive range can be used:

```ts
memory.expand({ session: "abc", indices: [12, 14] })
memory.expand({ session: "abc", entryIds: ["entry-uuid"] })
memory.expand({ session: "abc", entryRange: { first: 12, last: 16 } })
```

The result contains `{ index, entryId, text }` records in source order. Fabric
operations can also be selected directly by their stable address:

```ts
memory.expand({ session: "abc", operationAddresses: ["entry-uuid/7"] })
```

A valid `FabricExecutionTraceV1` on an outer `fabric_exec` result emits one child
record per operation immediately after the outer normalized entry. Each child
keeps `parentEntryId`, `operationAddress`, exact `toolName`, `ref`, `provider`,
`action`, typed `filesTouched`, `outcome`, and a bounded structured `operation`
object. Expansion re-reads and re-normalizes the source JSONL, then returns that
persisted representation rather than reconstructing it from output prose.
Results are dropped first if a child would exceed 96 KiB; identity, arguments,
outcome, and error remain. Unknown/malformed traces and branch-summary prose are
not indexed as structured facts. The outer `fabric_exec` conversation entry is
still searchable as normal conversation history.

## Configuration

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

- `enabled`: registers the provider.
- `indexDir`: cache location override.
- `maxSessions`: no-query browse/session-list budget only.
- `maxEntryChars`: stored hot entry-text limit; expand re-reads full source.
- `hotSessions`: number of globally newest source sessions retaining hot shards.
- `digestTerms`: bounded ranking-term count; it never limits cold lexical
  discoverability.
