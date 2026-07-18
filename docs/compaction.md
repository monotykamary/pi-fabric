# Deterministic compaction

Pi Fabric provides an LLM-free compactor through `session_before_compact`. It is the default engine; set `compaction.engine` to `"pi"` to defer to Pi's compactor.

```json
{ "compaction": { "engine": "pi" } }
```

## Invariants

1. **The session log is ground truth.** The summary is a bounded continuation view with stable entry-id and file addresses.
2. **Live cut and cumulative truth are separate.** The cut is selected from the window made live by the last compaction. The summary is rebuilt from every raw, typed, content-bearing entry on the supplied active branch prefix before the new kept boundary.
3. **Rendered summaries are never semantic input.** `compaction`, branch-summary prose, custom summary prose, and unknown roles produce no normalized events. A valid Fabric branch-summary details envelope may contribute its typed facts; its `summary` string never does. Top-level Pi `custom_message` entries are different: Pi puts them in model context, so Fabric preserves their typed `customType`, text content, visibility, and bounded JSON details. Non-context-bearing `custom` state entries remain excluded.
4. **Structure drives projection.** The core uses entry/message types, roles, content-part types, custom-message fields, tool names, JSON arguments, call ids, `isError`, exit codes, entry ids, ordering, valid Fabric execution traces, and valid Fabric branch-summary facts. It has no semantic regex over prose, code, shell commands, or tool output. Whitespace normalization, bounded truncation, exact identity comparisons, and path segmentation are mechanical operations.
5. **Serialization is deterministic and bounded.** Identical branch entries and instructions produce byte-identical output. The rendered result is at most 32 KiB in UTF-8.

This prevents both summary-chain drift and deterministic forgetting. Pi replaces the previous rendered summary, but Fabric re-derives the original goal, cumulative successful file addresses, error state, and user scope changes from raw branch history each time.

## Pipeline

```text
active branch entries ─┬─► live window ─► closure-safe cut ─► firstKeptEntryId
                       └─► raw cumulative prefix ─► normalize ─► project ─► bound/render
```

- `normalize.ts` converts raw message and top-level `custom_message` entries to typed events. Custom content is selected only from typed string/text parts; JSON details are depth/node/collection/string/byte bounded and malformed details are omitted without dropping otherwise valid content. Tool calls and results are paired only by `toolCallId`. A `fabric_exec` result contributes nested events only through a valid `details.trace` V1 guard, or through the separate strict legacy `details.audits` adapter when no `trace` field exists.
- `projections.ts` computes goal, file, operation-state, turn, status, and transcript views.
- `enrichers.ts` permits deterministic optional annotations. Fabric ships no built-in enrichers.
- `render.ts` independently bounds every rendered block and enforces the global UTF-8 limit.
- `hook.ts` computes the live cut, selects cumulative source, emits v2 details, and implements Pi/pi-vcc precedence.

## Live cut and closure

The last compaction marker identifies the live window:

- a valid `firstKeptEntryId` starts the window at that entry;
- a compact-all marker or missing/orphan kept id starts it after the marker;
- without a marker, the whole supplied active path is live.

Fabric begins with the last live context-turn boundary: a user message or top-level Pi `custom_message`. Hidden (`display: false`) and visible custom messages have identical context semantics. It then computes structural spans for every call id across the supplied branch. If any span crosses the candidate boundary, the cut moves backward to the context turn containing the earliest crossing and closure is checked again. Therefore both directions are enforced:

- no summarized tool call has a kept result;
- no kept tool call has a summarized result.

This handles parallel calls, delayed results, reverse/malformed ordering, and malformed prior boundaries. If no non-crossing earlier turn exists, Fabric uses compact-all (`firstKeptEntryId: ""`), so no kept side remains to orphan either half.

The live cut determines only what Pi keeps. Summary source is the raw active-branch prefix before that new boundary. Earlier compaction and branch-summary prose within that prefix is skipped by normalization.

## Bounded sections

The original first user goal is emitted first. Later user scope changes and potentially large file, operation-state, and earlier-turn collections use deterministic earliest-plus-latest sampling. Every omission records a count and a source entry-id range. File lines also carry the source call entry id.

Rendered block limits include their headers:

| Block | UTF-8 limit |
| --- | ---: |
| `[Session Goal]` | 4096 bytes |
| `[Compaction Request]` | 3072 bytes |
| `[Files And Changes]` | 4608 bytes |
| `[Fabric Activity]` | 2048 bytes |
| `[Outstanding Context]` | 4608 bytes |
| `[Earlier Turns]` | 3072 bytes |
| `[Current Status]` | 2048 bytes |
| collapsed transcript | 5120 bytes |
| footer | 1536 bytes |

