# Pi Fabric skills

Pi Fabric uses a core-first, user-opt-in skill hierarchy.

## Invocation contract

- The model can invoke one execution reference for its configured kernel: `fabric-exec` (TypeScript) or `fabric-exec-python` (Python). It covers Pi core work through `fabric_exec`, `pi.*`, discovery, and stable provider proxies.
- The user invokes every advanced workflow. Each one declares `disable-model-invocation: true` and stays out of the model catalog. Agent policy forbids reading one autonomously or delegating from one user-only skill to another. The policy governs agent behavior. It is not a filesystem authorization boundary.
- `/skill:fabric-guide` is the user-only router. It names one exact advanced command and stops there. The router never invokes the recommendation.
- Each user-facing description summarizes its command. Only the selected execution reference spends always-on model context.
- Skills declare `metadata.fabric-kernel: typescript` or `python` to restrict runtime visibility; unannotated skills are shared. Fabric filters catalogs and expanded invocations each turn. Bundled advanced workflows currently require TypeScript. See [kernel-specific skills](kernels.md#kernel-specific-skills-and-guidance) for authoring and command-menu limitations.

The parent agent behaves like regular Pi until the user explicitly opts into orchestration, recursion, Schema, ambient actors, or swarm coordination.

## Information hierarchy

1. Put required ordered actions and checkable completion criteria in `SKILL.md`.
2. Use a **hard pointer** for material that the run must load before execution.
3. Use a **branch pointer** when some runs need the material and others do not.
4. Use a **soft pointer** for optional depth that improves quality. Correctness does not require it.
5. Keep skill-owned references beside the skill that owns them. Package-level profiles may point to that single source of truth.

In a packaged `SKILL.md`, write every cross-document path with the `<skill-dir>` marker, for example `<skill-dir>/references/setup.md` or `<skill-dir>/../shared/references/setup.md`. Fabric replaces the marker inline with the directory that contains the loaded `SKILL.md`. Slash-invoked skills resolve through Pi's expanded `<skill location="...">` form. For a direct `SKILL.md` read, Fabric uses the actual read path. The marker is an explicit opt-in by the author. Fabric does not match skill names, enumerate directories, or alter ordinary document reads.

A mandatory pointer serves legibility and single-source maintenance. Per-run token savings are only a side effect. Keep always-required executable code whole even when a split would shorten the skill.

## Authoring rules

- Give each meaning one source of truth.
- Prefer stable leading words that Fabric already uses: **one program**, **bounded**, **verifier**, **decision point**, **evidence loop**, **CAS claim**, and **outside observer**.
- Add a checkable **Completion criterion** only when it matches runtime behavior and does not push the agent toward whole-flow retries.
- Classify each dependency as hard, branch-conditioned, or soft.
- Apply the no-op test sentence by sentence: cut any text that leaves model behavior unchanged.
- State the target behavior in positive terms. Reserve prohibitions for safety or invocation boundaries.
- Preserve the executable TypeScript examples and their contract tests. Expensive fan-out returns `success`, `partial`, or `failed`. A `partial` result on its own implies no automatic whole-flow retry.

## User-invoked workflows

- `/skill:fabric-guide`: choose a workflow.
- `/skill:fabric-workflow`: run finite fan-out or pipeline work with verification.
- `/skill:fabric-council`: get role diversity from the same model.
- `/skill:fabric-fusion`: run multi-model deliberation (compare) or acting (read-only references + one actor).
- `/skill:fabric-rlm`: decompose context recursively.
- `/skill:fabric-schema`: gate mutation behind evidence.
- `/skill:fabric-advisor`: get persistent peer advice.
- `/skill:fabric-supervisor`: supervise a persistent goal.
- `/skill:fabric-spec`: supervise spec compliance persistently.
- `/skill:fabric-ambient`: route directly to an advisor or supervisor profile.
- `/skill:fabric-swarm`: coordinate durable actors.
