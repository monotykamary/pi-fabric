# Speculative programmatic tool calling

Speculative PTC (sPTC; Zhang, 2026, <https://alexzhang13.github.io/blog/2026/spec-ptc/>)
pre-launches tool calls while the model is still streaming the `fabric_exec`
program, so tool latency overlaps token generation. Fabric implements the
streaming-overlap half of the technique with a correctness contract the blog
leaves informal: a served speculative result is indistinguishable from the
call having executed at its natural program point.

## Kernel support

sPTC currently supports **TypeScript with the effective QuickJS backend only**
(including schema enforce mode, which selects QuickJS for TypeScript).
It has a **TypeScript-only scanner**. Python (Monty and CPython)
is explicitly bypassed before extraction/scanning or speculative dispatch;
Python syntax must never be fed through the TypeScript AST as an approximation.
Normal Python host calls still run the authoritative registry pipeline without
speculative cache warming. This is not Python sPTC support.

Kernel/backend and schema/full-code policy transitions must reset both stream
state and the promise cache before the next program. Reset invalidates pending
preparation and already-claimed promises as well as retained results. Re-enabling
speculation or returning to an eligible kernel/backend starts with empty state;
it does not revive earlier streams or results.

Robust Python support warrants future parser work: an incremental Python-aware
parser, completed-call detection, Python literal/keyword argument normalization,
and lexical binding/shadowing analysis shared with the Python bridge contract.
Regex extraction or parsing Python-looking expressions as TypeScript cannot
safely establish those properties. Native TypeScript backends (Node/Bun outside
schema enforce) are explicitly bypassed too: ambient OS writes bypass registry
mutation epochs, and only `pi.read` currently has external filesystem freshness
checks. Backend support must not weaken the isolated correctness contract.

The pre-launch gate also checks live policy **before provider lookup**: read or network approval must be `allow`, hidden `pi.*` calls cannot pre-launch in orchestration-only mode, and Schema-blocked refs cannot pre-launch under enforcement. MCP allowlisting alone does not override `ask`/`deny` or Schema policy. The normal invocation repeats its full authorization and approval path before consuming a cached result.

## Pipeline

```
message_update (pi extension event)
  │  toolcall_start / toolcall_delta / toolcall_end for fabric_exec
  ▼
PartialCodeFieldExtractor        src/speculation/partial-json.ts
  │  incrementally unescapes the streamed `"code"` JSON string field
  ▼
LiteralCallScanner               src/speculation/scanner.ts
  │  reparses only when appended bytes contain `)`; emits completed
  │  root.fn({...}) calls whose arguments are entirely literals;
  │  namespaces shadowed by local bindings are tainted for the stream
  ▼
eligibility gate                 src/speculation/eligibility.ts
  │  static Tier-A set / MCP allowlist, then descriptor-level re-check
  ▼
ActionRegistry.speculate()       src/core/action-registry.ts
  │  resolve → gate → prepareArguments → validate → provider.invoke
  ▼
FabricSpeculationStore           src/speculation/store.ts
  │  keyed by (parentToolCallId, ref, stableJsonHash(preparedArgs));
  │  per-entry AbortController, freshness checker, side-channel replay sink
  ▼
ActionRegistry.invoke()          serve-or-reexecute at the real call site
```

## The correctness contract

1. **Eligibility is read-only by construction.** Tier A is a closed set of
   refs that are `risk: "read"` with `effect.kind: "none"`, never prompt for
   approval, and cost nothing when wasted (`pi.read`/`grep`/`find`/`ls`,
   `memory.recall`/`expand`/`sessions`, `state.get`/`history`/`complexity`,
   `schema.status`, `compact.status`, `components.list`/`status`/`graph`).
   The gate re-runs against the resolved descriptor at launch, so a provider
   or config change that reclassifies a ref closes speculation off.
2. **Freshness, not staleness.** A stored promise is served only when both
   conditions hold:
   - The **mutation epoch** has stayed constant since launch. Every real
     in-program invocation whose effect kind differs from `"none"` bumps the
     epoch after the provider call completes (success and failure alike; a
     failed `bash` may still have written), invalidating all older
     speculation.
   - The entry's **freshness checker** still holds. `pi.read` snapshots
     `{mtimeMs, size}` of the resolved path at launch and re-stats at serve,
     which also catches external edits. Epoch, freshness, and TTL are checked
     again after awaiting an in-flight result; resets also abort claimed
     entries, not just entries still in the cache. Other Tier-A refs rely on the epoch
     plus the fact that their stores cannot be written by this guest surface.