The limits sum below 32 KiB, leaving room for separators. A final UTF-8 guard enforces the global limit. Projection limits are also finite: 24 later goals, 24 file addresses per operation kind, 32 operation-state records, 32 earlier turns, and 40 transcript events. Omitted source remains executable-addressable through entry-id ranges and the footer recall pointer.

## Sections

- **Session Goal**: up to three bounded lines from the original first user message, followed by sampled later user scope changes.
- **Compaction Request**: canonicalized, bounded custom instructions; see below.
- **Files And Changes**: successful typed file-tool addresses grouped as Created, Written, Modified, or Read. `edit` is Modified. `write` is Written unless a typed result explicitly proves creation.
- **Fabric Activity**: bounded phases and significant non-file nested operations, including bash, agents, workflow, mesh, state, MCP, and extension refs. Every line has a stable `entryId/subordinal` address.
- **Outstanding Context**: typed tool/bash failures and later exact structural resolutions. File failures require the same action and path, bash failures the same command, and generic failures the same ref and arguments. Explicit error text is quoted and bounded, never parsed or classified. Trace failures use only `operation.outcome` and `operation.error`.
- **Earlier Turns**: sampled user/custom context one-liners and tool-name counts.
- **Current Status**: the latest summarized user/custom context, modification address, and assistant line.
- **Transcript**: the latest 40 typed events, including quoted/bounded custom-message content and bounded structural details, plus an omission range when applicable.
- **Footer**: deterministic source timestamp, cumulative source range, and session-log recall guidance.

There is intentionally no commit projection. The core does not recognize `git commit` command prefixes and does not parse shell stdout for hashes or summaries. A caller that needs a commit ID across compaction must provide it explicitly through a valid typed `preserve` item or another typed state transition.

## Remaining structural text operations

The clean core retains only these mechanical text operations:

- select text from typed user, assistant, top-level custom-message, tool-result, command-argument, error, phase, ref, and path fields;
- split user text on literal newlines for bounded goal lines, or select the first line for one-line views;
- trim/collapse whitespace and truncate by fixed character or UTF-8 byte limits;
- quote bounded user/custom/assistant/tool/error text without interpreting its content;
- compare typed action/path, action/command, or ref/JSON-arguments identities exactly for resolution;
- segment typed paths on `/` or `\\` to compute display roots;
- split a typed Fabric ref once on `.` to expose provider/action identity;
- inspect the explicit typed `created: true` result field for write classification;
- match only the exact `__pi_vcc__` sentinel or exact typed-request prefix, then use a bounded structural JSON parser.

No command prefix, stdout/stderr line format, error wording, path-looking prose, commit-looking prose, source code, or tool-result rendering is recovered into semantic facts.

## Custom instructions

`customInstructions === "__pi_vcc__"` is an exact routing sentinel and is never rendered by Fabric.

Every other plain instruction is explicit user data, not a mini-language. Fabric canonicalizes whitespace, bounds the input, and includes it in `[Compaction Request]` without semantically parsing it.

`compact.request` may add typed `preserve: string[]` values. When present, the controller forwards an exact versioned prefix followed by JSON. The hook accepts only the exact prefix and a strict v1 object. Once that reserved prefix is present, malformed JSON/scalars, duplicate protocol keys (including escaped-key aliases), unknown fields or versions, invalid types, unpaired UTF-16 surrogates, excessive structure, or exceeded bounds produce a structured decode error and cancel the operation; the encoded payload is never reinterpreted or rendered as plain instructions. A UI/RPC context receives a bounded error notification when available.

Typed v1 limits are enforced before value mapping or canonicalization: instructions are at most 8192 characters and 8192 UTF-8 bytes; `preserve` has at most 16 items; each item is at most 2048 characters and 2048 UTF-8 bytes; and the complete prefix-plus-JSON source is at most 16 KiB. The decoder checks the aggregate source limit before invoking its bounded recursive-descent parser, rejects duplicate decoded keys while parsing, validates scalar grammar and surrogate pairing, and checks preserve count before iterating or canonicalizing values. Plain Pi/manual instructions remain explicit bounded text and are not subjected to the typed protocol parser.

## Compaction details v2

New summaries emit `details.compactor: "fabric"` and `details.version: 2` with:

