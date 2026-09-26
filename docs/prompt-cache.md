# Prompt-cache observations and scoped warming

`cache.*` is a local prompt-cache capability, not a key/value store or a cache of tool results. It preserves Fabric's separation of workflow policy, owned effects, and native execution. The lease pattern and honest last-request telemetry are informed by [pi-fabric-pair](https://github.com/asx8678/pi-fabric-pair/tree/3760335515c24b4693a233a25c2e85744466f35d).

## Availability and cost

Observations work on ordinary Pi sessions now. Warming requires the optional native `ctx.acquireCacheWarming("idle")` capability, returning an idempotent release function. The inspected stock Pi 0.87.0/0.87.1 SDKs do **not** expose that capability. They return `unsupported`; Fabric never simulates warming with prompts, changes global settings, or sends a replacement provider request.

No configuration switch is needed. Fabric acquires no warming interest until an explicit approved `cache.hold` or trusted component `cache.lease` acquisition. Native warming settings, including Pi's ordinary streaming policy, are unchanged. Acquisition has `agent` risk and may authorize paid native refreshes for the duration. Pi retains request snapshots, model eligibility, retention tiers, economic decisions, scheduling, and native safety windows. A lease cannot force a refresh or guarantee a cache hit.

## Guest API

```ts
const observation = await cache.status();
return observation;
```

```ts
const lease = await cache.hold({ target: "self", durationMs: 5 * 60_000 });
if (lease.status !== "held") return lease; // unsupported/unavailable, with a reason
return { id: lease.id, expiresAt: lease.expiresAt };
```

A successful hold survives the allocating `fabric_exec`; a later execution can release it:

```ts
return await cache.release({ id: "the-returned-lease-id" });
```

Known calls also work in the Python kernels, for example `await cache.status(target="self")`. Generic discovery exposes `cache.status`, `cache.hold`, `cache.release`, and the host-only `cache.lease` action. Public TypeScript contracts are exported from `pi-fabric/protocol`.

- `target` defaults to `self`, the **local Pi session**, including inside a child. `main` is an alias available only in a root runtime. Arbitrary participant IDs and cross-process routing are not supported. A child cannot use `main` to control its parent's cache.
- `durationMs` is required: an integer from 1,000 to 1,800,000. At most 128 Fabric holds can coexist in one provider generation. Deadlines never auto-renew, and refreshes do not extend them.
- Optional `maxRefreshes` (integer 1–1,000) and `maxCostUsd` (positive, at most 1,000) are fail-closed requests: **the current adapter returns unsupported when either is supplied**. The proposed native lease API has no admission/receipt contract that can enforce them. Do not infer a spending cap from the deadline, usage counters, or Fabric's agent budgets.
- Releasing an unknown or previously released session hold returns `released: false`. Cleanup errors are explicit. Release cannot undo already-billed refreshes or stop another native owner's interest.
- Holds end on their deadline, cancellation during allocation, known session/model/branch/compaction boundaries, or provider close. Reload drains retained provider generations rather than instantly revoking their committed views. A successful completed invocation detaches its operation signal; its hold remains session-owned. Abrupt host death ends the in-process native warmer. Holds are never persisted or restored.
- Warming decisions and subsequent holds fence changed model, thinking, system prompt, and active tool names. Native Pi remains responsible for exact serialized-request validity, including transformations by other extensions. Failed native acquisition is not retried automatically on an unchanged binding.
- Status is read-only. It neither acquires nor releases interest, returns no prompt text, and makes no inference request. Invalidation is driven by lifecycle hooks, acquisition checks, and the native decision boundary.

The cache provider is absent in managed embedded hosts. Schema enforce permits only `cache.status`; acquiring or releasing holds remains blocked. A saved lease ID is not authority to manipulate another provider generation or a component's lease.

## Observations are not residency

`cache.status()` returns session/model identity, native lease capability availability, bounded live lease metadata, cleanup diagnostics, and `observation`. `scheduled` is `null`: the scoped lease capability does not expose a trustworthy native schedule. `supported: true` means a native acquisition method exists, not that a model is eligible or any refresh occurred.

`observation.lastRequest` and `lastRefresh` are independent samples. Each includes its session entry ID, original `observedAt` timestamp, normalized token counters, reported cost (or `null`), and:

```text
cacheReadShare = cacheRead / (input + cacheRead + cacheWrite)
```

The last real assistant request is not replaced by a warming receipt. Zero-input placeholders do not erase a measurable sample or refresh its timestamp. A measured miss is zero; missing/invalid counters are unknown, never synthesized as a zero-percent miss.

The reader follows at most 256 parent links on the active branch. It does not scan session files or abandoned branches. Compaction, branch summaries, model/thinking changes, context edits, and system-prompt/tool checkpoints stop the window. `window` discloses its entry count, bound, truncation, and stopping reason. Observation age describes a past request, not the provider's cache TTL.

`maintenance` aggregates only native `usage` entries with `kind: "cache_warm"` for the current model in that window. It counts each entry once, reports known tokens/cost, and discloses unknown-token and unknown-cost receipt counts. These are **window totals**, not lifetime totals, spend admission, or per-lease attribution. Other native owners may have caused those refreshes. Fabric does not append duplicate usage entries; Pi's session accounting remains authoritative.

## Host component ownership

A component can declare `requires: ["cache.lease"]` and acquire it through its effect scope:

```ts
const result = await context.acquire<FabricCacheHoldResult>("cache.lease", {
  durationMs: 5 * 60_000,
});
```

Import `FabricCacheHoldResult` as a type from `pi-fabric/protocol`. Inspect its discriminant. Unsupported acquisition has a no-op disposer. Successful acquisition registers an idempotent owner-only disposer; guests cannot release it by copying its ID. Multiple Fabric interests share one native lease, and the final release relinquishes only Fabric's interest. Scope cleanup manages ownership, not reversal of incurred inference charges. Cleanup failure remains visible and can quarantine the owning component.

## Boundaries and future work

Stable prompt construction already lives in [model-guidance components](components.md#prompt-cache-and-cold-prefill-behavior). Do not inject clocks, task state, or cache diagnostics into the stable prefix.

Persistent actor transcripts are not persistent Pi worker processes: current actor activations reuse the session file but close the Pi child after settlement. Idle actor warming needs a separately designed live-runtime retention capability; this change does not keep children alive, alter durable residency, or route cache control across participants.

A future native bounded-admission protocol would be needed before enabling refresh-count or cost-limited holds. Live-provider qualification is also separate from deterministic tests against the optional capability contract.

## Acceptance ledger

| Contract | Evidence |
| --- | --- |
| Measured misses versus unknowns; placeholders retain timestamps; real/maintenance usage separated | `tests/cache-observations.test.ts` |
| Bounded branch traversal and explicit window coverage | `tests/cache-observations.test.ts` |
| Shared native ownership, independent release, finite deadlines, no fallback/retry loops | `tests/cache-provider.test.ts` |
| Session/model/prompt/tool fencing, cancellation, component-only disposal, cleanup failure | `tests/cache-provider.test.ts` |
| Reserved pinned provider, typed guest execution, reload, native-free unsupported path | `tests/fabric-runtime-components.test.ts` |
| Managed host exclusion and Schema read-only boundary | `tests/managed-host-runtime.test.ts`, `tests/cache-provider.test.ts` |
| Node, Monty, and CPython proxy parity | Their targeted runtime suites |
| Registration/idle stays lazy; compiled artifacts include first-use path | Startup suites, `assert:lazy-graph`, fresh build |

No live cache-hit rate, native lease deployment, or strict spend cap is claimed by these checks.
