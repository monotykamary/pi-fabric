---
name: fabric-schema
description: Runs the Schema observe-hypothesize-verify-act-record loop in Pi Fabric over the labeled state layer. Use for work where claims must carry executable evidence and a surprise must void the plan rather than be explained away.
disable-model-invocation: true
---

# Fabric Schema Loop

Schema's harness beat prompt-level discipline by making process machine-enforced: world state is an editable, labeled artifact; an append-only Timeline is ground truth; certification replays the recorded transitions before planning; a single gated channel runs from thought to action; a surprise voids the plan; a persistent counterexample can indict the representation itself, not just a rule.

For coding agents, exact trajectory replay does not transfer — but claims carrying **executable evidence** do. Certification becomes re-running the checks that grounded each belief (tests, type checks, greps are mostly idempotent). This skill encodes that discipline as one `fabric_exec` program over the `state` provider.

## The loop

Run one `fabric_exec` program. Each iteration is: **observe → hypothesize → verify → act → record**.

1. **Observe.** Read the current world state with `state.get()`. The head names where the model believes the work is. If you have done related work before, call `memory.recall` first so you do not redo it (see the memory provider, added by a sibling workstream).

2. **Hypothesize.** Commit a hypothesis as a `state.transition` **before** acting. The transition's `summary` is a falsifiable claim, and its `evidence` is the cheapest shell command that discriminates this hypothesis from its rivals. A summary is a **delta from `from`**, not a restatement of the world: express what becomes true relative to the previous label. When explanations compete, record each as its own labeled transition (separate `label`/`to`) so the log holds competing world-model versions rather than one merged guess.

3. **Verify.** Call `state.verify()` to re-run the evidence commands. It returns `confirmed` (exit 0), `violated` (non-zero), or `error` (spawn/timeout). Run the cheapest command that discriminates between hypotheses first; stop discriminating once one survives. **On any `violated`, the plan is void.** `state.verify` publishes a `state.violated` event on topic `fabric.state`; actors and supervisors subscribed to that topic react to the surprise without the main agent re-asserting it.

4. **Act.** Only after verification passes, make the change. A gated channel: a belief that did not survive `verify` must not reach an action.

5. **Record.** Commit the outcome as the next transition. Again, summarize only the delta from `from`. If the outcome contradicts the hypothesis, that is a surprise — void the plan, revise the hypothesis, and transition again. A **persistent** counterexample that survives repeated `verify` indicts the *representation* (the labels/kind you are using), not just the current rule: emit a `state.transition` with `kind: "representation"` to revise the world model itself. That event archives every earlier label; the active history is rebuilt from the last representation transition, while `state.history({ includeArchived: true })` remains available for inspection.

## Certified erasure

Models naturally add information. During a refactor, make removal explicit by adding `complexity: { files: [...] }` to the outcome transition. The harness counts statement-level TS/JS/TSX/JSX decision keywords and records the per-file deltas. A net reduction is rejected unless the transition carries at least one replayable behavior-preservation command in `evidence`: deleting error handling also reduces branches, so only executable evidence separates abstraction from vandalism. Run `state.verify()` after the transition to replay that certificate.

Use `kind: "representation"` when the state schema itself changes, not merely when implementation branches are reduced. Representation changes deliberately erase old label detail from the active model; they do not delete the append-only log.

## Goal

Set the executable goal predicate up front with `state.goal({ check, description })`. `check` is a shell command; exit 0 means the goal is met. Re-check with `state.checkGoal()` after each act; it publishes a `state.goal.met` event on `fabric.state` when it passes, so subscribed supervisors can stop the loop.

## Compaction at phase boundaries

The context is a cache, not the store. State lives in the durable mesh log. At a phase boundary (a verified transition that closes a major step), request advisory compaction via `compact.request` (the compact provider's `request` action, added by a sibling workstream) so the parent context shrinks while the labeled state head survives the compaction intact — the next iteration rebuilds from `state.get()`, not from prose memory.

## Shape

```ts
await workflow.configure({
  name: "Schema loop",
  description: "observe → hypothesize → verify → act → record, with executable evidence",
});

await state.goal({
  check: "pnpm typecheck && pnpm test",
  description: "Type checks pass and the suite is green",
});

let head = (await state.get()).head;
while (true) {
  await phase("Hypothesize", { total: 1 });
  await state.transition({
    label: "hypothesis-auth-leak",
    ...(head ? { from: head.to } : {}),
    to: "hypothesis-stated",
    summary: "Refresh-token rotation is non-atomic; a grep for the guard finds it missing",
    evidence: ["grep -RIn 'refreshToken' src/auth | grep -v lock || exit 1"],
  });

  await phase("Verify", { total: 1 });
  const verification = await state.verify();
  if (verification.violated) {
    // Surprise voids the plan. Revise the hypothesis; do not act on a belief
    // that failed verification.
    head = (await state.get()).head;
    continue;
  }

  await phase("Act", { total: 1 });
  await pi.edit({ path: "src/auth/refresh.ts", old: "…", new: "…" });

  await phase("Record", { total: 1 });
  await state.transition({
    label: "applied-atomic-guard",
    from: "hypothesis-stated",
    to: "guard-applied",
    summary: "Relative to hypothesis-stated, refresh-token rotation now holds the lock",
    evidence: ["grep -RIn 'lock' src/auth/refresh.ts"],
    complexity: { files: ["src/auth/refresh.ts"] },
  });

  const goal = await state.checkGoal();
  if (goal.passed) break;
  head = (await state.get()).head;

  // Advisory compaction at the phase boundary; the labeled head survives.
  // await compact.request({ reason: "verified transition; next hypothesis" });
}
return { ok: true, head: (await state.get()).head };
```

Adapt the labels, evidence commands, complexity scope, and goal predicate to the request. Evidence should be the *cheapest* idempotent check that falsifies the claim — a `grep`, a `typecheck`, or a single test — not a full rebuild. Prefer many small falsifiable deltas over one large confident restatement.

## Storage is transparent

Every transition, violation, and goal-met event lands on mesh topic `fabric.state` as `kind: "transition" | "state.violated" | "state.goal.met"`. The head is a compare-and-swap value at mesh key `state/current`; the goal is at `state/goal`. Raw mesh calls (`mesh.read({ topic: "fabric.state" })`, `mesh.get({ key: "state/current" })`) inspect everything — there is no hidden state. See `docs/state-layer.md`.