- cumulative source and live-cut ranges;
- branch, source-entry, event, and live-cut counts;
- prior recognized Fabric v1/v2 marker counts;
- per-projection omission counts and the typed preserve count (valid v1 requests cannot exceed the preserve limit);
- instruction mode, canonicalization, source size, truncation, and preserve counts;
- stable kept/source entry-id addresses and the source timestamp.

Only exact Fabric versions 1 and 2 are recognized. v1 details and rendered prose are not reused as truth. On the next compaction, an old session naturally migrates to v2 because the new result is rebuilt from raw active-branch entries. V2 validation accepts the legacy commit-omission counter for old records, but new summaries do not emit a commit projection or counter.

## Nested Fabric execution traces

For an outer `fabric_exec` tool result, normalization reads only `message.details.trace` through `readFabricExecutionTraceV1`. Operations are emitted in `operation.sequence` order with addresses such as `entry-id/0`; phases use `entry-id/phase:0`. Known `pi.read`, `pi.grep`, `pi.find`, `pi.ls`, `pi.edit`, `pi.write`, and `pi.bash` calls retain exact typed arguments and outcomes. Other refs remain typed Fabric activity.

A present but malformed or unknown trace version is ignored and is not reinterpreted as legacy data. When `trace` is absent, the legacy adapter accepts only an audit array whose records have typed `ref`, JSON `args`, boolean `success`, and optional string `error`; it never reads audit rendering or `result` prose. The outer tool conversation remains in the transcript, but `fabric_exec` source code and outer result prose cannot create file, failure, or activity facts.

## Deterministic branch summaries

When the Fabric engine is active, the same registration also handles `session_before_tree`. It returns nothing when `userWantsSummary` is false and compiles only `preparation.entriesToSummarize` when true. Tree custom instructions use the same plain/typed decoder and fail-closed limits as compaction. The exact `__pi_vcc__` value has routing meaning only for compaction; on the tree path it remains ordinary explicit request text.

`replaceInstructions: true` has Pi replacement-prompt semantics, not append-instructions semantics. A deterministic projection cannot execute an arbitrary replacement summarizer prompt, so Fabric returns `undefined` and defers to Pi or another handler. No Fabric summary or typed Fabric branch details are produced by Fabric in that explicit mode.

Branch details use `kind: "pi-fabric.branch-summary"`, `version: 1`, stable source addresses, and at most 256 bounded typed facts in a 128 KiB envelope. Facts cover source users, top-level custom messages, phases, and operations. Newly generated details record `source.oldLeafId` from `preparation.oldLeafId`; this is the canonical abandoned/from-leaf provenance. Older v1 envelopes without that field remain readable. Pi 0.80.6 writes generic `BranchSummaryEntry.fromId` from the navigation target position rather than the abandoned leaf, and a hook cannot correct that core-generated field, so consumers must use Fabric's typed `source.oldLeafId` when present.

Nested branch summaries re-emit only valid typed facts; branch summary prose is never normalized. Later compaction can therefore resolve abandoned-branch failures against later exact successes and retain custom context, files, and activity through navigation or forks without parsing prose. Since Pi supplies only the active path or the abandoned `entriesToSummarize` path to each compiler, sibling branches do not contaminate one another.

## pi-vcc precedence

Precedence remains:

1. exact `__pi_vcc__` custom-instruction sentinel;
2. configured Fabric engine;
3. pi-vcc/default Pi behavior.

Fabric marks claimed events with `_fabricCompaction`. If an earlier pi-vcc handler marked `_piVccOverriding` and Fabric has nothing to compact, Fabric does not return a cancellation that would erase the pi-vcc result. With engine `"pi"`, Fabric neither claims nor cancels the event.

Pi's public extension contract runs `session_before_*` handlers in extension load order and keeps the latest non-cancelling result. Therefore an unrelated handler loaded after Fabric can replace Fabric's compaction or tree result; a later cancellation also terminates dispatch. There is no supported public registration phase that can move one extension behind every subsequently loaded extension. Fabric preserves the explicit pi-vcc sentinel/marker cooperation above, but does not monkeypatch Pi's private runner. Deployments that require Fabric to win over arbitrary hooks must load Fabric after those extensions (while accounting for any intentionally later pi-vcc override).

## Reconstruction QA

`src/compaction/qa.ts` derives probes from normalized source events, never rendered sections. QA probes follow the same bounded sampling policy as projections: directly rendered samples are checked for content, while omitted collections are checked for count/range addressability. Mutation tests remove file, error, turn, and footer information to verify that the report detects loss.

Run:

```sh
pnpm vitest run tests/compaction-qa.test.ts
```
