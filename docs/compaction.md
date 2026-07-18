# Deterministic compaction

Pi Fabric provides an LLM-free compactor through `session_before_compact`. It is the default engine; set `compaction.engine` to `"pi"` to defer to Pi's compactor.

```json
{ "compaction": { "engine": "pi" } }
```

## Invariants

1. **The session log is ground truth.** The summary is a bounded continuation view with stable entry-id and file addresses.
2. **Live cut and cumulative truth are separate.** The cut is selected from the window made live by the last compaction. The summary is rebuilt from every raw, typed, content-bearing entry on the supplied active branch prefix before the new kept boundary.
3. **Rendered summaries are never semantic input.** `compaction`, branch-summary prose, custom summary prose, and unknown roles produce no normalized events. A valid Fabric branch-summary details envelope may contribute its typed facts; its `summary` string never does.
4. **Structure drives projection.** The core uses roles, content-part types, tool names, JSON arguments, call ids, `isError`, exit codes, entry ids, ordering, valid Fabric execution traces, and valid Fabric branch-summary facts. It has no semantic regex over prose or code. Whitespace normalization, bounded truncation, and path segmentation are mechanical operations.
5. **Serialization is deterministic and bounded.** Identical branch entries and instructions produce byte-identical output. The rendered result is at most 32 KiB in UTF-8.

This prevents both summary-chain drift and deterministic forgetting. Pi replaces the previous rendered summary, but Fabric re-derives the original goal, cumulative successful file addresses, error state, and user scope changes from raw branch history each time.

## Pipeline

```text
active branch entries ─┬─► live window ─► closure-safe cut ─► firstKeptEntryId
                       └─► raw cumulative prefix ─► normalize ─► project ─► bound/render
```

- `normalize.ts` converts raw message entries to typed events. Tool calls and results are paired only by `toolCallId`. A `fabric_exec` result contributes nested events only through a valid `details.trace` V1 guard, or through the separate strict legacy `details.audits` adapter when no `trace` field exists.
- `projections.ts` computes goal, file, commit, error, turn, status, and transcript views.
- `enrichers.ts` permits deterministic optional annotations. Fabric ships no built-in enrichers.
- `render.ts` independently bounds every rendered block and enforces the global UTF-8 limit.
- `hook.ts` computes the live cut, selects cumulative source, emits v2 details, and implements Pi/pi-vcc precedence.

## Live cut and closure

The last compaction marker identifies the live window:

- a valid `firstKeptEntryId` starts the window at that entry;
- a compact-all marker or missing/orphan kept id starts it after the marker;
- without a marker, the whole supplied active path is live.

Fabric begins with the last live user boundary. It then computes structural spans for every call id across the supplied branch. If any span crosses the candidate boundary, the cut moves backward to the user turn containing the earliest crossing and closure is checked again. Therefore both directions are enforced:

- no summarized tool call has a kept result;
- no kept tool call has a summarized result.

This handles parallel calls, delayed results, reverse/malformed ordering, and malformed prior boundaries. If no non-crossing earlier turn exists, Fabric uses compact-all (`firstKeptEntryId: ""`), so no kept side remains to orphan either half.

The live cut determines only what Pi keeps. Summary source is the raw active-branch prefix before that new boundary. Earlier compaction and branch-summary prose within that prefix is skipped by normalization.

## Bounded sections

The original first user goal is emitted first. Later user scope changes and potentially large file, commit, error, and earlier-turn collections use deterministic earliest-plus-latest sampling. Every omission records a count and a source entry-id range. File lines also carry the source call entry id.

Rendered block limits include their headers:

| Block | UTF-8 limit |
| --- | ---: |
| `[Session Goal]` | 4096 bytes |
| `[Compaction Request]` | 3072 bytes |
| `[Files And Changes]` | 4608 bytes |
| `[Commits]` | 2048 bytes |
| `[Fabric Activity]` | 2048 bytes |
| `[Outstanding Context]` | 4608 bytes |
| `[Earlier Turns]` | 3072 bytes |
| `[Current Status]` | 2048 bytes |
| collapsed transcript | 5120 bytes |
| footer | 1536 bytes |

The limits sum below 32 KiB, leaving room for separators. A final UTF-8 guard enforces the global limit. Projection limits are also finite: 24 later goals, 24 file addresses per operation kind, 20 commits, 32 error records, 32 earlier turns, and 40 transcript events. Omitted source remains executable-addressable through entry-id ranges and the footer recall pointer.

## Sections

