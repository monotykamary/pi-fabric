# State layer (fabric-schema)

The `state` provider is the Schema world-model heart of Pi Fabric: a typed, validated transition layer over mesh storage. It turns "claims carrying executable evidence" into a certified, durable artifact instead of relying on the model to remember what is true.

This document maps the Schema harness concepts to the implementation, documents the storage format so raw mesh calls can inspect it, and specifies transition/verify/goal semantics.

## Schema mapping

The ARC-AGI-3 Schema harness proved harness-enforced process beats prompt-level discipline. Its core ideas map to coding agents as follows:

| Schema concept                       | Pi Fabric implementation                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| World state as an editable, labeled artifact | The `state` head: mesh key `state/current`, a compare-and-swap value naming the current world-model version.     |
| Append-only Timeline as ground truth | Mesh topic `fabric.state`; one `transition` event per move. The head is a fold (recompute) over the log, never free-floating. |
| Certification by replaying recorded transitions | `state.verify()` re-runs each transition's evidence shell commands; tests, type checks, and greps are mostly idempotent. |
| Single gated channel from thought to action | A belief must pass `verify` before it reaches an act; a `violated` result voids the plan.                                |
| Surprise voids the plan             | On any `violated` evidence, `state.verify` publishes a `state.violated` event on `fabric.state` for subscribers to react. |
| Counterexample indicts the representation | A `state.transition` with `kind: "representation"` revises the world model itself and archives earlier labels. The boundary is folded from the log. |
| Certified erasure | A transition's declared complexity scope is counted by the harness. Net branch reduction requires replayable behavior-preservation evidence. |
| `is_goal`                            | `state.goal({ check })` sets an executable predicate; `state.checkGoal()` runs it and publishes `state.goal.met` on pass.   |

## Storage format (mesh-native, inspectable)

Storage is mesh-native. Raw mesh calls inspect everything; the typed `state` WRITE path is the only enforced surface.

### Topic `fabric.state`

Append-only JSONL event log at `<mesh-root>/events.jsonl`. Events:

- **`kind: "transition"`** — `data: { label, from?, to, summary, evidence?, tags?, kind?, complexity?, ts }`. `complexity` is `{ files: [{ file, supported, language?, previous?, current?, delta?, baseline? }], netDelta }`. `text` is the summary. `from` (mesh) is the publisher identity; `from` (data) is the source state label.
- **`kind: "state.violated"`** — published by `state.verify` when any evidence command exits non-zero. `data: { results: [...] }` with the violating commands.
- **`kind: "state.goal.met"`** — published by `state.checkGoal` when the goal predicate passes. `data: { check, output, exitCode }`.

Inspect with:

```ts
const events = await mesh.read({ topic: "fabric.state" });
const head = await mesh.get({ key: "state/current" });
const goal = await mesh.get({ key: "state/goal" });
```

### Key `state/current`

The compare-and-swap head. Value (mesh `state.json` entry):

```json
{
  "label": "applied-auth-patch",
  "to": "guard-applied",
  "summary": "Refresh-token rotation now holds the lock",
  "kind": "state",
  "transitionId": "<mesh event id>",
  "ts": 1700000000000,
  "evidence": ["grep -RIn 'lock' src/auth/refresh.ts"],
  "tags": ["auth"]
}
```

The mesh entry's `version` is the compare-and-swap version. The provider exposes it as `head.version`.

### Keys `state/complexity/<file>`

Each supported file declared in a transition has a compare-and-swap ledger entry. The suffix is the normalized project-relative path.

```json
{
  "file": "src/auth/refresh.ts",
  "language": "typescript/javascript",
  "count": 4,
  "lastDelta": -2,
  "ts": 1700000000000
}
```

The entry is the last recorded observation, not an independently mutable complexity claim. The event log retains every baseline and delta.

### Key `state/goal`

```json
{ "check": "pnpm typecheck && pnpm test", "description": "green suite" }
```

## Actions

All actions live on the `state` provider, discovered through `tools.call({ ref: "state.<action>", args })`.

### `state.transition` — risk: `write`

`{ label, from?, to, summary, evidence?, tags?, kind?, complexity?: { files: string[] }, force? }`

Validates `from` equals the current head's `to` when a head exists and `from` is provided; rejects with the actual current label on mismatch (`State from-mismatch: head is at "X", but transition declares from "Y"`). `force: true` overrides the mismatch and contention guards. Then appends a `transition` event to `fabric.state` and compare-and-swap advances `state/current` (bounded retries; a concurrent writer that breaks the chain raises a clear contention error).

When `complexity.files` is present, paths are normalized relative to the invocation's project cwd and TS/JS/TSX/JSX files are counted immediately. The first supported observation is a baseline (`delta: 0`); later observations compare against and CAS-update `state/complexity/<file>`. Unsupported extensions are returned as `supported: false` and do not enter the ledger. Per-file deltas and their net are embedded in the transition event.

