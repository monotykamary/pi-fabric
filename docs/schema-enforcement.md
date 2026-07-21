# Schema enforcement

Schema enforcement is an opt-in host authorization and local-file transaction layer over Fabric. It is disabled by default for compatibility.

```json
{
  "schema": {
    "mode": "enforce",
    "certificateTtlMs": 30000,
    "maxFiles": 100,
    "maxBytes": 10485760,
    "trustedCommands": {
      "focused-tests": {
        "command": "pnpm",
        "args": ["exec", "vitest", "run", "tests/focused.test.ts"],
        "shell": false,
        "timeoutMs": 30000
      }
    }
  }
}
```

`mode` is `off`, `audit`, or `enforce`. Invalid values normalize to `off`. The certificate TTL is bounded to 1 second–10 minutes, file count to 1–1,000, and transaction bytes to 1 KiB–100 MiB. The default is `off`, 30 seconds, 100 files, and 10 MiB. Mode is fixed when the session initializes; a config reload cannot change it until the next session.

Global Fabric configuration is trusted host input. Project `.pi/fabric.json` is read only when Pi marks the project trusted. Therefore `trustedCommands` cannot be supplied through a model action or an untrusted project configuration.

## Modes

- **off** preserves existing action authorization and tool visibility. The `schema.*` control plane is available but does not gate other actions.
- **audit** allows existing behavior and publishes a durable `would_block` event to `fabric.schema` for every nested Fabric action or top-level Pi tool call enforce mode would deny.
- **enforce** permits only this extension's exact, source-provenanced `fabric_exec` definition at the top level. A `tool_call` gate blocks every other built-in, external-extension, and SDK `customTools` call before execution. Nested calls are admitted only while an owned outer invocation is active and their id begins with Fabric's generated `NESTED_TOOL_CALL_ID_PREFIX`; those calls have already passed registry authorization. The central resolved-action gate remains authoritative inside Fabric, so direct refs and computed `tools.call` refs share the same decision.

Enforce mode allows discovery and workflow display operations plus these exact host-owned actions:

- `pi.read`, `pi.grep`, `pi.find`, `pi.ls`;
- `memory.recall`, `memory.expand`, `memory.sessions`;
- `state.get`, `state.history`, `state.complexity`;
- `mesh.self`, `mesh.read`, `mesh.members`, `mesh.get`, `mesh.list`;
- `compact.status`;
- `schema.status`, `schema.hypothesize`, `schema.verify`, `schema.commit`, `schema.abort`.

It blocks `pi.edit`, `pi.write`, `pi.bash`, all agent/actor actions, mesh and state writes or execution, `compact.request` and `compact.cancel`, MCP, captured extensions, and every external provider regardless of its declared risk. A provider claiming `risk: "read"` does not bypass this exact-reference policy. Guard failures are recorded in the existing typed execution trace with `failureStage: "guard"`.

Persistent actors are not restored and host-event actor dispatch is disabled for an enforce session. Subagent execution is disabled and agent actions are blocked. Capture `keepVisible`, descriptor risk, claimed source metadata, or tool visibility cannot authorize a second top-level path. A colliding external or SDK tool named `fabric_exec` is blocked unless Pi's canonical `sourceInfo.path` identifies this extension entry exactly.

## Transaction protocol

Use all steps in one `fabric_exec` invocation. Certificates are bound to its `parentToolCallId` and cannot be transferred to a later call.

1. `schema.hypothesize` stores a nonempty typed evidence set with a label and summary. It binds the durable hypothesis to the current state head/version, workspace fingerprint, workspace generation, and invocation.
2. `schema.verify` checks that all bindings are still current, evaluates every evidence item, and fingerprints before and after evidence. Missing, empty, nonconfirmed, errored, timed-out, cancelled, or workspace-changing evidence fails closed. Only a fully confirmed run issues a cryptographically random, TTL-bounded certificate.
3. `schema.commit` requires both Fabric write and execute approval. It compare-and-swap consumes the certificate exactly once, checks all bindings again, captures durable before images, applies bounded declared operations sequentially, and requires a nonempty typed postcondition set. Any failed operation, undeclared drift, or failed postcondition restores all declared paths. A failed rollback is recorded as `quarantined`; a successful rollback is `rolled_back`.
4. `schema.abort` closes an uncommitted hypothesis and optionally its certificate. Fabric also abandons active artifacts when their `fabric_exec` invocation ends.

Known Schema actions use the typed first-class proxy; reserve `tools.call()` for refs computed at runtime:

```ts
const hypothesis = await schema.hypothesize({
  label: "update-parser",
  summary: "The parser accepts the new local form without changing existing cases",
  evidence: [
    { kind: "file_sha256", path: "src/parser.ts", sha256: "sha256:<64 hex>" },
    { kind: "trusted_command", name: "focused-tests" }
  ]
});

const verification = await schema.verify({
  hypothesisId: hypothesis.hypothesisId
});
const { certificate: _certificate, ...safeVerification } = verification;
if (!verification.verified || !verification.certificate) {
  if (verification.certificate) {
    await schema.abort({
      hypothesisId: hypothesis.hypothesisId,
      certificate: verification.certificate
    });
  }
  return { status: "failed", verification: safeVerification };
}
const parserEvidence = verification.results.find(
  (result) => result.evidence.path === "src/parser.ts",
);
if (!parserEvidence?.observedSha256) {
  await schema.abort({
    hypothesisId: hypothesis.hypothesisId,
    certificate: verification.certificate
  });
  return {
    status: "failed",
    reason: "missing observed SHA-256",
    verification: safeVerification
  };
}

const commit = await schema.commit({
  hypothesisId: hypothesis.hypothesisId,
  certificate: verification.certificate,
  operations: [{
    kind: "edit",
    path: "src/parser.ts",
    oldText: "old literal",
    newText: "new literal",
    expectedSha256: parserEvidence.observedSha256
  }],
  postconditions: [
    { kind: "file_contains", path: "src/parser.ts", literal: "new literal" },
    { kind: "trusted_command", name: "focused-tests" }
  ]
});
return { status: commit.outcome === "committed" ? "success" : "failed", commit };
```

