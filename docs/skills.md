# Pi Fabric skills

Pi Fabric uses a core-first, user-opt-in skill hierarchy.

## Invocation contract

- `fabric-exec` is the only model-invoked skill. It teaches normal Pi core work through `fabric_exec`, `pi.*`, discovery, and stable provider proxies.
- Every advanced workflow is user-invoked (`disable-model-invocation: true`) and absent from the model catalog. Agent policy says not to read one autonomously or delegate from one user-only skill to another; this is not a filesystem authorization boundary.
- `/skill:fabric-guide` is the user-only router. It recommends an exact advanced command and stops; it never invokes the recommendation.
- User-facing descriptions summarize commands. Only the `fabric-exec` description spends always-on model context.

This keeps the parent agent behaving like regular Pi until the user explicitly opts into orchestration, recursion, Schema, ambient actors, or swarm coordination.

## Information hierarchy

1. Keep required ordered actions and checkable completion criteria in `SKILL.md`.
2. Use a **hard pointer** for material that must be loaded before execution.
3. Use a **branch pointer** only when some runs need the material and others do not.
4. Use a **soft pointer** for optional depth that improves quality but is not required for correctness.
5. Skill-owned references live beside their owning skill. Package-level profiles may point to that single source of truth.

A mandatory pointer is disclosure for legibility and single-source maintenance, not a per-run token saving. Do not split always-required executable code merely to shorten a skill.

## Authoring rules

- One meaning, one source of truth.
- Prefer stable leading words already used by Fabric: **one program**, **bounded**, **verifier**, **decision point**, **evidence loop**, **CAS claim**, and **outside observer**.
- Add a checkable **Completion criterion** only when it matches runtime behavior and does not encourage whole-flow retries.
- Classify dependencies as hard, branch-conditioned, or soft.
- Apply the no-op test sentence by sentence: remove text that does not change model behavior.
- State the positive target behavior; reserve prohibitions for safety or invocation boundaries.
- Preserve executable TypeScript examples and their contract tests. Expensive fan-out returns `success`, `partial`, or `failed`; partial results never imply an automatic whole-flow retry.

## User-invoked workflows

- `/skill:fabric-guide` — choose a workflow.
- `/skill:fabric-workflow` — finite fan-out/pipeline work with verification.
- `/skill:fabric-council` — same-model role diversity.
- `/skill:fabric-fusion` — multi-model deliberation.
- `/skill:fabric-rlm` — recursive context decomposition.
- `/skill:fabric-schema` — evidence-gated mutation.
- `/skill:fabric-advisor` — persistent peer advice.
- `/skill:fabric-supervisor` — persistent goal supervision.
- `/skill:fabric-ambient` — direct advisor/supervisor profile router.
- `/skill:fabric-swarm` — durable actor coordination.
