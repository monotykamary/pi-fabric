# Tool entropy

Tool entropy is the corrective freedom a tool surface leaves open per unit of
work: the number of distinct ways a call can be non-canonical, weighted by
how often models exercise them. The [catalog repair table](repairs.md)
is the running profile of that freedom: every promoted row is one dimension
the surface exposed and a model hit. The entropy meter turns the repairs KPI
(*repeat invocation fingerprints → 0*) into a measured quantity, and the
compiler loop drives it down and keeps it there.

Everything is deterministic by construction. The meter is a pure function over
typed artifacts Fabric already persists: trace V1 operations, live JSON
schemas, and the repair table. No model judges anything, no prose is parsed,
and the same inputs plus the same `ENTROPY_METRIC_VERSION` always produce the
same report, which is what makes the score bisectable and CI-gateable.

## Inputs

- **Traces**: `FabricExecutionTraceV1` operations (`ref`, projected `args`,
  `outcome`, `failureStage`, `sequence`) extracted from session JSONL tool
  result details. Trace V1 is deliberately prose-free, which is exactly what
  makes deterministic measurement possible.
- **Surface**: an optional snapshot of `{ ref, inputSchema }` actions. When
  present the meter adds static freedom; without it the report covers
  behavioral terms only.
- **Repairs**: the normalized catalog repair table (`keyAlias` /
  `actionAlias` rows). Each row is a standing lexicon tax on its target ref.
- **Audits**: persisted verbatim call arguments (`details.audits`). They are
  the value corpus for enum-tighten: trace V1 projects values away per ref,
  while audits carry every argument the call used. They stay local to the
  session record, and the machine-wide observation pool accumulates their
  counts across windows with exact per-session deltas, so sparse parameters
  still reach the derivation thresholds.

## Kernel boundary

Entropy and catalog repairs compile **host call data**, not guest programs.
TypeScript, Python/Monty (the Python default), and explicitly selected native
CPython share canonical refs, JSON argument schemas, audits, and trace V1.
No Python runtime is disabled, selected, or substituted by either compiler.

- Repair promotion happens at registry resolve/prepare/validate, not by parsing
  TypeScript diagnostics or Python tracebacks. Guest diagnostics are status-only;
  they cannot author alias rows. Apply re-proves unique live spellings, respects
  own canonical argument keys, and leaves schema validation and approvals intact.
  Action aliases do not expand committed capability views.
- The repair-table digest binds provider and captured-tool names, not the guest
  language. Changing that catalog clears candidates and reloads the table;
  field/action drift is handled by live mapping proofs on each application.
- Entropy ingestion requires a guarded trace envelope before accepting its audit
  values. Program text, Python dictionary reprs, and exception prose are not
  evidence. Standard JSON whitespace is accepted for model attribution, including
  model changes in appended session records.
- Session caches and observation pools contain language-neutral evidence. A kernel
  switch does not invalidate it; partitioning it by runtime would discard valid
  host observations. Trace V1 does not provide per-kernel entropy attribution.
- Compiled overlays must prove both the live base-schema digest and an enum-only
  restriction: they cannot remove required fields, change types, widen declared
  enums, or replace other schema constraints, even on artifact import. Schema
  drift invalidates enforcement at consult time. The automatic compiler still
  only tightens domains already declared closed by the schema author.

The session-start load, per-`fabric_exec` turn-end compile, immediate activation,
and shutdown flush are shared lifecycle hooks, independent of the chosen kernel.
`tests/kernel-compilers.test.ts` exercises these host boundaries with real TS,
Monty, and CPython executions, including language switches and stale artifacts.

## The metric

`measureEntropy({ traces, surface?, repairs?, catalogDigest? })` returns a
report with per-ref and global terms, all rounded to 1e-6:

| Term | Formula | Weight |
| --- | --- | --- |
| Shape entropy | Shannon entropy (bits) over canonical argument-shape signatures per ref, calls-weighted | 1 |
| Failure-stage entropy | Entropy over `failureStage` among failed ops per ref, failed-weighted | 1 |
| Retry churn | Mean normalized Levenshtein distance between a failed op's signature and the next same-ref signature | 4 |
| Navigation | `fabric.discovery.*` operations per action operation | 4 |
| Flow entropy | Occurrence-weighted entropy over action-ref sequences per task key | 1 |
| Lexicon tax | Repair rows targeting the ref | 2 |
| Static freedom | Per-schema freedom score (below) for called refs | 0.25 |

