# Memory & Recall

Pi Fabric's `memory` provider searches Pi session JSONL files. Session JSONL is
the source of truth; the memory index is derived, disposable state.

The index uses structural extraction only. It does not classify goals,
preferences, errors, or other prose concepts with regexes. Roles, tool names,
timestamps, entry IDs, operation addresses, tool errors, and tool argument
paths come from typed session fields.

## Cache V5

Cache records use `cacheVersion: 5`. Older or malformed records are removed and
rebuilt from source; they are never migrated or interpreted as V5. Refresh also
removes orphan records, records whose encoded cache path does not match their
source identity, and records for deleted source sessions.

Every cache record contains the exact session file path and a SHA-256
`sourceHash`, in addition to source mtime and size. A same-size rewrite with a
preserved mtime therefore invalidates the record. Cache directories and files
are created with `0700` and `0600` permissions on a best-effort basis.

A hot shard contains bounded normalized entry text plus `indexCoverage`. A cold
digest contains:

```ts
{
  cacheVersion: 5,
  kind: "digest",
  sessionId, file, cwd,
  mtime, size, sourceHash,
  firstTs, lastTs, entryCount,
  filesTouched, toolHistogram, errorCount,
  vocabulary,   // sorted unique canonical strings; no posting lists
  addresses,    // structural entry/operation identities, stored separately
  indexCoverage,
  cacheBytes, cacheSourceRatio
}
```

Cold vocabulary maps an exact lexical term only to the containing session. It
does not retain a per-term list of entry indices. Consequently a cold result is
a session pointer with exact `sessionFile` and `sourceHash`, never an inferred
entry range. Exact entry IDs, indices, and Fabric operation addresses are
returned after explicit hydration.

`maxColdVocabularyBytes` bounds vocabulary construction for each session and
`maxColdCacheBytes` is a hard per-session persisted-cache bound. If either cap
is reached, `indexCoverage.complete` is false and contains an explicit reason.
Structural addresses or vocabulary may be retained only as exact prefixes when
the cache-size cap requires it; this is always reported as
`max_cold_cache_bytes`, never silently treated as complete. `cacheSourceRatio`
reports persisted cache bytes divided by source bytes.

## Exact lexical queries

`queryMode` is explicit:

- `"literal"` is the default;
- `"regex"` is opt-in.

Literal mode never inspects punctuation to guess whether input looks like a
regular expression and never compiles the input with `RegExp`. A path such as
`src/foo.ts` is therefore literal input.

`tokenize.ts` is the single canonical tokenizer used for literal queries, hot
BM25 scoring, and cold vocabulary creation. It applies Unicode NFKC
normalization, extracts Unicode letters, numbers, and underscores, then
lowercases. Literal terms use exact canonical-token equality. Matching is
lexical OR across the unique query terms; there is no stemming, synonym
expansion, phrase inference, or semantic regex classification.

For a cold session whose coverage is complete, every unique canonical token in
normalized source text occurs exactly once in the sorted vocabulary. Rare terms
remain exactly discoverable as long as the configured vocabulary and cache
bounds are not exceeded. If a bound is exceeded, an empty result is explicitly
non-authoritative.

Hot text is limited by Unicode scalar count, not raw UTF-16 code units. The cut
therefore cannot split a surrogate pair and always remains valid UTF-8. Because
hot shards do not retain a separate complete tail vocabulary, truncating any
normalized entry sets shard `indexCoverage.complete: false` with reason
`max_entry_chars`. A token occurring only after the cut cannot produce an
authoritative no-match; recall says `No indexed matches` and includes that
reason. Expansion still re-reads the complete source record.

## Bounded regular expressions

Regex mode runs JavaScript regex only in a disposable worker thread. The host
never evaluates an untrusted pattern. The worker is forcibly terminated at the
hard timeout, so catastrophic backtracking cannot continue on the host thread.
Regex execution is bounded by:

- UTF-8 pattern bytes;
- haystack item count;
- aggregate UTF-8 haystack bytes;
- wall-clock worker timeout.

Hot haystacks are normalized entry text. Cold haystacks are individual bounded
canonical vocabulary terms, not transcript prose. Invalid patterns, oversized
patterns, haystack truncation, worker failures, and timeouts return structured
query coverage. A timeout, for example, returns
`coverage.complete: false`, reason `regex_timeout`, and a structured
`coverage.error`. No incomplete regex result is presented as an authoritative
no-match.

## Tiers, refresh, and work budgets

The `memory.hotSessions` most recently modified sessions are hot. Older sessions
are cold. A session crossing the boundary loses its old derived tier record
after the replacement is built. Explicit hydration re-reads source without
promoting a cold session.

Cache synchronization is bounded by session count and aggregate source bytes.
Cache cleanup is bounded by inspected cache files and aggregate cache bytes
(the byte budget is shared with `maxSyncSourceBytes`). Reaching a work budget stops
additional indexing and sets `coverage.complete: false`; all eligible sessions
remain counted. There is no unbounded background job or database dependency.

Recall discovers all eligible sessions for query and no-query browse modes.
`memory.maxSessions` limits session listing only. Search materialization has
explicit deterministic per-call budgets: 50,000 filtered hot entry candidates,
10,000 cold digest candidates, and 10,000 grouped result items. Reaching one
sets coverage incomplete with `candidate_entry_budget`,
`candidate_digest_budget`, or `candidate_item_budget`. Totals then describe the
retained deterministic candidate set, not unknown omitted candidates. Coverage
reports:

```ts
coverage: {
  complete: boolean,
  indexedSessions: number,
  eligibleSessions: number,
  staleSessions: number,
  incompleteSessions: number,
  reasons: string[],
  error?: { code: string, message: string }
}
```