3. **No approval bypass.** Speculation launches only actions that never
   prompt; the serve path runs the complete normal pipeline (authorize,
   prepare, validate, approve, audit, result middleware) before answering
   from the store. On any serve miss the provider call re-executes within
   that same invocation, so policies observe exactly the calls the program
   makes.
4. **Failures always degrade to plain execution.** A speculative call that
   errored is discarded and the real call runs. A program that never invokes
   the candidate leaves waste and nothing more. Unserved entries are aborted
   when the invocation ends, and everything is dropped at turn end. A launch
   commitment fences asynchronous descriptor/argument preparation against
   resets, mutations, and invocation completion, so late preparation cannot
   repopulate a retired cache. Reset also clears lazy-scanner catch-up work.
5. **Take-once, occurrence-safe.** Serving deletes the entry, so one
   speculation can never answer two calls. The store also retains only one
   entry per identical call signature, so a duplicate read past the first
   executes fresh through the normal pipeline, which is always safe.

Observable differences show up only in observability surfaces: audits record
`speculated: true` on served calls, and side-channel outputs captured during
the speculative invoke (`attachMedia`, `updateArguments`, `attachPreview`) are
replayed into the real audit.

## Entropy compile interplay

The compiled entropy surface participates at both ends of the pipeline. On
the launch side, speculate() consults it exactly like the invoke path: a
quarantined ref never pre-launches, and prepared arguments validate against
the overlaid schema, so the store never warms a call the serve path would
reject. The serve side is unchanged and stays authoritative: the real call
runs the full pipeline before the store may answer, so a surface activated
between launch and serve (a compile landing mid-session) can never serve an
entry the live surface would reject. Entries launched under an older
surface remain take-once, TTL-bounded, and drop at turn end like any other
waste.

## Tier B: MCP reads

MCP tools are `risk: "network"` and excluded by default. Operators opt in per
tool through config: `speculation.mcpAllowlist: ["exa.*", "github.get_file"]`
(matched against the ref after the `mcp.` prefix). Cached MCP tool
annotations, when the runtime surfaces them, override the allowlist in one
direction only: `destructiveHint: true` or `readOnlyHint: false` refuses even
an allowlisted tool. Networked results carry no freshness guarantee. The
epoch still covers in-program effects, yet the world can change behind a
read; keep the allowlist to stable, idempotent reads.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `speculation.enabled` | `true` | Master switch (Tier A only unless the MCP allowlist is set). |
| `speculation.maxConcurrent` | `4` | In-flight speculative call cap; excess candidates are skipped. |
| `speculation.maxEntries` | `64` | Retained unserved entries per turn. |
| `speculation.maxBufferBytes` | `2 MiB` | Per-stream cap while extracting the streamed `code` field. |
| `speculation.entryTtlMs` | `180_000` | Unserved entries older than this are aborted. |
| `speculation.mcpAllowlist` | `[]` | Tier B patterns: `server.tool`, `server.*`. |

## Deliberately excluded

- `pi.edit`/`write`/`bash`, `state.transition`/`goal`/`verify`/`checkGoal`,
  every `write`/`execute`/`agent` risk class, and `compact.cancel`
  (reclassified from a historic mislabeled `"read"` to `"write"`).
- Calls with non-literal arguments, positional or multi-argument calls (their
  normalization lives on the guest bridge), and calls on namespace roots the
  program shadows locally. These are Cases 2 and 3 in the blog (shadow-REPL
  dependency resolution) and belong to later work. Literal arguments (Case 1)
  cover the common generated shapes, including `Promise.all` fan-out.
- `agents.*` sub-calls, the blog's headline target: a wrong speculation
  spends real tokens. A confirmer-backed variant belongs to a later phase,
  keyed off the budget ledger.

## Cost profile

Worst case per turn: a handful of wasted local reads (or allowlisted MCP
reads when the model rewrites mid-stream), one TS reparse per `)`-carrying
delta debounced to 20 per second, and a bounded stream buffer. Steady state:
Tier-A hits make `pi.read` effectively free against generation time, which is
where fabric programs on thinking models spend wall clock.