The global `score` is `(Σ per-ref scores + navigation + flow) / max(1,
succeeded action operations)`. Lower is better; the compiler's contract is
that it never increases. The report decomposes it into `staticScore` (the
surface share: static freedom of the refs the corpus used) and
`behavioralScore` (everything models exercised: wobble, churn, rejections,
navigation, flow, lexicon tax).

Additional totals: `invocationRejections` counts failures at `resolve`,
`prepare`, or `validate`: the offline residue class behind repair
fingerprints. `invocationRejectionsPer1k` is that rate per 1,000 action
operations and is the entropy production signal: it should trend to zero as
the surface converges, and it spikes when a new model or tool arrives.

Reports also carry `byModel`: per-model behavioral attribution. Traces stamp
the producing model from the session scan (`model_change` records and the
assistant turn's provider/model), and each model's behavioral terms measure
against the same surface. The surface share is global truth about the
schema, while behavioral entropy is attributable to the model that
exercised it: a slipping ratchet with every model's slope up means the
surface regressed, while one model's slope up names the entropy producer.
Unstamped traces (older corpora, synthetic fixtures) contribute to the
global report only.

### Fingerprints

- **Shape signature**: sorted parameter names with a bounded value-type tag
  (`(limit:num,path:str)`), nested objects to depth 3, at most 32 keys. Key
  order and value contents never matter, only the shape the model chose.
- **Static freedom**: per JSON Schema parameter: free string 1.0, enum
  `min(1, log2(k)/6)`, literal/const 0, number 0.5, boolean 0.1, arrays
  `0.5 + 0.5·items`, objects recursed; optional parameters add 0.25,
  `additionalProperties !== false` adds 0.5, free-form objects score 1.0.
  Computable with an empty corpus, which is what lets the compiler score
  candidate surfaces before deployment.

### What good means

- **Behavioral entropy → 0.** The bits of freedom models exercised, per
  successful call. Zero means no call in the corpus needed correcting. This
  is the primary target and the general form of the repairs KPI (repeat
  invocation fingerprints → 0).
- **Surface share shrinks by compilation, never by behavior.** It is the
  priced potential of the refs the corpus used. It falls only when
  a compiled surface (enum tightening, splits, or quarantines) removes real
  freedom; track it across surface releases, bounded by function.
- **Slope ≤ 0.** The per-session least-squares slope is the ratchet line:
  flat means the surface converged, negative means it is compiling down,
  positive means something regressed (a new model, a new tool, or a schema
  change).
- `/fabric entropy` prints `ratchet holding` when the latest session logged
  zero invocation rejections and the slope is at or below zero, and
  `ratchet slipping` otherwise.

## Proposals

`proposeEntropyReductions({ report, traces, surface?, repairs? })` emits
reviewable, evidence-carrying proposals with fixed thresholds:

- `enum-tighten`: a closed-domain parameter with ≥ 8 observations, 2–8
  distinct values, and a ≥ 50% top share tightens beneath the enum its
  schema already declares, removing values the corpus never uses. The
  closed-domain rule is the guard rail: the auto loop may only subtract
  freedom the schema claimed is bounded, never invent a domain. Value
  observations come from the verbatim audits when supplied
  (`entropyValueObservationsFromSessionJsonl`); the projected trace args
  are the fallback. Boolean-typed parameters never propose: they are
  already closed, and a two-value enum prices above the declared boolean.
  A declared or previously compiled enum is a floor: observed values
  outside it are pre-birth evidence (recorded before the overlay existed,
  or after a digest proof fell) and are dropped, never re-proposed, so a
  converged surface stops contesting its own tightness every turn. Later
  compiles may tighten beneath the floor but never widen past it; widening
  resets only when the base schema drifts (the digest proof drops the
  overlay) or through review. Validate-rejected attempts record as
  failed-call audits carrying only values the live schema's own enums
  declare, so nothing a validator refused enters the durable record: the
  refused value is already the author's public vocabulary, and typos or
  out-of-domain payloads drop at the boundary. The attempt stays pre-birth
  while the overlay holds, and the reset re-derives with it included, so a
  refused in-domain value un-locks at the first drift and survives in the
  corpus.
- `declare-enum`: observations over an open parameter do not establish a
  finite domain. A schema author must first mark a declared property with
  `"x-fabric-enum-candidate": true`; only then does the same ≥ 8 observation,
  2–8 value, and ≥ 50% top-share evidence surface a review signal naming the
  observed vocabulary. Ordinary free strings, numeric ranges, undeclared
  keys, and refs absent from the surface produce no enum suggestion. Once
  the author replaces the annotation with a declared enum, later compiles
  can tighten beneath it automatically. The auto loop never applies an enum
  declaration.

- `overload-split`: a ref with ≥ 1.0 bits of shape entropy and ≥ 2 disjoint
  key-set clusters with ≥ 2 calls each splits into separate actions.
- `sequence-fuse`: a contiguous sequence of 3–6 successful high-level
  action refs, all distinct, that recurs in at least three independent
  `fabric_exec` executions can become a composite action or skill. Core
  `pi.*` primitives are excluded because they are implementation steps to
  batch, not domain actions to fuse; failed and excluded operations break
  contiguity.
- `noise-quarantine`: a ref with ≥ 3 calls, more failures than successes,
  and ≥ 1.0 bits of failure-stage entropy hides from the model-facing
  catalog.

Repair rows do not produce proposals. They are already guarded compatibility
aliases from a spilled key or action spelling to its canonical declaration.
An alias hit proves the compatibility map is useful, not that the alias should
replace the canonical public name. `/fabric repairs` shows the mappings and
`/fabric entropy` reports their count and hits separately.

`applyProposalsToSurface` applies the mechanical subset (enum-tighten and
noise-quarantine) as a pure surface rewrite. Declare-enum, overload-split, and
sequence-fuse stay review-only.

## The gate (ratchet)

`evaluateGate(before, after)` passes only when the compiled surface does not
increase the score. `compileEntropySurface` adds the second half of the
contract: replay preservation. Every successful call to a ref the compile
touched must still parse against the candidate surface, checked with the
same TypeBox validation the registry's validate stage runs. When a
touched ref has verbatim audit calls, they are the replay corpus: trace
V1 projects values away per ref, so projected trace args cannot judge a
candidate. Audits the declared surface already rejected are not
protected, because those calls never executed. The compile step
is measure → propose → apply → re-measure → gate; a gate failure keeps the
old surface and records the rejection. Monotonicity and preservation are
measured, never argued. A converged surface stops proposing, which the
certification proves by requiring an empty second round.

The autonomous loop applies only the mechanically safe kinds
(`enum-tighten` and `noise-quarantine`), and only beneath a domain the
declared schema already bounds. `overload-split` and `sequence-fuse` author
new composite definitions, while `declare-enum` requires explicit author
intent, so all three stay surfaced for review and never auto-apply. Review
notifications describe the suggestions in plain language and emit each
distinct suggestion set once per session. Evidence
counts changing underneath the same suggestion do not repeat it; a changed
vocabulary, split, or sequence does.

## The compile loop

The reducer is autonomous, mirroring the repair loop: no command, no
approval, machine-checked bounds replace review. Every turn that invoked
`fabric_exec` may have produced new action evidence, so at `turn_end` Fabric
enqueues a background compile and returns the hook immediately. A 250 ms grace
period lets Pi finish appending the turn; triggers that arrive during a compile
coalesce into one follow-up using the newest context. The worker reads the live
session window, snapshots the declared surface through the discovery path, and
runs measure → propose → apply → gate against it. Directory discovery, stat,
JSONL scanning, lock waits, and atomic persistence use asynchronous I/O;
scoring, safety replay, evidence hashing, and observation pooling yield in fixed deterministic chunks. Session
files stream line by line with bounded concurrency. A bounded metadata-keyed
cache reuses unchanged evidence; when the active JSONL grows, the scanner reads
only the appended byte range and carries its model-attribution cursor forward.
Replacement, truncation, or an incomplete trailing record falls back safely.
Large logs therefore no longer impose one whole-window synchronous read/parse
stall on every turn, and a lock held by another Pi
process no longer blocks TUI timers while compilation proceeds.

The window is machine-wide, covering the newest sessions across every project
under the agent dir, so evidence breadth matches enforcement breadth: the
artifact governs the whole machine, so it learns from the whole machine. The
current project's newest session is always included so the live session that
produced this turn's evidence is never crowded out. The snapshot keeps
quarantined refs visible because digest proofs and artifact carry-forward read
the declared schema; the model-facing catalog keeps hiding them. Session
shutdown awaits the queued final compile for durability, but all of that work
remains cooperative with the event loop.

A notification appears only when a newly persisted artifact changes the live
surface. It starts with `background optimization complete`, prints enough
decimal places to distinguish the before/after scores (with an explicit signed
delta), states that lower is better, and says that the safety checks passed. An
equal score is labeled `entropy score unchanged`. Review suggestions point to
`/fabric entropy`; internal proposal-kind jargon stays out of user-facing
notices.

Value observations pool machine-wide with exact per-session deltas:
`<agent dir>/fabric/entropy/observation-pool.json` accumulates per-value
counts across every window the compiler reads, so a sparse closed domain
(a parameter used once or twice per session) still reaches the ≥ 8
observation threshold without widening the gate-local window. A session
contributes exactly once per content: unchanged files skip by digest,
growing files contribute only their delta, and evicted sessions bake with
their digest remembered, so no evidence can inflate by re-reading. The
pool is bounded (16 tracked values per parameter, above the 8-value
eligibility guard, so an overflowed domain stays provably open) and is
pure derived evidence: damage surfaces and blocks the merge, never
silently rebuilds.

A passing compile persists the compiled surface to
`<agent dir>/fabric/entropy/compiled.json` beside the repair table: overlay
entries and quarantines, the applied-proposal ledger, the gate record, and
the evidence digest. The artifact is clock-free, so identical evidence
compiles to identical bytes and saving them is a no-op. The runtime loads it at session start, a passing compile
activates the new artifact immediately, and enforcement is live:

- the compiled schema overlays the declared schema at the registry's prepare
  and validate stages, so enum-tightened parameters reject off-modal
  values;
- quarantined refs resolve as unknown actions and disappear from the
  model-facing catalog, exactly like retired actions;
- every consult re-proves the recorded base digest against the live declared
  schema, so a surface that changed underneath a compile drops its overlay
  and never mis-enforces.

Failure modes stay visible, never silent: a gate rejection keeps the old
surface and notifies once per distinct reason set; a damaged
`compiled.json` surfaces in `/fabric entropy`, blocks compiles from
overwriting it, and keeps enforcement off. `entropy.compile: false` in the
Fabric config disables the loop and the enforcement entirely.

## On-demand measurement

Session JSONL is the source of truth, so nothing is recorded. `/fabric
entropy` asynchronously discovers the newest machine sessions (window of 8
files total, newest first by mtime, spanning every project under the agent dir
with the current project's newest session guaranteed), streams each file
against the live surface snapshot, and reports the latest session's score plus
the least-squares slope across the window's session scores
(`trendFromScores`). The command shares the bounded evidence cache with the
background compiler. Lines without a trace envelope are skipped by a cheap
substring filter before parsing. The repair table, the compiled entropy
surface, and the machine-wide observation pool remain the only durable derived
artifacts; only the first two change runtime behavior, the pool only moves
thresholds.

## Commands and certification

```text
/fabric entropy                          # live surface freedom + observed session entropy trend
/fabric entropy export [path]             # write the live surface snapshot (default <agent dir>/fabric/entropy/surface.json)
/fabric entropy export-artifact [path]    # write the compiled artifact (default <agent dir>/fabric/entropy/artifact.json)
/fabric entropy import <path>             # merge a peer artifact (digest-proven entries only)
```

Repo-side only (development and CI; these scripts are not part of the
installed package):

```text
bun run certify:entropy                                     # offline fixtures, exact math, ratchet proof, ingestion
bun run certify:entropy --sessions <dir> --surface <snap>   # measure an arbitrary session corpus
bun run certify:entropy --sessions <dir> --surface <snap> --trial   # also run the held-out trial
```

`/fabric entropy` measures on demand: the newest machine sessions are read
from the session logs (all projects; `--project` scopes to the current
project's window), measured against the effective surface (live plus
the compiled overlay), and the trend is the per-session slope; the display
carries a `compiled:` line with the artifact's applied proposals and last
gate outcome, and a `review:` line listing the signals the compiler declined
to apply (opted-in enum vocabularies, overload splits, and high-level
sequence fusions), derived read-only from the current window and the
observation pool. Repair rows appear separately as aliases; they are already
active compatibility mappings and are not review suggestions. Gate rejections
are silent by design: the ratchet kept the old surface, and the display shows
the compiled state on demand. `/fabric entropy export [path]` snapshots the
live registry through the discovery path (read-only, authorization-free),
defaulting to `<agent dir>/fabric/entropy/surface.json` beside the repair table, as
`{ version: 1, actions: [{ ref, inputSchema }] }`, sorted by ref so it
hashes stably. Pass an exported snapshot with `--surface` to measure a
copied corpus against the surface it ran on; the report then carries the
surface hash as its catalog digest, so scores compare like against like.

## Federation

The compiled artifact is the shareable unit of improvement:
`/fabric entropy export-artifact [path]` writes the machine's compiled
surface, and `/fabric entropy import <path>` merges a peer's artifact into
the local one. Merging is digest-proven, never trusted: an incoming entry
earns a slot only while its recorded base digest matches the live declared
schema, and only where the local artifact has nothing to say about that ref
(conflicts skip; local wins). Unproven entries are dropped and counted in
the import notification. The applied ledgers union by identity, local
first, capped at the store's maximum. A merged artifact saves through the
locked store and activates immediately when compiles are enabled, and every
consult keeps re-proving entries against the live schema, so an import can
tighten the local surface but never reshape it. One machine's head start
becomes every machine's.

## Held-out trials

The trial is the falsifiable half of the compiler: with `--trial` (plus
`--sessions` and `--surface`), every recorded call in the corpus replays
against both the declared surface and the compiled artifact (`--artifact
<path>` overrides the agent dir's `compiled.json`), and each divergence is
classified deterministically. Calls the declared schema already rejected
credit nothing. Refs with verbatim audit calls replay from the audit
arguments, never the projected trace args; audits record executed calls
without outcomes, so a compiled rejection of an audited call counts as a
tightening cost, never a win. The falsifier stays pessimistic where the
record is silent. Succeeded calls the compiled schema would reject count as
tightening costs: the compile overfit its window, and the certification
fails on any of them, because the in-loop replay gate promised exactly
that. Calls that failed anyway count as wins when the artifact would have
rejected them: a cheap typed rejection replaces an expensive failure. A
quarantined ref's succeeded calls count as quarantine costs and are
reported without failing, because retiring a ref that once succeeded is
what a quarantine is allowed to do. The report carries the verdict
(`clean`, `costly`, or `no-evidence`), both window scores, and the
per-ref divergence counts.

The certification harness exits nonzero on any failed check, mirroring
`certify:context`: determinism (double-run hash equality), exact metric math
on fixed corpora, the full ratchet loop with convergence, the compile loop
with a gate-rejected round and a converged second pass, surface-apply
purity, synthetic session-JSONL ingestion, and audit-derived value
observations. The `Entropy` GitHub workflow runs the certification on every
push to `main` and weekly, uploading the JSON report as an artifact; a red
certification fails the build, so the metric and ratchet stay verified per
commit.

## Determinism contract

- Fixed canonicalization, fixed thresholds, fixed weights; changes bump
  `ENTROPY_METRIC_VERSION` so ledger trends never mix formulas.
- No clocks, randomness, or model calls inside measured values.
- Only typed records are consumed; prose is never classified, the same
  discipline as [schema enforcement](schema-enforcement.md).
- Metric v2 adds `byModel` attribution; every v1 weight and formula is
  unchanged.
- The report hashes stably (`entropyReportHash`), so per-commit scores are
  bisectable.

## Limitations

- Trace V1 projects arguments per ref (grep patterns, edit contents, and
  external arguments are dropped), so shape signatures see the projected
  key sets. Value-level passes read the verbatim audits through
  `entropyValueObservationsFromSessionJsonl`, which keeps enum-tighten
  working for value-dropped parameters as long as the session record (or an
  exported corpus) travels with the measurement.
- The gate proves score monotonicity on the retained corpus, not equivalence
  of future behavior. Quarantine preconditions (more failures than
  successes) carry the replay-safety argument for retired refs.
- Flow entropy groups executions by the persisted first workflow phase (or
  `(none)`), which is a coarse task key.
- The on-demand trend covers the newest machine sessions only (mtime
  ordered, machine-wide window of 8): sessions the user prunes leave the
  trend, and the slope is only as strong as the window. Widening the corpus
  scope shifts measured scores, so certification baselines recorded against
  a per-project corpus must be re-recorded once against the machine window.
- The compile trigger is per-turn, but pooled observations outlive the
  window: evidence stays eligible until the schema beneath it changes. The
  gate and the replay stay scoped to the current window, so a pooled
  proposal still has to keep every recorded call parsing.
