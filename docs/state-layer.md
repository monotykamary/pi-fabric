# State layer (fabric-schema)

The `state` provider is a typed, labeled world-model layer over mesh storage. It records claims, attached executable evidence, verification outcomes, and compare-and-swap state transitions. It provides durable process state and fail-closed reporting; it is not a gate on direct Pi tools such as `pi.edit` or `pi.bash`. A forthcoming or optional strict schema mode may provide stronger enforcement, but this document does not assume one.

## Claim, evidence attachment, and certification

These are separate states:

1. A **claim** is the transition `summary` and its labeled move from one world-model state to another.
2. **Evidence attachment** stores shell commands on the transition. Attachment means only that the commands can be replayed; it does not mean they ran or passed.
3. **Certification** occurs only when `state.verify` selects at least one transition, runs at least one evidence command, and every result is `confirmed` (exit 0). A successful verification emits a durable `state.certified` event.

Verification fails closed. A missing current or requested target, empty evidence, non-zero exit, spawn error, timeout, or cancellation returns `certified: false` and `violated: true`, and emits `state.violated` with every blocking reason. `violated` is preserved for compatibility; callers should make the positive check `if (!verification.certified)`.

Evidence commands are arbitrary shell commands and are trusted workflow input. They execute with the invoking process's authority. Tests, type checks, and greps can be strong, useful evidence for a scoped claim, but passing tests are evidence rather than proof.

## Schema-inspired mapping

| Concept | Pi Fabric implementation |
| --- | --- |
| Editable labeled world state | Mesh key `state/current`, advanced with compare-and-swap. |
| Append-only timeline | Mesh topic `fabric.state`; transition and verification events remain inspectable. |
| Replayable evidence | `state.verify` executes commands attached to selected transitions. |
| Certification | A fail-closed verification report plus durable `state.certified` event and digests. |
| Surprise | `state.violated` records non-confirmed results and blocking reasons. |
| Representation revision | A `kind: "representation"` transition establishes the active history boundary. |
| Complexity reduction | Decision-point reduction requires attached evidence and remains pending until later verification succeeds. |
| Executable goal | `state.goal({ check })` stores a predicate; `state.checkGoal()` executes it. |

The `fabric-schema` skill uses these facilities as workflow discipline. The current provider does not prevent a caller from bypassing that discipline with direct tools.

## Storage format

Storage is mesh-native. Raw mesh reads can inspect all state-layer records.

### Topic `fabric.state`

The append-only JSONL event log contains:

- **`transition`** — `data: { label, from?, to, summary, evidence?, tags?, kind?, complexity?, certificationStatus?, ts }`.
- **`state.certified`** — emitted only after successful verification. Its data contains `targets`, the verification-time `head`, `evidenceDigest`, `resultDigest`, `certificationStatus: "certified"`, and `ts`.
- **`state.violated`** — emitted for every failed-closed verification. Its data contains non-confirmed `results`, all blocking `reasons`, selected `targets`, and both digests.
- **`state.goal.met`** — emitted when the executable goal predicate passes.

A certificate target includes the transition's stable `transitionId`, `label`, and `to`. When verification has a head, the certificate also records its `transitionId`, label, destination, and CAS `version`. Certificate currentness is derived by comparing that identity with the current head. Advancing the head leaves the old certificate durable but makes `current: false`; an old certificate is never presented as certification of a changed head.

Both digests use SHA-256 and a `sha256:<hex>` representation. `evidenceDigest` deterministically covers the ordered target identities and attached commands. `resultDigest` deterministically covers the exact ordered results and failures. The result digest therefore changes when command output or failure details change.

Inspect the raw values with:

```ts
const events = await mesh.read({ topic: "fabric.state" });
const head = await mesh.get({ key: "state/current" });
const goal = await mesh.get({ key: "state/goal" });
```

### Key `state/current`

The compare-and-swap head contains the transition identity and claim:

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

The mesh entry's `version` is exposed as `head.version`. A complexity-reduction head initially stores `certificationStatus: "pending"`. `state.get` overlays a later matching certificate for read purposes without rewriting or silently advancing the head.

### Keys `state/complexity/<file>`

Each supported file declared in a transition has a CAS ledger entry:

```json
{
  "file": "src/auth/refresh.ts",
  "language": "typescript/javascript",
  "count": 4,
  "lastDelta": -2,
  "ts": 1700000000000
}
```

The entry is the latest recorded observation. The event log retains baselines and deltas.

### Key `state/goal`

