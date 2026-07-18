import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { MeshStore, type MeshIdentity } from "../src/mesh/store.js";
import {
  CURRENT_KEY,
  GOAL_KEY,
  StateStore,
  STATE_TOPIC,
} from "../src/state/store.js";
import { StateProvider } from "../src/providers/state-provider.js";
import type { FabricInvocationContext } from "../src/protocol.js";

const roots: string[] = [];
const identity: MeshIdentity = {
  id: "session:test",
  name: "main",
  kind: "main",
  sessionId: "test",
};

const createStore = (): MeshStore => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-state-"));
  roots.push(root);
  return new MeshStore(root, 64 * 1024, 100);
};

const context: FabricInvocationContext = {
  cwd: process.cwd(),
  signal: undefined,
  parentToolCallId: "test",
  nestedToolCallId: "nested",
  extensionContext: {} as ExtensionContext,
  update() {},
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("StateStore", () => {
  it("appends a transition and CAS-advances the head", async () => {
    const mesh = createStore();
    const store = new StateStore(mesh);

    expect(store.get().head).toBeNull();

    const { head } = await store.transition(
      { label: "init", to: "drafted", summary: "first draft exists" },
      identity,
    );
    expect(head.to).toBe("drafted");
    expect(head.version).toBe(1);
    expect(head.label).toBe("init");

    const second = await store.transition(
      { label: "review", from: "drafted", to: "reviewed", summary: "reviewed" },
      identity,
    );
    expect(second.head.to).toBe("reviewed");
    expect(second.head.version).toBe(2);

    const entry = mesh.get(CURRENT_KEY);
    expect(entry?.value).toMatchObject({ to: "reviewed", label: "review" });

    const events = mesh.read({ topic: STATE_TOPIC });
    expect(events).toHaveLength(2);
    expect(events[0]?.kind).toBe("transition");
    expect(events[1]?.data).toMatchObject({
      label: "review",
      from: "drafted",
      to: "reviewed",
    });
  });

  it("rejects a from-mismatch naming the actual current label", async () => {
    const mesh = createStore();
    const store = new StateStore(mesh);

    await store.transition(
      { label: "init", to: "drafted", summary: "draft" },
      identity,
    );

    await expect(
      store.transition(
        { label: "review", from: "wrong", to: "reviewed", summary: "review" },
        identity,
      ),
    ).rejects.toThrow(
      `State from-mismatch: head is at "drafted", but transition declares from "wrong"`,
    );

    // The head must not have moved, and no event was appended.
    expect(store.get().head?.to).toBe("drafted");
    expect(mesh.read({ topic: STATE_TOPIC })).toHaveLength(1);
  });

  it("overrides the from-mismatch and contention guards with force", async () => {
    const mesh = createStore();
    const store = new StateStore(mesh);

    await store.transition(
      { label: "init", to: "drafted", summary: "draft" },
      identity,
    );
    const { head } = await store.transition(
      { label: "reset", from: "wrong", to: "fresh", summary: "forced reset", force: true },
      identity,
    );
    expect(head.to).toBe("fresh");
  });

  it("folds the ordered label graph and supports a label filter", async () => {
    const mesh = createStore();
    const store = new StateStore(mesh);

    await store.transition(
      { label: "init", to: "drafted", summary: "draft", tags: ["doc"] },
      identity,
    );
    await store.transition(
      { label: "review", from: "drafted", to: "reviewed", summary: "review" },
      identity,
    );
    await store.transition(
      { label: "publish", from: "reviewed", to: "shipped", summary: "shipped" },
      identity,
    );

    const all = store.history();
    expect(all.transitions.map((record) => record.to)).toEqual([
      "drafted",
      "reviewed",
      "shipped",
    ]);
    expect(all.labels).toEqual(expect.arrayContaining(["drafted", "reviewed", "shipped"]));

    const filtered = store.history({ label: "reviewed" });
    expect(filtered.transitions.map((record) => record.label)).toEqual([
      "review",
      "publish",
    ]);

    const limited = store.history({ limit: 2 });
    expect(limited.transitions).toHaveLength(2);
    expect(limited.transitions[0]?.to).toBe("drafted");
  });

  it("verifies evidence: echo is confirmed, exit 1 is violated, and publishes state.violated", async () => {
    const mesh = createStore();
    const store = new StateStore(mesh);

    await store.transition(
      {
        label: "init",
        to: "drafted",
        summary: "draft exists",
        evidence: ["test -d . || true", "exit 1"],
      },
      identity,
    );

    const { results, certified, violated, failures } = await store.verify({
      cwd: os.tmpdir(),
      identity,
    });
    expect(results).toHaveLength(2);
    expect(results[0]?.status).toBe("confirmed");
    expect(results[1]?.status).toBe("violated");
    expect(certified).toBe(false);
    expect(violated).toBe(true);
    expect(failures).toMatchObject([{ reason: "nonzero-exit", command: "exit 1" }]);

    const events = mesh.read({ topic: STATE_TOPIC });
    const violation = events.find((event) => event.kind === "state.violated");
    expect(violation).toBeDefined();
    expect(violation?.data).toMatchObject({
      certified: false,
      results: [{ status: "violated", command: "exit 1" }],
      reasons: [{ reason: "nonzero-exit", command: "exit 1" }],
    });
  });

  it("fails closed when there is no target, no matching target, or no evidence", async () => {
    const mesh = createStore();
    const store = new StateStore(mesh);

    const noHead = await store.verify({ cwd: os.tmpdir(), identity });
    expect(noHead).toMatchObject({
      certified: false,
      violated: true,
      results: [],
      failures: [{ reason: "missing-target" }],
    });

    await store.transition(
      { label: "empty", to: "unsubstantiated", summary: "claim without evidence" },
      identity,
    );
    const noEvidence = await store.verify({ cwd: os.tmpdir(), identity });
    expect(noEvidence).toMatchObject({
      certified: false,
      violated: true,
      results: [],
      failures: [{ reason: "missing-evidence", label: "empty" }],
    });

    const noMatch = await store.verify({
      labels: ["missing"],
      cwd: os.tmpdir(),
      identity,
    });
    expect(noMatch).toMatchObject({
      certified: false,
      violated: true,
      failures: [{ reason: "missing-target" }],
    });
    const emptySelection = await store.verify({ labels: [], cwd: os.tmpdir(), identity });
    expect(emptySelection).toMatchObject({
      certified: false,
      violated: true,
      failures: [{ reason: "missing-target" }],
    });
    expect(
      mesh.read({ topic: STATE_TOPIC }).filter((event) => event.kind === "state.violated"),
    ).toHaveLength(4);
  });

  it("fails closed on spawn errors, timeouts, and cancellation", async () => {
    const mesh = createStore();
    const store = new StateStore(mesh);
    await store.transition(
      {
        label: "execution-failures",
        to: "unchecked",
        summary: "commands must execute cleanly",
        evidence: ["true"],
      },
      identity,
    );

    const missingCwd = path.join(os.tmpdir(), `missing-state-cwd-${Date.now()}`);
    const spawnError = await store.verify({ cwd: missingCwd, identity });
    expect(spawnError).toMatchObject({
      certified: false,
      violated: true,
      results: [{ status: "error", exitCode: null }],
      failures: [{ reason: "execution-error" }],
    });

    await store.transition(
      {
        label: "timeout",
        from: "unchecked",
        to: "still-unchecked",
        summary: "long evidence times out",
        evidence: ["while :; do :; done"],
      },
      identity,
    );
    const timedOut = await store.verify({ cwd: os.tmpdir(), timeoutMs: 20, identity });
    expect(timedOut).toMatchObject({
      certified: false,
      violated: true,
      results: [{ status: "error", error: "timeout after 20ms" }],
    });

    const controller = new AbortController();
    controller.abort();
    const cancelled = await store.verify({
      cwd: os.tmpdir(),
      signal: controller.signal,
      identity,
    });
    expect(cancelled).toMatchObject({
      certified: false,
      violated: true,
      results: [{ status: "error", error: "aborted before execution" }],
      failures: [{ reason: "execution-error" }],
    });

    const violationEvents = mesh
      .read({ topic: STATE_TOPIC })
      .filter((event) => event.kind === "state.violated");
    expect(violationEvents).toHaveLength(3);
    for (const event of violationEvents) {
      expect(event.data).toMatchObject({ reasons: [{ reason: "execution-error" }] });
    }
  });

  it("publishes deterministic certificates and does not report them current after head changes", async () => {
    const mesh = createStore();
    const store = new StateStore(mesh);
    const transition = await store.transition(
      {
        label: "checked",
        to: "checked-v1",
        summary: "the evidence passes",
        evidence: ["printf stable"],
      },
      identity,
    );

    const first = await store.verify({ cwd: os.tmpdir(), identity });
    expect(first).toMatchObject({
      certified: true,
      violated: false,
      certificationStatus: "certified",
      results: [{ status: "confirmed", output: "stable" }],
      certificate: {
        current: true,
        targets: [{ transitionId: transition.event.id, label: "checked" }],
        head: { transitionId: transition.event.id, version: 1 },
      },
    });
    expect(first.evidenceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.resultDigest).toMatch(/^sha256:[a-f0-9]{64}$/);

    const repeated = await store.verify({ cwd: os.tmpdir(), identity });
    expect(repeated.evidenceDigest).toBe(first.evidenceDigest);
    expect(repeated.resultDigest).toBe(first.resultDigest);
    const certificateEvents = mesh
      .read({ topic: STATE_TOPIC })
      .filter((event) => event.kind === "state.certified");
    expect(certificateEvents).toHaveLength(2);
    expect(certificateEvents[0]?.data).toMatchObject({
      certificationStatus: "certified",
      targets: [{ transitionId: transition.event.id, label: "checked", to: "checked-v1" }],
      head: { transitionId: transition.event.id, version: 1 },
      evidenceDigest: first.evidenceDigest,
      resultDigest: first.resultDigest,
    });
    expect(store.get().certification.current?.targets[0]?.transitionId).toBe(
      transition.event.id,
    );

    await store.transition(
      {
        label: "changed",
        from: "checked-v1",
        to: "checked-v2",
        summary: "the head changed",
        evidence: ["true"],
      },
      identity,
    );
    const snapshot = store.get();
    expect(snapshot.certification.current).toBeNull();
    expect(snapshot.certification.recent[0]).toMatchObject({
      current: false,
      targets: [{ transitionId: transition.event.id }],
    });
    expect(store.history().transitions[0]).toMatchObject({
      label: "checked",
      certificationStatus: "certified",
      certificate: { current: false },
    });
  });

  it("verifies only the matching labels when labels are provided", async () => {
    const mesh = createStore();
    const store = new StateStore(mesh);

    await store.transition(
      { label: "init", to: "drafted", summary: "draft", evidence: ["true"] },
      identity,
    );
    await store.transition(
      {
        label: "review",
        from: "drafted",
        to: "reviewed",
        summary: "review",
        evidence: ["exit 1"],
      },
      identity,
    );

    const { results } = await store.verify({
      labels: ["reviewed"],
      cwd: os.tmpdir(),
      identity,
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.command).toBe("exit 1");
    expect(results[0]?.status).toBe("violated");
  });

  it("sets a goal and reports pass/fail with a state.goal.met event", async () => {
    const mesh = createStore();
    const store = new StateStore(mesh);

    await store.goal({ check: "test 1 -eq 1", description: "always true" }, identity);
    const goalEntry = mesh.get(GOAL_KEY);
    expect(goalEntry?.value).toMatchObject({ check: "test 1 -eq 1" });

    const passed = await store.checkGoal({ cwd: os.tmpdir(), identity });
    expect(passed.passed).toBe(true);

    const metEvents = mesh.read({ topic: STATE_TOPIC }).filter(
      (event) => event.kind === "state.goal.met",
    );
    expect(metEvents).toHaveLength(1);

    await store.goal({ check: "exit 2" }, identity);
    const failed = await store.checkGoal({ cwd: os.tmpdir(), identity });
    expect(failed.passed).toBe(false);
    expect(failed.exitCode).toBe(2);
    // Only the passing run should have published state.goal.met.
    expect(
      mesh
        .read({ topic: STATE_TOPIC })
        .filter((event) => event.kind === "state.goal.met"),
    ).toHaveLength(1);
  });

  it("throws when checkGoal is called with no goal set", async () => {
    const mesh = createStore();
    const store = new StateStore(mesh);
    await expect(
      store.checkGoal({ cwd: os.tmpdir(), identity }),
    ).rejects.toThrow("No goal set");
  });

  it("retries the CAS when contention lands on a compatible head", async () => {
    const mesh = createStore();
    const store = new StateStore(mesh);

    const first = await store.transition(
      { label: "init", to: "drafted", summary: "draft" },
      identity,
    );
    expect(first.head.version).toBe(1);

    // Simulate a concurrent writer advancing the head version without
    // changing the to-label our transition chains from. Our appended event
    // is already durable; the CAS retry must recover against version 2.
    await mesh.put({
      key: CURRENT_KEY,
      value: {
        label: "concurrent",
        to: "drafted",
        summary: "concurrent no-op at same label",
        kind: "state",
        transitionId: "concurrent",
        ts: Date.now(),
      },
      ifVersion: 1,
      identity,
    });
    expect(mesh.get(CURRENT_KEY)?.version).toBe(2);

    const advanced = await store.advanceHead({
      payload: {
        label: "review",
        to: "reviewed",
        summary: "review",
        kind: "state",
        transitionId: "retry-event",
        ts: Date.now(),
      },
      from: "drafted",
      force: false,
      expectedVersion: 1,
      identity,
    });
    expect(advanced.version).toBe(3);
    expect(advanced.value).toMatchObject({ to: "reviewed", label: "review" });
  });

  it("raises a clear contention error when a concurrent head breaks the chain", async () => {
    const mesh = createStore();
    const store = new StateStore(mesh);

    await store.transition(
      { label: "init", to: "drafted", summary: "draft" },
      identity,
    );
    await mesh.put({
      key: CURRENT_KEY,
      value: {
        label: "concurrent",
        to: "merged",
        summary: "concurrent advance",
        kind: "state",
        transitionId: "concurrent",
        ts: Date.now(),
      },
      ifVersion: 1,
      identity,
    });

    await expect(
      store.advanceHead({
        payload: {
          label: "review",
          to: "reviewed",
          summary: "review",
          kind: "state",
          transitionId: "retry-event",
          ts: Date.now(),
        },
        from: "drafted",
        force: false,
        expectedVersion: 1,
        identity,
      }),
    ).rejects.toThrow(
      `State contention: head is at "merged", cannot transition from "drafted"`,
    );
  });

  it("treats a representation transition as a Schema world-model revision", async () => {
    const mesh = createStore();
    const store = new StateStore(mesh);

    const { head } = await store.transition(
      {
        label: "reshape-model",
        to: "model-v2",
        summary: "revised the representation",
        kind: "representation",
      },
      identity,
    );
    expect(head.kind).toBe("representation");
    const events = mesh.read({ topic: STATE_TOPIC });
    expect(events[0]?.data).toMatchObject({ kind: "representation" });
  });
});

describe("StateProvider", () => {
  it("dispatches actions through the provider surface", async () => {
    const mesh = createStore();
    const provider = new StateProvider(mesh, identity);

    const listed = await provider.list({}, context);
    expect(listed.map((descriptor) => descriptor.name)).toEqual([
      "transition",
      "get",
      "history",
      "complexity",
      "verify",
      "goal",
      "checkGoal",
    ]);

    const described = await provider.describe("transition", context);
    expect(described?.risk).toBe("write");

    const { head } = (await provider.invoke(
      "transition",
      { label: "init", to: "drafted", summary: "draft" },
      context,
    )) as { head: { to: string } };
    expect(head.to).toBe("drafted");

    const snapshot = (await provider.invoke("get", {}, context)) as {
      head: { to: string };
      recentLabels: string[];
    };
    expect(snapshot.head.to).toBe("drafted");
    expect(snapshot.recentLabels).toContain("drafted");

    const history = (await provider.invoke("history", { label: "drafted" }, context)) as {
      transitions: { label: string }[];
    };
    expect(history.transitions).toHaveLength(1);

    await provider.invoke("goal", { check: "true", description: "ok" }, context);
    const goalResult = (await provider.invoke("checkGoal", {}, context)) as {
      passed: boolean;
    };
    expect(goalResult.passed).toBe(true);
  });

  it("rejects unknown state actions", async () => {
    const mesh = createStore();
    const provider = new StateProvider(mesh, identity);
    await expect(provider.invoke("bogus", {}, context)).rejects.toThrow(
      "Unknown state action: bogus",
    );
  });
});
