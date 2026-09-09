# Context and memory certification

The repository provides three evaluation commands:

- `bun run certify:context` is deterministic, runs offline, and costs nothing.
- `bun run certify:entropy` is deterministic and offline: metric v3 invocation-rejection rates, static normal-form preservation, deterministic compilation (including an empty corpus), identical-plan convergence, canonical identity/idempotence, ambiguity refusal, forged-plan/schema-drift rejection, inert v1 migration, store round trips, and verbatim-audit/model-attribution ingestion checks. Its [representation trial](entropy.md#representation-trials) uses the runtime normalizer without inventing operation successes.

- `bun run benchmark:real-resume` is an opt-in, billable Pi RPC benchmark with a safe skip as its default behavior.

`bun run test` excludes these commands, which keeps the normal test suite offline and fast.

## Entropy certification

```sh
bun run certify:entropy
bun run certify:entropy --sessions <dir> --surface <snapshot.json> --trial --artifact <compiled.json> --json <report.json>
```

The wrapper builds first and imports `dist/entropy/index.js`. `--sessions`
reads the directory's `.jsonl` files; `--surface` requires sessions; `--trial`
requires both. Without `--artifact`, a trial loads the agent directory's compiled
artifact. `--json` writes the full report. Failed checks or invalid inputs exit
nonzero. No LLM calls or confirmation loop are involved.

Metric v3 is `score = behavioralScore = invocationRejections / actionOperations`;
static freedom and shape/flow diagnostics do not contribute. Duplicating a
corpus leaves the rate unchanged, and an all-invocation-rejected corpus scores
one. Compile keeps historical before/after reports identical. V2 artifacts
contain normalizations and empty restriction/quarantine arrays; all v1
restrictions load inert. Import rederives exact schema-bound plans.

Trials prefer verbatim audits by ref over projected traces. `normalizationWin`
counts invalid representations made schema-valid, not successful operations.
Canonical identity, idempotence, and acceptance costs fail certification;
quarantine earns no wins. A `clean` trial is not evidence of task success, and
`no-evidence` is not a benefit claim. Unprovable candidates do nothing. These
checks certify the bounded compatibility implementation, not actual model
comprehension or arbitrary future execution behavior.

## Deterministic certification

Use Node 24 or newer:

```sh
bun run certify:context
bun run certify:context --json /tmp/pi-fabric-certification.json
```

The package command builds `dist/` first, then runs `scripts/certify-context.mjs`. It prints a human summary followed by the complete JSON report. When any threshold fails, the command exits nonzero.

### Compaction endurance

The harness builds a persisted session through Pi's `SessionManager`. Messages and compactions go in through its public methods. The active parent-linked branch comes back through `getBranch()`. Under deterministic settings (`contextWindow=64`, `reserveTokens=63`, `keepRecentTokens=1`), the harness performs exactly 100 Fabric compactions. Before every hook event it calculates Pi's built context, applies `shouldCompact`, and requires Pi's own `prepareCompaction` to return a preparation. It then invokes the callback registered by `registerCompactionHook` with Pi's event shape, branch, preparation token count, reason, retry state, and signal.

Pi 0.83.0 publicly exports `SessionManager`, `buildContextEntries`, `buildSessionContext`, and `shouldCompact`. The same version implements and declares `prepareCompaction`. `AgentSession` calls it. The package root and the export map keep it private. Certification resolves the exact installed 0.83.0 internal module, verifies the installed version and the function shape, and reports `prepareCompactionPubliclyExported: false`. No public API supplies a preparation unless an `AgentSession` runs with a model, so certification makes no claim past that.

Every persisted summary carries a cycle-unique `PRIOR_SUMMARY_POISON_991_…` suffix inside the actual `CompactionEntry`. On the next cycle, Pi's preparation has to expose that exact stored previous summary. A proxy around the event preparation records whether the registered Fabric callback reads `previousSummary`. The result derives from those accesses. Fabric must leave the value unread and keep its poison out of anything it emits. No step converts a summary into a user message by hand.

Every cycle also checks:

- the original goal, constraint, and pinned Unicode rare fact
- the cumulative source, file, and unresolved-error addresses
- tool-call/result closure at the kept boundary
- the presence of every nonempty `firstKeptEntryId` on the active branch
- exact round trips of persisted summaries and details
- agreement between `SessionManager.buildContextEntries()` and the public `buildContextEntries()`
- a built context that, after the compaction and after each subsequent append, consists of exactly the latest `compaction` entry followed by the retained live entries
- a valid UTF-8 summary size of at most 32 KiB.

The last 20 summary sizes must span a range of at most 512 bytes. Their absolute least-squares slope must stay at or under 16 bytes per cycle. These bounds catch late unbounded growth while letting cycle sizes differ.

Six explicit eligible closure fixtures must each run at least once: normal, compact-all, Pi split-turn preparation, parallel/delayed results, reverse-order call/result, and malformed prior boundary. The harness checks every resulting Fabric cut for call/result closure.

A separate maximal source of about 330 KiB mixes multibyte goals, instructions, paths, errors, turns, and typed Fabric activity. Its summary must reach at least 24 KiB, stay within 32 KiB, and survive a round trip through a fatal UTF-8 decoder. This fixture pushes the bound close to its reachable projection saturation. The endurance fixture alone plateaus naturally at roughly 5.8 KiB.

The certificate covers deterministic cumulative projection, Pi eligibility and context behavior, closure handling for the named fixtures, and byte-safe saturation for generated typed event streams. Arbitrary human conversations and general model behavior require separate evaluation.

### Cross-layer memory

The same run creates 1,000 additional persisted Pi sessions. One unique rare-fact session receives an old source mtime. It must classify as cold. Only eight sessions may stay hot. Certification calls `MemoryProvider` directly. No shell output gets parsed.

The pass conditions are:

- at least 1,000 eligible sessions with complete indexing coverage
- exact lexical recall of the cold rare fact
- exact structural selection of a cold `pi.grep` operation by persisted ref/outcome, followed by source- and lineage-bound hydration
- a nonexistent-ref structural negative control that returns zero results
- exact source expansion by its stable entry ID
- exact expansion of every distinct entry ID emitted by the 100 compaction summaries or their structured details
- 100% address expansion agreement with a fresh normalization of the source JSONL
- V6 `sourceHash` integrity checks on both cold hydration and context address expansion.

The JSON report includes the eligible, indexed, and stale counts. It also lists the emitted and expanded address counts plus the cache and source byte sizes.

This proves lexical addressability and exact capability-head addressability through the current cache, digest, search, and source-expansion layers. Fuzzy semantic retrieval, ranking under unrelated corpora, cache performance on all filesystems, and recovery after source deletion stay outside that proof.

### Continuation QA

Continuation QA creates two small temporary repositories. Each holds exact expected final files, an executable Node oracle, and files that must stay byte-identical. A no-model handoff simulator receives only:

1. the compacted summary and the structured compaction details
2. constrained current-session pointer and expansion APIs backed by `MemoryProvider`.

The source phase persists a handoff envelope that holds the compacted context and the current Pi session ID. Task operations and captured session paths never enter that envelope. In the resume phase, the simulator reads that output, builds a fresh `MemoryProvider`, and asks it for a V6 integrity-bound current-session pointer. It then derives the cumulative source entry ID from the compaction details and expands that address with `expectedSourceHash`. The `addressResolved` score comes from the returned entry. The harness never substitutes a constant. No callback closes over `manager.getSessionFile()`.

The simulator decodes `CERT_TASK_V1` and applies its operations only after the source expansion succeeds. When an exact operation or file payload is unavailable, it throws and fails the run. It never fabricates a success. The external oracle then scores exact filesystem state, forbidden-file integrity, and process exit status. The oracle never supplies `task.operations` to the simulator.

This proves that the emitted address, the current persisted session identity, and the allowed memory operations can carry these mechanically executable tasks across a fresh handoff. Pi's compaction result itself exposes no session ID and no source hash. Those two values come from persisted current-session context and from `MemoryProvider`, in that order. Whether arbitrary prose can turn into operations, whether a model will choose to recall, and whether the two fixtures represent all software work stay unresolved here.

## Real Pi RPC benchmark

The benchmark compares three arms in deterministic randomized paired order:

- `baseline`: resumes the full, uncompacted context
- `fabric`: compacts with Fabric, terminates that process, then resumes in a fresh process
- `pi-vcc`: issues `compact` with the exact `__pi_vcc__` sentinel while both Fabric and the configured pi-vcc extension are loaded, terminates that process, then resumes in a fresh process.

The resumed process receives exactly:

```text
Resume and complete the task.
```

A filesystem and test oracle outside the model scores the result. Reports capture pass/fail diff reasons, tokens, USD cost, tool calls, recall calls, wall time, summary bytes, Wilson 95% pass-rate intervals, and paired win/tie rates. A report names the credential variable and never shows its value. Session and repository data live in a temporary directory. The run removes that directory afterward.

The RPC reader implements strict LF JSONL framing. It splits only on `\n`, strips an optional trailing `\r`, and preserves U+2028/U+2029 inside JSON strings. Node's `readline` plays no part in the reader.

### Safety gate

Without configuration, this command exits zero and reports `SKIP`:

```sh
bun run benchmark:real-resume
```

A billable run requires all of these gates:

```sh
PI_FABRIC_REAL_RESUME=1 \
PI_FABRIC_BENCH_PROVIDER=anthropic \
PI_FABRIC_BENCH_MODEL=claude-sonnet-4-5 \
PI_FABRIC_BENCH_KEY_ENV=ANTHROPIC_API_KEY \
PI_FABRIC_BENCH_REPEATS=3 \
PI_FABRIC_BENCH_MAX_USD=5 \
PI_VCC_EXTENSION=/absolute/path/to/pi-vcc/extension.ts \
bun run benchmark:real-resume
```

`PI_FABRIC_BENCH_KEY_ENV` names an already-set credential environment variable. The benchmark checks the observed session cost before each next arm starts. It stops once the run reaches the configured budget. A single in-flight request can still exceed the remaining budget. Treat the maximum as a stop boundary. Hard spending caps live on the provider side.

The benchmark proves end-to-end behavior for the selected model, provider, fixture, extension versions, and repeats only. Small samples carry wide confidence intervals. General superiority and full isolation of provider variance stay outside that proof.

## Relationship to pi-vcc stress tooling

The neighboring pi-vcc stress scripts supplied several ideas worth keeping: repeated compaction, late-size measurements, paired real-session comparisons, and explicit recall accounting. Their regex-based section scoring stayed behind. The harness also skips their habit of feeding the previous rendered summary forward as the next source. It takes on none of their assumptions. Fabric certification works from Pi parent-linked session entries, structured compaction details, direct memory APIs, exact source expansion, and executable continuation oracles.

## Test coverage

The suite in `tests/certification/` covers:

- strict LF JSONL parsing, including split UTF-8 and Unicode line separators
- the default skip gate and the complete opt-in gate
- deterministic paired order and benchmark confidence/paired reporting
- executable continuation oracle passes and forbidden-change failures
- certification rejection under sabotage of eligibility, poison exclusion, address resolution, or the external oracle
- certification report threshold failures.