```json
{ "check": "pnpm typecheck && pnpm test", "description": "green suite" }
```

## Actions

Actions are discovered through `tools.call({ ref: "state.<action>", args })`.

### `state.transition` — risk: `write`

`{ label, from?, to, summary, evidence?, tags?, kind?, complexity?: { files: string[] }, force? }`

The provider validates `from` against the current head's `to` when supplied, appends a transition, then CAS-advances `state/current`. `force: true` preserves the existing mismatch/contention override behavior.

When `complexity.files` is present, project-relative TS/JS/TSX/JSX files are counted immediately. The first supported observation is a baseline; later observations compare with and update the ledger. Unsupported files are reported but do not enter the ledger.

A negative net delta is rejected unless at least one non-empty behavior-preservation command is attached. Acceptance means **evidence-attached and pending**, not certified. The transition event and returned head contain `certificationStatus: "pending"`. The write action does not execute evidence secretly. Only a later successful `state.verify` emits a certificate; `state.history` and `state.get` can then expose which reduction transition it covers.

`kind: "representation"` establishes the history archive boundary described below.

Returns `{ event, head }`.

### `state.get` — risk: `read`

Returns `{ head, goal, complexity, certification, recentLabels }`. `certification.current` is a certificate only when its recorded head identity still equals the current head. `certification.recent` retains recent visible certificates with their derived `current` flag.

### `state.history` — risk: `read`

`{ label?, limit?, includeArchived? }` folds transitions into the ordered label graph and returns `{ transitions, labels, certifications }`. Matching transitions expose a later certificate and `certificationStatus: "certified"`; a reduction without one remains `pending`.

The fold finds the last representation transition and excludes earlier transitions and their certificates by default. `includeArchived: true` reveals the full append-only transition history and permits archived certificates to be shown. A `label` filter matches `label`, `from`, or `to` within the selected archive view.

### `state.complexity` — risk: `read`

`{ files? }` counts requested project-relative files and compares them with the ledger. Omit `files` to inspect all recorded files. The result includes supported-language counts, current and recorded deltas, unsupported entries, and `netDelta`.

### `state.verify` — risk: `execute`

`{ labels?, includeArchived?, timeoutMs? }` selects the current head when `labels` is omitted, or active transitions matching the supplied labels. Archived transitions are excluded unless `includeArchived: true`.

Commands run sequentially with a per-command timeout (default 30 seconds). Each result is `{ claim, command, status, exitCode, output, error? }`, where `status` is:

- `confirmed` for exit 0;
- `violated` for a non-zero exit;
- `error` for spawn failure, timeout, or cancellation.

The report adds `{ certified, violated, certificationStatus, evidenceDigest, resultDigest, failures, certificate? }`. `certified` is true if and only if one or more evidence commands ran and every result was confirmed. All other outcomes are blocking and publish `state.violated`. A successful run publishes `state.certified` and returns its certificate.

An explicitly empty `labels` array is an empty selection and fails closed. Requesting an archived label without `includeArchived` also fails closed as a missing active target.

### `state.goal` — risk: `write`

`{ check, description? }` stores the executable goal predicate at `state/goal`.

### `state.checkGoal` — risk: `execute`

`{ timeoutMs? }` runs the goal predicate and reports `{ passed, output, exitCode, error? }`. It publishes `state.goal.met` when the command exits 0. Goal checks are separate from state certification.

## Complexity rule

The built-in complexity implementation supports `.ts`, `.js`, `.tsx`, and `.jsx`. It lexes tokens without an AST dependency and counts statement decision keywords:

- `if`, including the `if` in `else if`;
- `case` and `default` in a switch body;
- `catch`, including optional catch binding;
- `for` and `while`.

Strings, template/JSX prose, regular-expression literals, and comments are skipped; `${...}` and JSX expression code are tokenized. Ternaries, `&&`, `||`, optional chaining, and nullish coalescing do not count. Unsupported languages return `supported: false`.

## Determinism and contention

The head is CAS-advanced with a bounded eight-attempt retry loop. Transition events are durable before the head moves, so the head remains recomputable from the log. On CAS failure the layer re-reads and re-validates `from`:

- if the transition still chains from the new head, it retries with the new version;
- if the chain is broken, it raises a contention error naming the actual head.

`force: true` skips both the pre-append mismatch check and contention re-validation. Certification adds events but does not alter this transition, history, or archive behavior.

## Activity

The provider emits mesh entity activity for transitions, verification runs, and goal sets, plus progress updates. These surface in the Fabric dashboard and widget.