`No matches` is authoritative only when both cache/index coverage and query
execution coverage are complete. Otherwise the response says
`No indexed matches` and reports reasons such as source unavailability,
`max_entry_chars`, duplicate identities, vocabulary/cache caps, candidate or
synchronization budgets, or regex limits.

## Scopes

| Scope | Meaning |
| --- | --- |
| `session` | Current session, or newest session for the current cwd. |
| `project` | Sessions in the current cwd's Pi session directory. |
| `global` | Sessions under the agent directory. |
| `session:<id-or-path>` | One source session, explicitly hydrated without promotion. |

Duplicate session IDs are ambiguous. `session:<id>` and `memory.expand` refuse
an ambiguous ID with `ambiguous_session` and list candidate paths. Use the exact
session file path from the cold pointer. Duplicate normalized entry IDs and
operation addresses also make index coverage incomplete (`duplicate_entry_id`
or `duplicate_operation_address`). Stable-address expansion requires exactly
one record: zero matches return `address_not_found`, and multiple matches return
`ambiguous_address`; neither case returns source records.

## Pointers, hydration, and expansion

A cold result has session identity only:

```ts
{
  tier: "cold",
  sessionId,
  sessionFile,
  sourceHash,
  matchedTerms
}
```

It does not collapse disjoint term occurrences into a misleading inclusive
range and does not truncate a hidden list of exact matches. Hydrate the exact
path and pass the pointer hash:

```ts
memory.recall({
  scope: `session:${pointer.sessionFile}`,
  expectedSourceHash: pointer.sourceHash,
  query: "rare_token"
})
```

Hydrated/hot segments include `exactMatches` with exact normalized entry index,
entry ID, and operation address. Recall first groups all retained hot matches
into entry segments, combines those segments with cold pointers, globally ranks
the combined item stream, and only then applies `page`/`pageSize`. Thus several
matches in one segment consume one item, not several pages. Responses expose
stable `totalItems`, `totalMatches`, and `hasNext` for that retained stream.
No-query browse follows the same pagination path and has no earlier 25-entry or
`maxSessions` cap. An optional inclusive `entryRange` may bound
hydration, but both endpoints must be valid session indices. Out-of-range or
negative addresses return structured `index_out_of_bounds` errors rather than
being clamped or silently dropped.

`memory.expand` re-reads full, untruncated source text and accepts indices,
stable entry IDs, operation addresses, or an inclusive range:

```ts
memory.expand({
  session: pointer.sessionFile,
  expectedSourceHash: pointer.sourceHash,
  indices: [12, 14]
})
memory.expand({ session: pointer.sessionFile, entryIds: ["entry-uuid"] })
memory.expand({ session: pointer.sessionFile, operationAddresses: ["entry-uuid/7"] })
```

Hydration and expansion compare `expectedSourceHash` with the current source.
A rewrite returns structured `stale_pointer` and no source content. Results
include the current source hash so callers can retain pointer integrity.

A valid `FabricExecutionTraceV1` on an outer `fabric_exec` result emits one child
record per operation immediately after the outer normalized entry. Each child
keeps `parentEntryId`, `operationAddress`, exact `toolName`, `ref`, `provider`,
`action`, typed `filesTouched`, `outcome`, and a bounded structured `operation`
object. Expansion re-reads and re-normalizes source rather than reconstructing
operations from output prose.

Valid `FabricBranchSummaryDetailsV1` envelopes emit typed child records for
user, phase, and operation facts. Children preserve the original fact address,
ref/provider/action/tool/outcome/arguments and structurally derived paths, plus
`carrierEntryId`, `carrierParentId`, and `carrierFromId`. Operation facts expand
by their original operation address; user and phase facts use that address as
their stable entry ID. Repeated nested summaries are deduplicated by exact fact
address in source order, so the earliest carrier is deterministic. Addresses
must be unique within each consumed details envelope; a duplicate rejects that
envelope and marks coverage incomplete. Unknown or malformed details and all
branch-summary prose remain non-semantic.

## Configuration

```json
{
  "memory": {
    "enabled": true,
    "indexDir": "~/.pi/agent/fabric/memory-index",
    "maxSessions": 500,
    "maxEntryChars": 2000,
    "hotSessions": 50,
    "maxColdVocabularyBytes": 524288,
    "maxColdCacheBytes": 1048576,
    "maxSyncSessions": 10000,
    "maxSyncSourceBytes": 536870912,
    "maxCacheCleanupFiles": 100000,
    "regexMaxPatternBytes": 1024,
    "regexMaxHaystackTerms": 20000,
    "regexMaxHaystackBytes": 2097152,
    "regexTimeoutMs": 250
  }
}
```

- `maxSessions`: session-list discovery budget only; recall uses candidate and
  indexing budgets instead.
- `maxEntryChars`: persisted hot entry-text Unicode-scalar limit; any cut marks
  lexical coverage incomplete, while expand re-reads full source.
- `hotSessions`: globally newest sessions retaining hot shards.
- `maxColdVocabularyBytes`: per-session canonical vocabulary bound.
- `maxColdCacheBytes`: hard per-session cold cache-file bound.
- `maxSyncSessions` / `maxSyncSourceBytes`: synchronous indexing work budgets.
- `maxCacheCleanupFiles`: synchronous cache-file count budget; cleanup bytes use
  `maxSyncSourceBytes`.
- `regexMaxPatternBytes`, `regexMaxHaystackTerms`,
  `regexMaxHaystackBytes`, `regexTimeoutMs`: isolated regex execution bounds.