A negative net delta is harness-rejected unless `evidence` contains at least one non-empty shell command. This is the Goodhart guard: deleting error handling also reduces decision points, so branch reduction alone cannot certify an abstraction. The attached behavior-preservation check is replayable by `state.verify()` and is what separates abstraction from vandalism.

`kind: "representation"` marks a Schema-style revision of the world model. It also establishes the active archive boundary described under history.

Returns `{ event, head }`.

### `state.get` — risk: `read`

Returns `{ head, goal, complexity, recentLabels }` — the current head, the goal, a compact ledger summary (`files`, `decisionPoints`, `lastNetDelta`), and the recent active label set.

### `state.history` — risk: `read`

`{ label?, limit?, includeArchived? }` folds the topic into the ordered label graph. The fold finds the **last** `kind: "representation"` transition and excludes records before it by default. This is computed from `fabric.state` on every read; there is no archive flag or second source of truth. `includeArchived: true` reveals the full append-only history. Returns `{ transitions, labels }`. A `label` filter matches a transition's `label`, `from`, or `to` inside the selected archive view.

### `state.complexity` — risk: `read`

`{ files? }` counts the requested project-relative files now and compares them with the ledger. Omit `files` to inspect all recorded files. Returns supported-language current and recorded counts, current deltas, each ledger's last recorded delta, unsupported entries, and `netDelta`.

### `state.verify` — risk: `execute`

`{ labels?, includeArchived?, timeoutMs? }` re-runs each evidence shell command from the current head (or the transitions matching `labels`) sequentially with a per-command timeout (default 30s). Archived transitions are excluded by default; `includeArchived: true` permits an explicit replay of old evidence. Returns `{ results, violated }` where each result is `{ claim, command, status, exitCode, output }` and `status` is `confirmed` (exit 0), `violated` (non-zero), or `error` (spawn/timeout). On any `violated`, publishes a `state.violated` event to `fabric.state` with the violating commands — the surprise signal actors and supervisors subscribe to.

### `state.goal` — risk: `write`

`{ check, description? }` sets the executable goal predicate at `state/goal`.

### `state.checkGoal` — risk: `execute`

`{ timeoutMs? }` runs the goal predicate; reports `{ passed, output, exitCode }`. Publishes `state.goal.met` on `fabric.state` when it passes.

## Exact complexity rule

The built-in `LanguageComplexity` implementation supports `.ts`, `.js`, `.tsx`, and `.jsx`. It lexes tokens without an AST dependency and counts these statement decision keywords:

- `if`, including one count for the `if` in each `else if`;
- `case` and `default` in a switch body;
- `catch`, including optional catch binding;
- `for` and `while`.

Strings, template/JSX prose, regular-expression literals, and comments are skipped; `${...}` and JSX expression code is tokenized. `if`/`for`/`while` require a following `(`, `default` requires `:`, and `case`/`default` require switch context. Ternaries, `&&`, `||`, optional chaining (`?.`), and nullish coalescing (`??`) do not count. Other languages return `undefined`/`supported: false`; additional implementations can plug in behind `LanguageComplexity`.

## Determinism and contention

The head is CAS-advanced on every transition with an `ifVersion` retry loop bounded at 8 attempts. Appends are durable before the head moves; the head is recomputable from the log. On CAS failure the layer re-reads the head and re-validates `from`:

- If `from` still chains from the new head, it retries the CAS with the new version.
- If `from` no longer matches (or no head existed and one appeared), it raises `State contention: head is at "X", cannot transition from "Y"` — the plan's assumed state was voided by a concurrent writer.

`force: true` skips both the pre-append from-mismatch check and the contention re-validation.

## Activity

The provider emits `context.activity` updates: a `mesh` entity (`fabric-state`) on transitions, verify runs, and goal sets, plus progress messages. These surface in the Fabric dashboard and widget.

## Skill usage

The `fabric-schema` skill (`/skill:fabric-schema <task>`) encodes the loop discipline as a model-invocable skill: observe → hypothesize (`state.transition`; competing explanations as separate labels) → verify (`state.verify`; cheapest discriminating evidence first) → act → record. Transition summaries obey the grokking rule: state the **delta from `from`**, never restate the whole world. Refactor records declare `complexity.files`; certified reductions carry behavior-preservation evidence. A revision to the state schema itself uses `kind: "representation"`, intentionally archiving obsolete label detail while retaining the raw log.

It references two sibling workstreams:

- `compact.request` — advisory compaction at phase boundaries (the compact provider's `request` action), so the parent context shrinks while the labeled head survives the compaction intact.
- `memory.recall` — recall prior work before redoing it (the memory provider), so each iteration rebuilds from evidence, not prose memory.