## Evidence and preconditions

Evidence is data, not model-provided shell. Confirmed evidence about an existing file returns its verification-time `observedSha256`, which can be used as the commit precondition without enabling a shell:

- `file_exists: { path }`;
- `file_absent: { path }`;
- `file_contains: { path, literal }`, using literal containment;
- `file_sha256: { path, sha256 }`;
- `trusted_command: { name }`, selecting a host-configured command without model arguments.

No command text, source text, or prose is classified with a regex policy. SHA-256 syntax and provider/config identifiers receive ordinary structural validation only.

Trusted commands are part of the trusted computing base. With `shell: false` (the default), Fabric calls the configured executable with the configured static argv directly, without shell interpretation. With `shell: true`, `command` is the complete trusted shell program and `args` is normalized to an empty array; this avoids pretending shell argv can be escaped portably. Both forms are trusted configuration, never model input. Configure verification commands to be local, deterministic, and read-only. Fabric detects workspace changes after a command, but it cannot prevent a misconfigured trusted command from producing transient or non-workspace side effects.

Commit operations are exact and local:

- `write` requires `expected: { absent: true }` or `expected: { sha256 }`;
- `edit` requires `expectedSha256`, and `oldText` must occur exactly once;
- `delete` requires `expectedSha256`.

Paths must be project-relative regular-file paths. Absolute paths, `..` escape, symbolic links in any component, non-file targets, and missing parent directories are rejected. A transaction does not create directories. Before-image bytes plus write/edit payload bytes must fit `maxBytes`; distinct declared paths must fit `maxFiles`.

A hypothesis can mark `complexityReduction: true`. The committed outcome reports `complexityReductionCertified: true` only after its nonempty postconditions all pass. This certifies only those stated postconditions; it is not a proof of semantic equivalence or an objective complexity measurement.

## Workspace binding and durability

In Git worktrees, the deterministic fingerprint covers:

- exact `HEAD` identity (or an unborn head);
- the NUL-delimited index stage listing;
- path and content/type hashes for every tracked worktree path;
- path and content/type hashes for untracked, non-ignored paths.

Git is invoked with machine-oriented output (`-z` where paths are present); human `git status` prose is never parsed. The session `cwd` must be the worktree root. Unsupported tracked non-file entries (for example, a submodule directory) fail the snapshot rather than silently weakening it. Outside Git, Fabric recursively hashes eligible project files with conservative file/byte bounds and skips dependency/build/cache directories. Host mesh and transaction-journal storage is excluded from the protected snapshot so recording a hypothesis does not invalidate itself.

Hypotheses, certificates, gate reports, and outcomes are durable mesh records/events under `schema/*` and topic `fabric.schema`. A workspace generation compare-and-swap serializes successful outcomes in addition to a cross-process commit lock. Before images are written with owner-only permissions under the mesh transaction journal before mutation. On initialization, an `applying` journal whose owner process is gone is restored; an unreadable or unrestorable journal remains available for operator quarantine. Certificates are CAS-consumed before the first file operation, so a crash cannot make one reusable.

A clean commit advances the Schema generation and best-effort appends a normal state outcome transition. State-transition contention does not falsify the already durable Schema workspace outcome.

## Exact guarantee and limitations

Subject to the host process, filesystem, trusted Fabric configuration, configured trusted commands, and Pi's canonical tool lifecycle/provenance behaving as trusted components, enforce mode guarantees that **model-originated mutation of regular files under the initialized local workspace can be authorized only by this extension's source-provenanced top-level `fabric_exec` and one same-invocation, fresh-certificate `schema.commit` path**, with explicit preconditions, declared paths, bounded captured before images, nonempty typed postconditions, single-use CAS consumption, and rollback reporting.

The guarantee is deliberately narrower than “all effects are transactional”:

- it does not cover remote services, network calls, databases, device files, other processes, or writes performed outside Fabric; enforce mode blocks model access to those provider channels rather than pretending to roll them back;
- it does not provide a kernel sandbox against a malicious extension, SDK host, or host process; trusted host code can invoke effects without model tool calls or falsify lifecycle/provenance data;
- nested-call admission relies on Pi delivering Fabric's reserved generated id prefix unchanged and on Fabric tracking an active owned outer invocation; arbitrary top-level ids with that prefix are still sent through the gate when no owned outer call is active;
- trusted commands are an explicit TCB and can have effects if configured unsafely;
- filesystem rollback cannot be perfectly atomic across process death or hostile concurrent writers; journals recover declared regular files and quarantine failures;
- file postconditions and tests are scoped evidence, not proof;
- host metadata under the configured mesh root is intentionally outside the protected fingerprint.
