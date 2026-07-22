# Memory & Recall

Pi Fabric's `memory` provider searches Pi session JSONL files. Session JSONL is
the source of truth; the memory index is derived, disposable state.

The index uses structural extraction only. It does not classify goals,
preferences, errors, or other prose concepts with regexes. Roles, tool names,
timestamps, entry IDs, operation addresses, exact `ref`/`provider`/`action`
identities, execution outcomes, tool errors, and tool argument paths come from
typed session fields.

## Active branches

`memory.recall`, `memory.sessions`, and `memory.expand` accept
`branches: "active" | "all"`. The default is `"active"` for every scope,
including `project`, `global`, and explicit `session:<id-or-path>` scopes.
Only records carried on each session's active parent-linked path contribute to
hot text, cold vocabulary, structural addresses, segments, and entry counts.
An abandoned sibling therefore cannot match by default. `branches: "all"` is
an explicit request to include every branch; responses, segments, cold
pointers, and session rows identify their branch mode.

For the current live session, Fabric calls the extension context's live
`SessionManager.getBranch()` and `getLeafId()` getters for every memory action.
This observes `/tree` navigation even when no new record has been appended. For
another persisted session, Fabric matches Pi 0.80.6's persisted semantics: the
last persisted non-header entry is the leaf, duplicate IDs resolve to the last
record in the ID map, and `parentId` links are followed from that leaf to a
root. Append order is never treated as one transcript. A parent cycle is
stopped defensively and makes coverage incomplete with
`invalid_parent_graph`.

Each derived record carries `branches` and a SHA-256 `lineageFingerprint` over
the selected branch mode, leaf, and active path IDs. Active and all caches have
separate filenames. Cache policy includes branch mode, lineage fingerprint,
and privacy settings, so navigation, append, or policy changes rebuild the
relevant derived record without contaminating the other mode. `sourceHash`
continues to cover the complete JSONL source, including off-lineage records.

## Cache V6

Cache records use `cacheVersion: 6`. Older or malformed records are removed and
rebuilt from source; they are never migrated or interpreted as V6. Refresh also
removes orphan records, records whose encoded cache path does not match their
source identity, and records for deleted source sessions.

Every cache record contains the exact session file path, branch mode,
lineage fingerprint, privacy policy, and a SHA-256 `sourceHash`, in addition to
source mtime and size. A same-size rewrite with a preserved mtime therefore
invalidates the record. Cache directories and files are created with `0700`
and `0600` permissions on a best-effort basis.

A hot shard contains bounded normalized entry text plus `indexCoverage`. A cold
digest contains:

```ts
{
  cacheVersion: 6,
  kind: "digest",
  sessionId, file, cwd,
  mtime, size, sourceHash,
  branches, lineageFingerprint, policy,
  firstTs, lastTs, entryCount,
  filesTouched, toolHistogram, errorCount,
  vocabulary,   // sorted unique canonical strings; no posting lists
  addresses,    // structural identity + ref/provider/action/outcome postings
  indexCoverage,
  cacheBytes, cacheSourceRatio
}
```

Cold vocabulary maps an exact lexical term only to the containing session. It
does not retain a per-term list of entry indices. Structural address tuples
separately retain exact entry identity, role/tool/time, and persisted
`ref`/`provider`/`action`/`outcome` fields. Consequently a cold lexical result
is still a session pointer with exact `sessionFile` and `sourceHash`, never an
inferred lexical entry range. Exact lexical entry matches are returned only
after explicit hydration.

`maxColdVocabularyBytes` bounds vocabulary construction for each session and
`maxColdCacheBytes` is a hard per-session persisted-cache bound. If either cap
is reached, `indexCoverage.complete` is false and contains an explicit reason.
Structural addresses or vocabulary may be retained only as exact prefixes when
the cache-size cap requires it; this is always reported as
`max_cold_cache_bytes`, never silently treated as complete. `cacheSourceRatio`
reports persisted cache bytes divided by source bytes.

## Capability heads and exact structural retrieval

Capability navigation is deliberately separate from memory evidence.
`tools.catalog()` returns a deterministic current tree:

```text
Fabric capabilities
└── provider head
    └── action head
```

Provider/action names, descriptions, and descriptor hashes describe the current
registered catalog; full schemas remain available through `tools.search()` and
`tools.describe()`. This metadata can help a caller choose an action ref, but it
is not copied into session entries and is not historical evidence. Catalog
descriptor changes may alter discovery ranking without changing historical
structural membership.

`memory.recall` accepts exact structural filters:

- `ref`, such as `pi.grep`;
- `provider`, such as `pi`;
- `action`, such as `grep`;
- `outcome`: `succeeded | failed | aborted | timed_out`;
- the existing `role`, `tool`, `since`, and `until` filters.

Without `query`, these filters produce `matchMode: "structural"`. Membership is
established only by persisted typed fields. With `query`, they constrain the
normal lexical or explicit-regex search and produce `matchMode: "combined"`.
Responses echo the exact `structuralFilters`; catalog description text never
becomes a lexical match.

```ts
const heads = await tools.search({ query: "search source files" });
const history = await memory.recall({
  scope: "project",
  ref: heads[0]?.ref,
});
const failures = await memory.recall({
  scope: "project",
  query: "timeout",
  ref: "agents.run",
  outcome: "failed",
});
```

