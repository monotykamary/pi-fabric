# First-class shell programs in `fabric_exec`

Status: experimental model-facing interface.

## Decision

`fabric_exec` accepts exactly one authored program shape:

```text
script
   XOR
code + optional payloads
```

`payloads` and `script` solve different problems:

- `payloads` transports named multiline or syntax-heavy data into TypeScript as
  `π.key`. It keeps data out of generated source and repairs common model
  mistakes such as JSON-stringifying the named map.
- `script` represents one complete shell program directly. It removes the need
  to author a TypeScript `pi.bash(π.command)` wrapper and preserves shell intent
  for validation, approval, rendering, persistence, audit, and compaction.

The two forms are alternatives, not layers in one public call. A script cannot
also receive `payloads`; shell text already is its complete payload. Work that
combines Fabric, Pi, MCP, or extension actions, branches on structured results,
or post-processes those results stays in `code`.

## Execution seam

Public script authorship remains explicit through `prepareArguments`, Pi schema
validation, transcript persistence, rendering, and policy gates. Only the
execution seam resolves it into the existing internal program:

```ts
type FabricExecProgram =
  | { kind: "code"; code: string; strings?: Record<string, string> }
  | { kind: "script"; code: string; strings: Record<string, string> };
```

The internal `strings` name is an executor implementation detail shared with
the existing QuickJS guest bindings. It is not the model-facing legacy
`strings` field. For `code`, canonical `payloads` (or the compatibility alias
`strings`) map to those bindings. For `script`, a reserved execution-local
binding carries the authored shell bytes into a fixed `pi.bash` program.

No downstream caller infers script identity from the reserved key, a source
prefix, or a regular expression. The discriminant is the explicit authored
`script` field and the resulting `kind: "script"` program.

After resolution, both forms use the same typecheck, QuickJS, provider registry,
approval, nested lifecycle, audit, trace, timeout, cancellation, middleware,
and output-budget paths. Script is syntax sugar over the existing runtime, not
a second shell executor.

## Interface contract

- Exactly one of `code` or `script` is required.
- `timeout` and `settle` are script-only convenience fields compiled into the
  nested `pi.bash` options.
- `payloads`, the legacy `strings` alias, `tokenBudget`, and `agentBudget` reject
  alongside `script`; a caller needing those capabilities belongs in `code`.
- `display`, `resultFormat`, and the outer `timeoutMs` retain their normal
  `fabric_exec` behavior.
- Null optional values normalize away before authoritative schema validation.
- Malformed required values still fail validation; compatibility repair does
  not guess ambiguous intent.

## Selection rule

Choose by program shape, not length:

- One shell program, including pipelines, heredocs, loops, or several ordered
  shell commands: `script`.
- Multiple Fabric/Pi/MCP/extension actions, result-dependent control flow, or
  structured post-processing: `code`.
- TypeScript orchestration carrying long document or command data: `code` plus
  `payloads`.

## Policy and trade-offs

The shell payload is deliberately not TypeScript-checked. Syntax and quoting
errors reach Bash. Callers should use `set -eu` when early failure is desired.
This moves a pure-shell authoring error from the TypeScript parser to the shell
that owns the grammar; it does not make that error impossible.

Script runs only in ordinary full-code mode and Schema audit mode.
Orchestration-only sessions use native Pi tools. Schema enforce mode rejects an
opaque script before QuickJS or nested lifecycle events, because protected
mutations must remain visible to the schema transaction path.

The compact title derives only a safe command identity. Arguments can contain
credentials, URLs, paths, or payload data and therefore do not enter durable
titles. Expanded user-visible views may still show the complete authored
script, just as native shell tools do.

## Evidence and limits

An event-time, tool-call-ID-deduplicated local dogfood review observed:

- 616 authored script calls across 20 selected session files;
- 499 multiline scripts and 177 heredoc candidates;
- 374 calls with `settle: true`;
- zero observed pre-invocation schema or wrapper-compilation rejections;
- 49 outer errors, all after reaching `pi.bash` (47 command nonzero exits and
  two command timeouts).

Those records span local dogfood builds and are adoption/compatibility evidence,
not a task-success rate or proof of universal latency improvement. Raw sessions,
shell payloads, and business output are not part of the repository or PR.

The current `0.76.2` integration is covered at the real host seams: raw script
through `prepareArguments` and Pi validation, code payload canonicalization,
execute-time program resolution, approval, nested tool call/result lifecycle,
settlement, timeout, cancellation, persistence, rendering, and parity with a
hand-authored `pi.bash` call.

## Non-goals

- Replacing `payloads` or the TypeScript program form.
- Guessing that malformed TypeScript was intended to be shell.
- Converting based on payload length.
- Introducing a second Bash runtime, native-shell bypass, or stdin transport.
- Making shell text available in Schema enforce mode.
- Claiming that every shell-shaped task is faster or more reliable.
