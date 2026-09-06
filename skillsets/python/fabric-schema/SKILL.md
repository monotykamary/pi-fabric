---
name: fabric-schema
description: Uses Fabric's typed Schema evidence loop and, when enabled, its bounded local-file transaction channel. Use when surprise must void a plan and mutation claims need explicit postconditions.
disable-model-invocation: true
---

# Fabric Schema — Python

Start with `await schema.status()`. `off` leaves state discipline optional; `audit` reports would-block events without changing authorization; `enforce` permits protected changes only through one same-`fabric_exec` hypothesis → verification → commit. Direct mutations, agents, state/mesh writes, compaction, MCP, extensions, and external providers are blocked. Evidence is not proof of general semantic correctness.

Adapt the literal edit, project-relative path, and host-configured trusted-command name to the observed task. Read source first; never invent command shell text or arguments.

```python
await pi.read(path="src/parser.ts")
hypothesis = await schema.hypothesize(label="parser-local-form", summary="The declared parser edit accepts the local form while focused checks remain green", evidence=[
    {"kind": "file_contains", "path": "src/parser.ts", "literal": "old literal"},
    {"kind": "trusted_command", "name": "parser-focused-tests"},
])
verification = await schema.verify(hypothesisId=hypothesis["hypothesisId"])
safe_verification = {key: value for key, value in verification.items() if key != "certificate"}
certificate = verification.get("certificate")
if not verification["verified"] or not certificate:
    if certificate:
        await schema.abort(hypothesisId=hypothesis["hypothesisId"], certificate=certificate)
    return {"status": "failed", "verification": safe_verification}
observed = None
for result in verification["results"]:
    if result["evidence"].get("path") == "src/parser.ts" and result.get("observedSha256"):
        observed = result["observedSha256"]
        break
if not observed:
    await schema.abort(hypothesisId=hypothesis["hypothesisId"], certificate=certificate)
    return {"status": "failed", "reason": "missing observed SHA-256", "verification": safe_verification}
commit = await schema.commit(hypothesisId=hypothesis["hypothesisId"], certificate=certificate, operations=[
    {"kind": "edit", "path": "src/parser.ts", "oldText": "old literal", "newText": "new literal", "expectedSha256": observed}
], postconditions=[
    {"kind": "file_contains", "path": "src/parser.ts", "literal": "new literal"},
    {"kind": "trusted_command", "name": "parser-focused-tests"},
])
return {"status": "success" if commit["outcome"] == "committed" else "failed", "commit": commit}
```

The certificate is single-use, invocation-bound, short-lived, and bound to the workspace fingerprint, hypothesis and generation. Never return it for later use. If stopping after successful verification, call `await schema.abort(hypothesisId=hypothesis["hypothesisId"], certificate=certificate)` in the same invocation. Missing, stale, failed, timed-out, cancelled, or workspace-changing evidence voids the plan.

Operations are local regular files: edit/delete require `expectedSha256`; writes require `expected={"absent": True}` or `expected={"sha256": observed}`. Path/symlink escape is rejected. Only `committed` is success; preserve rollback and quarantine details. Evidence forms are file_exists, file_absent, file_contains (literal), file_sha256, and trusted_command. Remote effects are not transactional. `complexityReduction=True` also needs scoped behavior-preservation postconditions; it is not an objective complexity measurement.

## Off-mode state discipline

```python
transition = await state.transition(label="claim", to="claim-stated", summary="A falsifiable delta", evidence=["bun run test -- tests/focused.test.ts"])
verification = await state.verify()
return {"status": "success" if verification["certified"] else "failed", "transition": transition, "verification": verification}
```

This is workflow discipline, not enforcement. Soft pointers: `<skill-dir>/../../../docs/schema-enforcement.md` and `<skill-dir>/../../../docs/state-layer.md` explain the host guarantees. Audit summaries require an actually inspected trace; do not claim that audit authorizes changes.