A complete cold structural posting proves that the selected session contains a
matching typed entry, but the cold response remains an integrity-bound session
pointer. A combined cold lexical + structural candidate does not prove both
conditions occur on the same entry because cold vocabulary has no posting
lists. It reports `cold_structural_filter_requires_hydration` and must be
hydrated before entry-level co-location is claimed.

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
| `global` | Sessions under the agent directory. This is explicit, never the default. |
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
  branches,
  lineageFingerprint,
  matchedTerms,
  matchedStructuralEntries
}
```

It does not collapse disjoint term occurrences into a misleading inclusive
range and does not truncate a hidden list of exact matches. Hydrate the exact
path and pass the pointer hash:

```ts
memory.recall({
  scope: `session:${pointer.sessionFile}`,
  branches: pointer.branches,
  expectedSourceHash: pointer.sourceHash,
  expectedLineageFingerprint: pointer.lineageFingerprint,
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
  branches: pointer.branches,
  expectedSourceHash: pointer.sourceHash,
  expectedLineageFingerprint: pointer.lineageFingerprint,
  indices: [12, 14]
})
memory.expand({ session: pointer.sessionFile, entryIds: ["entry-uuid"] })
memory.expand({ session: pointer.sessionFile, operationAddresses: ["entry-uuid/7"] })
```

Hydration and expansion compare `expectedSourceHash` with the current source
and `expectedLineageFingerprint` with the selected live or persisted lineage.
A rewrite, append, or active-leaf navigation returns structured
`stale_pointer` and no source content when it changes an expected binding.
Results include source hash, branch mode, and lineage fingerprint so callers
can retain pointer integrity. Under active mode an off-lineage stable address
returns `address_not_found`; the same address can be expanded only by an
explicit `branches: "all"` request.

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

## Local-cache privacy and deletion

The memory index is local derived state, not an encryption or semantic-privacy
boundary. Depending on configuration and tier, cache JSON can retain plaintext
lexical vocabulary, cwd and file paths, source pointers and hashes, structural
tool and capability metadata, selected user/assistant/custom-message content, tool arguments,
and (with the default `indexToolOutput: true`) selected tool output. Cold
vocabulary alone can reveal exact words even though it has no posting lists.
Thinking text is excluded by default but is plaintext when explicitly enabled.
No secret scanning is attempted; privacy is structural inclusion or exclusion,
not regex classification.

Fabric requests `0700` for cache directories and `0600` for cache files, but
this is best effort and inherits the host filesystem, account, backup, and
administrative trust model. The cache is not encrypted. Project configuration
is read only for a project Pi has marked trusted; otherwise only global Fabric
configuration applies. A `global` memory search is an explicit scope and is
not the default, but global indexing still creates local derived records for
sessions selected by that explicit call.

Deleting a Pi session removes the source of truth. A later memory refresh
best-effort removes its orphaned cache records; delete the configured
`memory.indexDir` as well when immediate cache removal is required. Removing
that directory is safe because all records are disposable and rebuilt from
remaining session JSONL. Deleting caches does not delete source sessions,
filesystem backups, or copies outside the index directory.

## Benchmarking capability-head retrieval

Run the deterministic synthetic benchmark after changes to discovery, structural
postings, ranking, or cache layout:

```sh
pnpm benchmark:memory-heads
```

It reports catalog head selection separately from source retrieval, hot exact
operation-address recall, cold session recall, combined lexical + structural
retrieval, negative controls, cold digest/source ratio, and p50/p95/p99 search
latency. The command fails if catalog description text leaks into lexical
matches, structural provenance is lost, cold combined candidates omit the
hydration requirement, or a nonexistent ref returns history. Repository tests
provide the source-JSONL, branch, staleness, and cache-generation coverage that
the synthetic timing corpus intentionally does not duplicate.

## Configuration

```json
{
  "memory": {
    "enabled": true,
    "indexDir": "~/.pi/agent/fabric/memory-index",
    "maxSessions": 500,
    "maxEntryChars": 2000,
    "indexThinking": false,
    "indexToolOutput": true,
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
- `indexThinking`: assistant thinking blocks enter normalized text and lexical
  vocabulary only when true. Default: false.
- `indexToolOutput`: tool-result bodies, bash output, and typed Fabric operation
  results enter derived text only when true. Default: true, deliberately chosen
  for coding recall. When false, typed tool name/ref/action, error/outcome, and
  structurally extracted path metadata remain searchable; output bodies do not.
- `hotSessions`: globally newest sessions retaining hot shards.
- `maxColdVocabularyBytes`: per-session canonical vocabulary bound.
- `maxColdCacheBytes`: hard per-session cold cache-file bound.
- `maxSyncSessions` / `maxSyncSourceBytes`: synchronous indexing work budgets.
- `maxCacheCleanupFiles`: synchronous cache-file count budget; cleanup bytes use
  `maxSyncSourceBytes`.
- `regexMaxPatternBytes`, `regexMaxHaystackTerms`,
  `regexMaxHaystackBytes`, `regexTimeoutMs`: isolated regex execution bounds.
