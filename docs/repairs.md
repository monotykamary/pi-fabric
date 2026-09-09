# Catalog repairs

Pi Fabric learns **silent catalog-argument repairs** from unique invocation near-misses. It does not rewrite guidelines, `AGENTS.md`, or the system prompt. Session JSONL remains the only log. The durable product is a catalog-scoped table of spilled→declared maps.

KPI: repeat **invocation** fingerprints → 0. Bash nonzero, edit misses, missing files, and guest typecheck/syntax are classified for status but never promoted.

## Loop

```text
invalid args / unknown action
        │
  unique bijection against the live schema
        │
        ├─ effect / didactic / typecheck  → count, do not promote
        └─ unique extra key or unique verb → insert into current.json
                │
         next ActionRegistry prepare / resolve applies the row
         (canonical input is a no-op)
```

Repair-candidate observation and apply happen in `ActionRegistry` only. Unique extra keys are observed on the **caller's spilled args** before `prepareArguments`, so a bundled lexicon repair still persists the map for providers that lack one. `tool_execution_end` records effect drops and non-promotable fingerprints without double-counting inner invocation errors.

## Store

`~/.pi/agent/fabric/repairs/current.json` (under `PI_CODING_AGENT_DIR`).

`catalogDigest` hashes sorted provider names plus captured tool names. A digest change starts empty and **clears in-memory fingerprint counters** so a previous candidate cannot be re-inserted. Schema field/action renames do not bump the digest; apply re-proves each row's unique mapping against the **live** declared names instead. Repairs are **global across models**, not per project.

Table rows:

- `keyAlias`: extra argument key → declared key (`sessionId` → `session`)
- `actionAlias`: spilled action name → declared name (never applied when a committed capability view pins the call)

Cap: 256 rows. Promotion is on the first unique hit; uniqueness against the
live schema is the bound. A promoted row becomes active in memory immediately,
while persistence queues behind a single asynchronous writer. Insert is
identity-keyed (idempotent) and locked across Pi processes sharing the agent
directory; lock retries yield to the event loop, and stale-lock recovery is an
exclusive rename claim, so racing reapers can never delete a lock a fresh
writer owns. Queued writes merge with rows another process persisted and flush
before runtime teardown. Persistence failures never fail or delay the user's
invocation and appear in `/fabric repairs`. Apply is a no-op when the schema
accepts extension keys, the live mapping is absent or ambiguous, or the call is
already canonical.

Two failure modes stay visible, never silent:

- A **transient catalog** (capture suspension between sessions or during `/fabric reload`) never re-keys the table: the surface freezes until the catalog re-arms, so promotion cannot persist rows under an empty-catalog digest that would destroy the stable table.
- A **damaged table** (unreadable or malformed `current.json`) surfaces as `storeError` in `/fabric repairs`, blocks the merge that would overwrite it, and keeps promoted rows active in memory. A missing table, or one persisted under a different digest, starts fresh without an error.

## Commands

```text
/fabric repairs              # status, top fingerprints, current table
```

## Configuration

```json
{
  "repairs": {
    "enabled": true
  }
}
```

Disable with `"enabled": false`. Promotion never edits execution guidance or Schema text.

## Relationship to entropy normal forms

The repair table and [entropy normal forms](entropy.md) are separate host-side
compatibility mechanisms. Repairs learn unique spilled-to-declared name maps;
entropy statically derives schema-bound key spelling, enum spelling, lossless
numeric-string, and optional-null conventions. Both use the existing registry
boundary; neither adds model tools or arguments, rewrites guest programs, or
bypasses schema validation, authorization, approvals, or effects.

There is no confirmation loop. An absent or ambiguous live proof leaves the
input unchanged. Canonical inputs remain identity, and no static check claims
to prove actual comprehension or task success. Normal-form witnesses record
representation changes, not successful operations.

Metric v3 measures invocation rejections per action operation. Repair counts
are diagnostic, not objective terms. Observation pooling supports advisory
`declare-enum` review only for author-opted-in open properties; it never
licenses a capability restriction. Compiled v2 entropy artifacts contain
normalizations with empty overlay/quarantine arrays; legacy v1 restrictions
load inert. Every declared schema, action, and canonical enum member remains
available. `certify:entropy` checks preservation and the shared normalizer,
not an enum-pruning ratchet.