- **Session Goal**: up to three bounded lines from the original first user message, followed by sampled later user scope changes.
- **Compaction Request**: canonicalized, bounded custom instructions; see below.
- **Files And Changes**: successful typed file-tool addresses grouped as Created, Written, Modified, or Read. `edit` is Modified. `write` is Written unless a typed result explicitly proves creation.
- **Commits**: bounded `git commit` operations. Nested trace results are not parsed for commit prose.
- **Fabric Activity**: bounded phases and significant non-file nested operations, including bash, agents, workflow, mesh, state, MCP, and extension refs. Every line has a stable `entryId/subordinal` address.
- **Outstanding Context**: typed tool/bash failures and later exact structural resolutions. File failures require the same action and path, bash failures the same command, and generic failures the same ref and arguments. Trace failures use only `operation.outcome` and `operation.error`; result/output prose is not classified.
- **Earlier Turns**: sampled user one-liners and tool-name counts.
- **Current Status**: the latest summarized request, modification address, and assistant line.
- **Transcript**: the latest 40 typed events, plus an omission range when applicable.
- **Footer**: deterministic source timestamp, cumulative source range, and session-log recall guidance.

## Custom instructions

`customInstructions === "__pi_vcc__"` is an exact routing sentinel and is never rendered by Fabric.

Every other instruction is data, not a mini-language. Fabric canonicalizes whitespace, bounds the input, and includes it in `[Compaction Request]` without semantically parsing it. A malformed typed prefix is handled as plain text rather than discarded.

`compact.request` may add typed `preserve: string[]` values. When present, the controller forwards an exact versioned prefix followed by JSON. The hook accepts only the exact prefix and a strict v1 object; it does not use regex to recover fields. Plain Pi/manual instructions remain supported.

## Compaction details v2

New summaries emit `details.compactor: "fabric"` and `details.version: 2` with:

- cumulative source and live-cut ranges;
- branch, source-entry, event, and live-cut counts;
- prior recognized Fabric v1/v2 marker counts;
- per-projection and preserve omission counts;
- instruction mode, canonicalization, source size, truncation, and preserve counts;
- stable kept/source entry-id addresses and the source timestamp.

Only exact Fabric versions 1 and 2 are recognized. v1 details and rendered prose are not reused as truth. On the next compaction, an old session naturally migrates to v2 because the new result is rebuilt from raw active-branch entries. V2 omission metadata now also reports Fabric activity omissions while accepting older V2 records that predate that counter.

## Nested Fabric execution traces

For an outer `fabric_exec` tool result, normalization reads only `message.details.trace` through `readFabricExecutionTraceV1`. Operations are emitted in `operation.sequence` order with addresses such as `entry-id/0`; phases use `entry-id/phase:0`. Known `pi.read`, `pi.grep`, `pi.find`, `pi.ls`, `pi.edit`, `pi.write`, and `pi.bash` calls retain exact typed arguments and outcomes. Other refs remain typed Fabric activity.

A present but malformed or unknown trace version is ignored and is not reinterpreted as legacy data. When `trace` is absent, the legacy adapter accepts only an audit array whose records have typed `ref`, JSON `args`, boolean `success`, and optional string `error`; it never reads audit rendering or `result` prose. The outer tool conversation remains in the transcript, but `fabric_exec` source code and outer result prose cannot create file, failure, or activity facts.

## Deterministic branch summaries

When the Fabric engine is active, the same registration also handles `session_before_tree`. It returns nothing when `userWantsSummary` is false and compiles only `preparation.entriesToSummarize` when true. Tree custom instructions are canonicalized and bounded as opaque request text; `__pi_vcc__` has special routing meaning only for compaction.

Branch details use `kind: "pi-fabric.branch-summary"`, `version: 1`, stable source addresses, and at most 256 bounded typed facts in a 128 KiB envelope. Facts cover source users, phases, and operations. Nested branch summaries re-emit only valid typed facts; branch summary prose is never normalized. Later compaction can therefore resolve abandoned-branch failures against later exact successes and retain files/activity through navigation or forks without parsing prose. Since Pi supplies only the active path or the abandoned `entriesToSummarize` path to each compiler, sibling branches do not contaminate one another.

## pi-vcc precedence

Precedence remains:

1. exact `__pi_vcc__` custom-instruction sentinel;
2. configured Fabric engine;
3. pi-vcc/default Pi behavior.

Fabric marks claimed events with `_fabricCompaction`. If an earlier pi-vcc handler marked `_piVccOverriding` and Fabric has nothing to compact, Fabric does not return a cancellation that would erase the pi-vcc result. With engine `"pi"`, Fabric neither claims nor cancels the event.

## Reconstruction QA

`src/compaction/qa.ts` derives probes from normalized source events, never rendered sections. QA probes follow the same bounded sampling policy as projections: directly rendered samples are checked for content, while omitted collections are checked for count/range addressability. Mutation tests remove file, error, turn, and footer information to verify that the report detects loss.

Run:

```sh
pnpm vitest run tests/compaction-qa.test.ts
```
