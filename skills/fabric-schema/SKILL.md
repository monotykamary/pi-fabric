---
name: fabric-schema
description: Uses Fabric's typed Schema evidence loop and, when enabled, its bounded local-file transaction channel. Use when surprise must void a plan and mutation claims need explicit postconditions.
disable-model-invocation: true
---

# Fabric Schema

Start with `const status = await schema.status();`.

- `off`: compatibility mode; state discipline is optional and does not gate direct `pi.edit`, `pi.write`, or `pi.bash`.
- `audit`: reports actions enforce mode would block without changing behavior.
- `enforce`: host authorization for protected-workspace file changes. Reads remain available; mutations require one same-`fabric_exec` `schema.hypothesize → schema.verify → schema.commit` sequence. Direct mutations, agents, state/mesh writes, compaction, MCP, extensions, and external providers are blocked.

Evidence is not proof. Verification confirms falsifiable observations at one fingerprinted workspace state; postconditions confirm scoped observations after declared operations. Either can pass without establishing general semantic correctness.

## Enforce loop

Observe, hypothesize with literal/SHA evidence or a host-configured trusted command, verify, then commit only with the returned short-lived certificate and observed SHA:

```ts
await pi.read({ path: "src/parser.ts" });
const hypothesis = await schema.hypothesize({
  label: "parser-local-form",
  summary: "The declared parser edit accepts the local form while focused checks remain green",
  evidence: [
    { kind: "file_contains", path: "src/parser.ts", literal: "old literal" },
    { kind: "trusted_command", name: "parser-focused-tests" },
  ],
});
const verification = await schema.verify({ hypothesisId: hypothesis.hypothesisId });
const { certificate: _certificate, ...safeVerification } = verification;
if (!verification.verified || !verification.certificate) {
  if (verification.certificate) {
    await schema.abort({
      hypothesisId: hypothesis.hypothesisId,
      certificate: verification.certificate,
    });
  }
  return { status: "failed", verification: safeVerification };
}

const observed = verification.results.find(
  (result) => result.evidence.path === "src/parser.ts",
)?.observedSha256;
if (!observed) {
  await schema.abort({
    hypothesisId: hypothesis.hypothesisId,
    certificate: verification.certificate,
  });
  return {
    status: "failed",
    reason: "missing observed SHA-256",
    verification: safeVerification,
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
    expectedSha256: observed,
  }],
  postconditions: [
    { kind: "file_contains", path: "src/parser.ts", literal: "new literal" },
    { kind: "trusted_command", name: "parser-focused-tests" },
  ],
});
return { status: commit.outcome === "committed" ? "success" : "failed", commit };
```

Any missing, stale, failed, timed-out, cancelled, or workspace-changing evidence voids the plan. Never invent trusted-command shell text or arguments: names resolve to static host configuration.

The certificate is random, single-use, invocation-bound, and tied to the hypothesis, state head/version, workspace fingerprint, and generation. Do not return it for later use. If stopping after verification, call this with the values from that verification:

```text
await schema.abort({
  hypothesisId: hypothesis.hypothesisId,
  certificate: verification.certificate,
});
```

Operations are project-relative regular files:

- `edit`: `oldText`, `newText`, `expectedSha256`
- `write`: `expected: { absent: true }` for creation or `{ sha256 }` for replacement
- `delete`: `expectedSha256`

Path/symlink escape is rejected. Keep operations declared, local, and small. Treat only `committed` as success; `rolled_back` restored declared paths after failure, while `quarantined` means rollback needs operator inspection.

Evidence/postcondition forms are `file_exists`, `file_absent`, `file_contains` (literal, not regex), `file_sha256`, and `trusted_command` (static host executable/argv). Trusted commands should be deterministic, local, and read-only. Remote/network/database effects are not transactional and remain blocked in enforce mode.

For a complexity-reduction claim, set `complexityReduction: true` and include behavior-preservation postconditions. Certification means those scoped checks passed, not that complexity was objectively measured.

## Off-mode state discipline

When mode is `off`, the independent labeled state layer can still record and verify a falsifiable claim:

```ts
const transition = await state.transition({
  label: "claim",
  to: "claim-stated",
  summary: "A falsifiable delta",
  evidence: ["pnpm exec vitest run tests/focused.test.ts"],
});
const verification = await state.verify();
if (!verification.certified) {
  return { status: "failed", transition, verification };
}
return { status: "success", transition, verification };
```

This is workflow discipline, not enforcement. The linked guarantee and recovery model in `../../docs/schema-enforcement.md` and labeled timeline in `../../docs/state-layer.md` are soft pointers for deeper explanation.

## Completion criterion

In enforce mode, only `status: "success"` with a `committed` outcome establishes the declared postconditions; preserve rollback/quarantine details under `commit`. Audit mode changes no behavior and grants no authorization—summarize `would_block` events only when the audit trace was actually inspected. In off mode, return the explicit certification status.
