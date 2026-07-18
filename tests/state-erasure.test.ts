import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { MeshStore, type MeshIdentity } from "../src/mesh/store.js";
import { StateProvider } from "../src/providers/state-provider.js";
import type { FabricInvocationContext } from "../src/protocol.js";
import { typeScriptJavaScriptComplexity } from "../src/state/complexity.js";
import {
  COMPLEXITY_KEY_PREFIX,
  StateStore,
  STATE_TOPIC,
} from "../src/state/store.js";

const roots: string[] = [];
const identity: MeshIdentity = {
  id: "session:erasure",
  name: "main",
  kind: "main",
  sessionId: "erasure",
};

const createRoot = (prefix: string): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
};

const createStore = (): MeshStore =>
  new MeshStore(createRoot("pi-fabric-erasure-mesh-"), 64 * 1024, 100);

const writeFixture = (root: string, file: string, source: string): void => {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
};

const invocationContext = (cwd: string): FabricInvocationContext => ({
  cwd,
  signal: undefined,
  parentToolCallId: "test",
  nestedToolCallId: "nested",
  extensionContext: {} as ExtensionContext,
  update() {},
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("structural decision-point counting", () => {
  it("counts statement keywords without counting expression operators or prose", () => {
    const source = `
      // if (commented) while (commented)
      const prose = "if (string) for (string)";
      const view = <div>if (JSX prose) while (JSX prose)</div>;
      const pattern = /catch\\s*\\(/;
      const value = input?.child ?? fallback;
      const selected = value ? left : right;
      const combined = left && right || fallback;
      if (first) run();
      else if (second) run();
      switch (value) {
        case 1: break;
        case 2: break;
        default: break;
      }
      try { run(); } catch { recover(); }
      for (const item of items) run(item);
      while (ready) run();
      export default value;
      const template = \`if (template text) \${ifInside ? "x" : "y"}\`;
    `;

    expect(typeScriptJavaScriptComplexity.count(source)).toBe(8);
  });
});

describe("evidence-attached complexity transitions", () => {
  it("records a baseline and embeds subsequent deltas in transition events", async () => {
    const project = createRoot("pi-fabric-erasure-project-");
    const file = "src/counter.ts";
    writeFixture(project, file, "if (ready) run();\n");
    const mesh = createStore();
    const store = new StateStore(mesh);

    const baseline = await store.transition(
      {
        label: "baseline",
        to: "counted-v1",
        summary: "decision count is now recorded",
        complexity: { files: [file] },
      },
      identity,
      project,
    );
    expect(baseline.event.data).toMatchObject({
      complexity: {
        netDelta: 0,
        files: [
          {
            file,
            supported: true,
            current: 1,
            delta: 0,
            baseline: true,
          },
        ],
      },
    });

    writeFixture(project, file, "if (ready) run();\nwhile (open) wait();\n");
    const increased = await store.transition(
      {
        label: "expanded",
        from: "counted-v1",
        to: "counted-v2",
        summary: "one loop decision was added",
        complexity: { files: [file] },
      },
      identity,
      project,
    );
    expect(increased.event.data).toMatchObject({
      complexity: {
        netDelta: 1,
        files: [{ file, previous: 1, current: 2, delta: 1, baseline: false }],
      },
    });
    expect(mesh.get(`${COMPLEXITY_KEY_PREFIX}${file}`)).toMatchObject({
      version: 2,
      value: { count: 2, lastDelta: 1 },
    });
    expect(store.get().complexity).toEqual({
      files: 1,
      decisionPoints: 2,
      lastNetDelta: 1,
    });
  });

  it("rejects reductions without evidence and keeps attached reductions pending until verify", async () => {
    const project = createRoot("pi-fabric-erasure-project-");
    const file = "src/reducer.ts";
    writeFixture(project, file, "if (ready) run();\ncatchError: while (open) wait();\n");
    const mesh = createStore();
    const store = new StateStore(mesh);

    await store.transition(
      {
        label: "baseline",
        to: "before-erasure",
        summary: "branch count is baselined",
        complexity: { files: [file] },
      },
      identity,
      project,
    );
    writeFixture(project, file, "run();\n");

    await expect(
      store.transition(
        {
          label: "erase",
          from: "before-erasure",
          to: "after-erasure",
          summary: "branches were removed",
          complexity: { files: [file] },
        },
        identity,
        project,
      ),
    ).rejects.toThrow(/deleting error handling.*abstraction from vandalism.*remains pending.*state\.verify/s);
    expect(
      mesh.read({ topic: STATE_TOPIC }).filter((event) => event.kind === "transition"),
    ).toHaveLength(1);
    expect(mesh.get(`${COMPLEXITY_KEY_PREFIX}${file}`)?.version).toBe(1);

    const accepted = await store.transition(
      {
        label: "evidence-attached-erase",
        from: "before-erasure",
        to: "after-erasure",
        summary: "the same behavior now has fewer branches",
        evidence: [`test -f ${file}`],
        complexity: { files: [file] },
      },
      identity,
      project,
    );
    expect(accepted.event.data).toMatchObject({
      certificationStatus: "pending",
      complexity: { netDelta: -2, files: [{ previous: 2, current: 0, delta: -2 }] },
    });
    expect(accepted.head).toMatchObject({ certificationStatus: "pending" });
    expect(store.history().transitions.at(-1)).toMatchObject({
      label: "evidence-attached-erase",
      certificationStatus: "pending",
    });

    const verification = await store.verify({ cwd: project, identity });
    expect(verification).toMatchObject({
      certified: true,
      violated: false,
      certificationStatus: "certified",
      results: [{ command: `test -f ${file}`, status: "confirmed" }],
      certificate: {
        current: true,
        targets: [{ transitionId: accepted.event.id }],
      },
    });
    expect(store.get().head).toMatchObject({
      transitionId: accepted.event.id,
      certificationStatus: "certified",
      certificate: { current: true },
    });
    expect(store.history().transitions.at(-1)).toMatchObject({
      certificationStatus: "certified",
      certificate: { targets: [{ transitionId: accepted.event.id }] },
    });
  });

  it("reports unsupported languages without creating ledger entries", async () => {
    const project = createRoot("pi-fabric-erasure-project-");
    const file = "src/example.py";
    writeFixture(project, file, "if ready:\n    run()\n");
    const mesh = createStore();
    const store = new StateStore(mesh);

    const transition = await store.transition(
      {
        label: "unsupported",
        to: "observed",
        summary: "unsupported source is left unscored",
        complexity: { files: [file] },
      },
      identity,
      project,
    );
    expect(transition.event.data).toMatchObject({
      complexity: { netDelta: 0, files: [{ file, supported: false }] },
    });
    expect(mesh.list(COMPLEXITY_KEY_PREFIX)).toEqual([]);
    expect(store.complexity({ files: [file], cwd: project })).toEqual({
      files: [{ file, supported: false }],
      netDelta: 0,
    });
  });

  it("exposes current counts through the read-risk provider action", async () => {
    const project = createRoot("pi-fabric-erasure-project-");
    const file = "src/provider.ts";
    writeFixture(project, file, "if (ready) run();\n");
    const provider = new StateProvider(createStore(), identity);
    const context = invocationContext(project);

    expect((await provider.describe("complexity", context))?.risk).toBe("read");
    const result = await provider.invoke("complexity", { files: [file] }, context);
    expect(result).toMatchObject({
      netDelta: 0,
      files: [{ file, supported: true, current: 1, delta: 0 }],
    });
  });
});

describe("representation archives", () => {
  it("folds the last representation boundary without storing archive flags", async () => {
    const mesh = createStore();
    const store = new StateStore(mesh);

    await store.transition(
      {
        label: "old-hypothesis",
        to: "schema-v1",
        summary: "the old schema",
        evidence: ["exit 1"],
      },
      identity,
    );
    await store.transition(
      {
        label: "reshape",
        from: "schema-v1",
        to: "schema-v2",
        summary: "labels now use the revised representation",
        kind: "representation",
        evidence: ["true"],
      },
      identity,
    );
    await store.transition(
      {
        label: "new-hypothesis",
        from: "schema-v2",
        to: "schema-v2-checked",
        summary: "the new schema is active",
        evidence: ["true"],
      },
      identity,
    );

    expect(store.history().transitions.map((record) => record.label)).toEqual([
      "reshape",
      "new-hypothesis",
    ]);
    expect(
      store.history({ includeArchived: true }).transitions.map((record) => record.label),
    ).toEqual(["old-hypothesis", "reshape", "new-hypothesis"]);

    const hidden = await store.verify({
      labels: ["old-hypothesis"],
      cwd: process.cwd(),
      identity,
    });
    expect(hidden).toMatchObject({
      certified: false,
      violated: true,
      results: [],
      failures: [{ reason: "missing-target" }],
    });
    const revealed = await store.verify({
      labels: ["old-hypothesis"],
      includeArchived: true,
      cwd: process.cwd(),
      identity,
    });
    expect(revealed).toMatchObject({
      violated: true,
      results: [{ command: "exit 1", status: "violated" }],
    });

    expect(mesh.list("state/").map((entry) => entry.key)).toEqual(["state/current"]);
  });
});
