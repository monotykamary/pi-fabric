import fs from "node:fs";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { describe, expect, it } from "vitest";

type Context = Record<string, unknown>;
type AsyncCallable = (...values: unknown[]) => Promise<unknown>;
type AsyncFunctionConstructor = new (...args: string[]) => AsyncCallable;

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as AsyncFunctionConstructor;

function markdownProgram(file: string): string {
  const markdown = fs.readFileSync(file, "utf8");
  const match = markdown.match(/```ts\n([\s\S]*?)\n```/);
  if (!match) throw new Error(`No TypeScript program in ${file}`);
  return match[1]!;
}

async function runProgram(file: string, context: Context): Promise<Record<string, unknown>> {
  const javascript = transpileModule(markdownProgram(file), {
    compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.None },
  }).outputText;
  const keys = Object.keys(context);
  const fn = new AsyncFunction(...keys, javascript);
  return await fn(...keys.map((key) => context[key])) as Record<string, unknown>;
}

function runSkill(name: string, context: Context): Promise<Record<string, unknown>> {
  return runProgram(`skills/${name}/SKILL.md`, context);
}

const workflow = {
  configure: async () => undefined,
  event: async () => undefined,
};
const phase = async () => undefined;
const parallel = async (thunks: Array<() => Promise<unknown>>) => Promise.all(
  thunks.map((thunk) => thunk()),
);

describe("expensive skill program behavior", () => {
  it("keeps successful council roles without returning raw reports after synthesis", async () => {
    const calls: string[] = [];
    const result = await runSkill("fabric-council", {
      π: { task: "decide", roles: JSON.stringify(["correctness", "security", "operations"]) },
      workflow,
      phase,
      parallel,
      agent: async (_prompt: string, options: { label: string }) => {
        calls.push(options.label);
        if (options.label === "security") throw new Error("provider unavailable");
        if (options.label === "council synthesis") return "bounded decision";
        return `${options.label} report`;
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      coverage: { requested: 3, completed: 2 },
      result: "bounded decision",
    });
    expect(result).not.toHaveProperty("fallback");
    expect(result.failures).toEqual([
      { role: "security", status: "failed", error: "provider unavailable" },
    ]);
    expect(calls).toHaveLength(4);
  });

  it("returns compact council reports only when synthesis fails", async () => {
    const result = await runSkill("fabric-council", {
      π: { task: "decide", roles: JSON.stringify(["a", "b", "c"]) },
      workflow,
      phase,
      parallel,
      agent: async (_prompt: string, options: { label: string }) => {
        if (options.label === "council synthesis") throw new Error("judge failed");
        return `${options.label} report`;
      },
    });

    expect(result).toMatchObject({ status: "partial", result: null, synthesisError: "judge failed" });
    expect(result.fallback).toEqual([
      { role: "a", status: "completed", report: "a report" },
      { role: "b", status: "completed", report: "b report" },
      { role: "c", status: "completed", report: "c report" },
    ]);
  });

  it("keeps RLM coverage compact and uses recursion only for oversized partitions", async () => {
    const recursive: string[] = [];
    const result = await runSkill("fabric-rlm", {
      π: { task: "map repository" },
      workflow,
      phase,
      parallel,
      agent: async (_prompt: string, options: { label: string }) => {
        if (options.label === "scope") {
          return {
            partitions: [
              { label: "small", paths: ["a.ts"], recursive: false },
              { label: "broken", paths: ["b.ts"], recursive: false },
              { label: "large", paths: ["packages/large"], recursive: true },
            ],
          };
        }
        if (options.label === "analyze broken") throw new Error("leaf failed");
        if (options.label === "combine") return "compact map";
        return "small finding";
      },
      rlm: {
        query: async ({ name }: { name: string }) => {
          recursive.push(name);
          return { status: "completed", text: "large finding", usage: { input: 50, output: 10 } };
        },
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      coverage: { requested: 3, completed: 2 },
      result: "compact map",
    });
    expect(result).not.toHaveProperty("fallback");
    expect(JSON.stringify(result)).not.toContain("usage");
    expect(recursive).toEqual(["recurse large"]);
  });

  it("preserves compact RLM findings when combination fails", async () => {
    const result = await runSkill("fabric-rlm", {
      π: { task: "map repository" },
      workflow,
      phase,
      parallel,
      agent: async (_prompt: string, options: { label: string }) => {
        if (options.label === "scope") {
          return { partitions: [
            { label: "a", paths: ["a.ts"], recursive: false },
            { label: "b", paths: ["b.ts"], recursive: false },
          ] };
        }
        if (options.label === "combine") throw new Error("combine failed");
        return `${options.label} finding`;
      },
      rlm: { query: async () => { throw new Error("unexpected recursion"); } },
    });

    expect(result).toMatchObject({ status: "partial", result: null, synthesisError: "combine failed" });
    expect(result.fallback).toEqual([
      { partition: "a", status: "completed", finding: "analyze a finding" },
      { partition: "b", status: "completed", finding: "analyze b finding" },
    ]);
  });

  it("judges available Fusion responses without returning them twice", async () => {
    const result = await runSkill("fabric-fusion", {
      π: {
        task: "compare",
        panel: JSON.stringify([{ model: "one" }, { model: "two" }, { model: "three" }]),
        judge: "",
        tools: "",
        thinking: "",
      },
      workflow,
      phase,
      parallel,
      tools: {
        models: async () => [
          { key: "p/one", id: "one", name: "One" },
          { key: "p/two", id: "two", name: "Two" },
          { key: "p/three", id: "three", name: "Three" },
        ],
      },
      agents: { models: async () => { throw new Error("no claude"); } },
      agent: async (_prompt: string, options: { label: string }) => {
        if (options.label === "panel · two") throw new Error("model failed");
        if (options.label === "fusion judge") {
          return {
            consensus: ["x"], contradictions: [], partial_coverage: ["2/3"],
            unique_insights: [], blind_spots: [],
          };
        }
        return `${options.label} response`;
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      coverage: { requested: 3, completed: 2 },
      analysis: { consensus: ["x"] },
    });
    expect(result).not.toHaveProperty("fallback");
  });

  it("preserves successful Workflow items and carries the objective through every phase", async () => {
    const prompts: string[] = [];
    const result = await runSkill("fabric-workflow", {
      π: { task: "audit authentication" },
      workflow,
      phase,
      parallel,
      agent: async (prompt: string, options: { label: string }) => {
        prompts.push(prompt);
        if (options.label === "inventory") return { items: ["a", "b", "c"] };
        if (options.label === "analyze b") throw new Error("worker failed");
        if (options.label === "verify synthesis") return "verified result";
        return `${options.label} finding`;
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      coverage: { requested: 3, completed: 2 },
      result: "verified result",
    });
    expect(result).not.toHaveProperty("fallback");
    expect(prompts.every((prompt) => prompt.includes("audit authentication"))).toBe(true);
  });

  it("verifies even a single Workflow finding", async () => {
    const calls: string[] = [];
    const result = await runSkill("fabric-workflow", {
      π: { task: "audit one module" }, workflow, phase, parallel,
      agent: async (_prompt: string, options: { label: string }) => {
        calls.push(options.label);
        if (options.label === "inventory") return { items: ["one"] };
        if (options.label === "verify synthesis") return "verified one";
        return "one finding";
      },
    });
    expect(result).toMatchObject({ status: "success", result: "verified one" });
    expect(calls).toContain("verify synthesis");
  });

  it("normalizes RLM overlaps and caps recursive roots", async () => {
    const recursive: string[] = [];
    const result = await runSkill("fabric-rlm", {
      π: { task: "map" }, workflow, phase, parallel,
      agent: async (_prompt: string, options: { label: string }) => {
        if (options.label === "scope") return { partitions: [
          { label: "parent", paths: ["src"], recursive: false },
          { label: "child", paths: ["src/a.ts"], recursive: true },
          { label: "lib", paths: ["lib"], recursive: true },
          { label: "app", paths: ["app"], recursive: true },
        ] };
        if (options.label === "combine") return "combined";
        throw new Error(`unexpected agent ${options.label}`);
      },
      rlm: { query: async ({ name }: { name: string }) => {
        recursive.push(name);
        return { status: "completed", text: `${name} finding` };
      } },
    });

    expect(result).toMatchObject({
      status: "partial",
      coverage: { requested: 4, dispatched: 2, completed: 2 },
      normalization: {
        proposed: 4,
        effective: 3,
        dispatched: 2,
        mergedOverlaps: [{ partition: "child", path: "src/a.ts", coveredBy: "src" }],
      },
      result: "combined",
    });
    expect(recursive).toHaveLength(2);
    expect(result.failures).toEqual([
      { partition: "app", paths: ["app"], status: "not_started", error: "recursive root limit reached" },
    ]);
  });

  it("returns one surviving Fusion response without spending a judge", async () => {
    const calls: string[] = [];
    const result = await runSkill("fabric-fusion", {
      π: {
        task: "compare", panel: JSON.stringify([{ model: "one" }, { model: "two" }]),
        judge: "", tools: "", thinking: "",
      },
      workflow, phase, parallel,
      tools: { models: async () => [
        { key: "p/one", id: "one", name: "One" },
        { key: "p/two", id: "two", name: "Two" },
      ] },
      agents: { models: async () => { throw new Error("no claude"); } },
      agent: async (_prompt: string, options: { label: string }) => {
        calls.push(options.label);
        if (options.label === "panel · two") throw new Error("failed");
        return "one response";
      },
    });
    expect(result).toMatchObject({ status: "partial", coverage: { requested: 2, completed: 1 } });
    expect(result).toHaveProperty("fallback");
    expect(calls).not.toContain("fusion judge");
  });

  it("rejects duplicate Fusion models before spending panel calls", async () => {
    let agentCalls = 0;
    await expect(runSkill("fabric-fusion", {
      π: {
        task: "compare", panel: JSON.stringify([{ model: "one" }, { model: "p/one" }]),
        judge: "", tools: "", thinking: "",
      },
      workflow, phase, parallel,
      tools: { models: async () => [{ key: "p/one", id: "one", name: "One" }] },
      agents: { models: async () => { throw new Error("no claude"); } },
      agent: async () => { agentCalls += 1; return "unexpected"; },
    })).rejects.toThrow("distinct resolved models");
    expect(agentCalls).toBe(0);
  });

  it("preflights Council roles and skips synthesis for one survivor", async () => {
    let calls = 0;
    await expect(runSkill("fabric-council", {
      π: { task: "decide", roles: JSON.stringify(["a", "b"]) }, workflow, phase, parallel,
      agent: async () => { calls += 1; return "unexpected"; },
    })).rejects.toThrow("3–5 distinct");
    expect(calls).toBe(0);

    const result = await runSkill("fabric-council", {
      π: { task: "decide", roles: JSON.stringify(["a", "b", "c"]) }, workflow, phase, parallel,
      agent: async (_prompt: string, options: { label: string }) => {
        calls += 1;
        if (options.label !== "a") throw new Error("failed");
        return "a report";
      },
    });
    expect(result).toMatchObject({ status: "partial", result: "a report" });
    expect(result).not.toHaveProperty("fallback");
    expect(calls).toBe(3);
  });

  it("returns Fusion responses only when judging fails", async () => {
    const result = await runSkill("fabric-fusion", {
      π: {
        task: "compare", panel: JSON.stringify([{ model: "one" }, { model: "two" }]),
        judge: "", tools: "", thinking: "",
      },
      workflow, phase, parallel,
      tools: { models: async () => [
        { key: "p/one", id: "one", name: "One" },
        { key: "p/two", id: "two", name: "Two" },
      ] },
      agents: { models: async () => { throw new Error("no claude"); } },
      agent: async (_prompt: string, options: { label: string }) => {
        if (options.label === "fusion judge") throw new Error("judge failed");
        return `${options.label} response`;
      },
    });
    expect(result).toMatchObject({ status: "partial", judgeError: "judge failed", analysis: null });
    expect(result.fallback).toHaveLength(2);
  });

  it("returns failed RLM coverage when no partition completes", async () => {
    const result = await runSkill("fabric-rlm", {
      π: { task: "map" }, workflow, phase, parallel,
      agent: async (_prompt: string, options: { label: string }) => {
        if (options.label === "scope") return { partitions: [
          { label: "a", paths: ["a"], recursive: false },
          { label: "b", paths: ["b"], recursive: false },
        ] };
        throw new Error("provider down");
      },
      rlm: { query: async () => { throw new Error("unexpected"); } },
    });
    expect(result).toMatchObject({ status: "failed", coverage: { requested: 2, completed: 0 }, result: null });
    expect(result.failures).toHaveLength(2);
  });

  it("circuit-breaks Workflow after an all-failed batch", async () => {
    const called: string[] = [];
    const result = await runSkill("fabric-workflow", {
      π: { task: "audit" }, workflow, phase, parallel,
      agent: async (_prompt: string, options: { label: string }) => {
        called.push(options.label);
        if (options.label === "inventory") {
          return { items: Array.from({ length: 9 }, (_, index) => `item-${index}`) };
        }
        throw new Error("provider down");
      },
    });
    expect(result).toMatchObject({ status: "failed", coverage: { requested: 9, completed: 0 } });
    expect(result.failures).toContainEqual({
      item: "item-8", status: "not_started", error: "not started after an all-failed batch",
    });
    expect(called).not.toContain("analyze item-8");
  });

  it("uses the first completed Fusion member as the implicit judge", async () => {
    let judgeModel: string | undefined;
    const result = await runSkill("fabric-fusion", {
      π: {
        task: "compare", panel: JSON.stringify([
          { model: "one", label: "first" },
          { model: "two", label: "second" },
          { model: "three", label: "third" },
        ]),
        judge: "", tools: "", thinking: "",
      },
      workflow, phase, parallel,
      tools: { models: async () => [
        { key: "p/one", id: "one", name: "One" },
        { key: "p/two", id: "two", name: "Two" },
        { key: "p/three", id: "three", name: "Three" },
      ] },
      agents: { models: async () => { throw new Error("no claude"); } },
      agent: async (_prompt: string, options: { label: string; model: string }) => {
        if (options.label === "panel · first") throw new Error("first provider failed");
        if (options.label === "fusion judge") {
          judgeModel = options.model;
          return { consensus: [], contradictions: [], partial_coverage: [], unique_insights: [], blind_spots: [] };
        }
        return `${options.label} response`;
      },
    });
    expect(result).toMatchObject({ status: "partial", analysis: {} });
    expect(judgeModel).toBe("p/two");
    expect(result.failures).toContainEqual({
      label: "first", model: "p/one", runner: "pi", status: "failed",
      error: "first provider failed",
    });
  });

  it("rejects unsafe RLM paths before delegation", async () => {
    let delegated = 0;
    const result = await runSkill("fabric-rlm", {
      π: { task: "map" }, workflow, phase, parallel,
      agent: async (_prompt: string, options: { label: string }) => {
        if (options.label === "scope") {
          return { partitions: [{ label: "escape", paths: ["../secret"], recursive: false }] };
        }
        delegated += 1;
        return "unexpected";
      },
      rlm: { query: async () => { delegated += 1; return { status: "completed", text: "unexpected" }; } },
    });
    expect(result).toMatchObject({
      status: "failed",
      coverage: { requested: 1, dispatched: 0, completed: 0 },
      result: null,
    });
    expect(delegated).toBe(0);
  });

  it("continues valid RLM partitions while accounting for invalid ones", async () => {
    const result = await runSkill("fabric-rlm", {
      π: { task: "map" }, workflow, phase, parallel,
      agent: async (_prompt: string, options: { label: string }) => {
        if (options.label === "scope") return { partitions: [
          { label: "invalid", paths: [], recursive: false },
          { label: "valid", paths: ["././src"], recursive: false },
        ] };
        return "valid finding";
      },
      rlm: { query: async () => { throw new Error("unexpected"); } },
    });
    expect(result).toMatchObject({
      status: "partial",
      coverage: { requested: 2, dispatched: 1, completed: 1 },
      result: "valid finding",
    });
    expect(result.failures).toEqual([
      {
        partition: "invalid", paths: [], status: "not_started",
        error: "partition paths must be non-empty project-relative paths without '~' or '..'",
      },
    ]);
  });

  it("preserves an ambient actor's extension policy on reuse", async () => {
    const calls: string[] = [];
    const existing = {
      id: "actor-1", name: "advisor", status: "idle", runner: "pi",
      events: ["turn_end"], topics: [], delivery: "steer",
      responseMode: "directive", triggerTurn: false, coalesce: true,
      tools: [], extensions: false,
    };
    const result = await runProgram("skills/fabric-ambient/references/setup.md", {
      π: {
        name: "advisor", instructions: "observe", events: JSON.stringify(["turn_end"]),
        triggerTurn: "false", model: "",
      },
      tools: { models: async () => [] },
      agents: {
        actors: async () => [existing],
        setInstructions: async () => { calls.push("instructions"); },
        setTools: async () => { calls.push("tools"); },
        setEvents: async () => { calls.push("events"); },
        setDeliveryPolicy: async () => { calls.push("delivery"); },
        actorStatus: async () => ({ ...existing, tools: ["read", "grep", "find", "ls"] }),
      },
    });

    expect(result).toMatchObject({ reused: true, warnings: [] });
    expect(calls).toContain("tools");
  });

  it("omits an extension override when creating an ambient actor", async () => {
    let request: Record<string, unknown> | undefined;
    const actor = { id: "actor-2", name: "advisor", status: "idle" };
    const result = await runProgram("skills/fabric-ambient/references/setup.md", {
      π: {
        name: "advisor", instructions: "observe", events: JSON.stringify(["turn_end"]),
        triggerTurn: "false", model: "",
      },
      tools: { models: async () => [] },
      agents: {
        actors: async () => [],
        create: async (args: Record<string, unknown>) => { request = args; return actor; },
        actorStatus: async () => actor,
      },
    });

    expect(result).toMatchObject({ started: true, actor });
    expect(request).toBeDefined();
    expect(request).not.toHaveProperty("extensions");
  });


  it("does not mutate a running ambient actor", async () => {
    let setterCalls = 0;
    const existing = {
      id: "actor-running", name: "advisor", status: "running", runner: "pi",
      events: ["turn_end"], topics: [], delivery: "steer", responseMode: "directive",
      triggerTurn: false, coalesce: true, tools: ["read", "grep", "find", "ls"],
    };
    const result = await runProgram("skills/fabric-ambient/references/setup.md", {
      π: {
        name: "advisor", instructions: "observe", events: JSON.stringify(["turn_end"]),
        triggerTurn: "false", model: "",
      },
      tools: { models: async () => [] },
      agents: {
        actors: async () => [existing],
        setInstructions: async () => { setterCalls += 1; },
        setTools: async () => { setterCalls += 1; },
        setEvents: async () => { setterCalls += 1; },
        setDeliveryPolicy: async () => { setterCalls += 1; },
      },
    });
    expect(result).toMatchObject({ reused: false, actor: existing });
    expect((result.warnings as string[])[0]).toContain("wait until idle");
    expect(setterCalls).toBe(0);
  });

  it("normalizes Schema verification and rollback outcomes", async () => {
    const failedVerification = await runSkill("fabric-schema", {
      pi: { read: async () => "source" },
      schema: {
        hypothesize: async () => ({ hypothesisId: "h1" }),
        verify: async () => ({ verified: false, certificate: null, results: [] }),
      },
    });
    expect(failedVerification).toMatchObject({ status: "failed", verification: { verified: false } });
    expect(JSON.stringify(failedVerification)).not.toContain("certificate");

    let aborted = 0;
    const missingSha = await runSkill("fabric-schema", {
      pi: { read: async () => "source" },
      schema: {
        hypothesize: async () => ({ hypothesisId: "h-missing" }),
        verify: async () => ({ verified: true, certificate: "live-cert", results: [] }),
        abort: async ({ certificate }: { certificate: string }) => {
          expect(certificate).toBe("live-cert");
          aborted += 1;
          return { aborted: true };
        },
      },
    });
    expect(missingSha).toMatchObject({ status: "failed", reason: "missing observed SHA-256" });
    expect(JSON.stringify(missingSha)).not.toContain("live-cert");
    expect(aborted).toBe(1);

    const rolledBack = await runSkill("fabric-schema", {
      pi: { read: async () => "source" },
      schema: {
        hypothesize: async () => ({ hypothesisId: "h2" }),
        verify: async () => ({
          verified: true, certificate: "cert", results: [
            { evidence: { path: "src/parser.ts" }, observedSha256: "sha" },
          ],
        }),
        commit: async () => ({ outcome: "rolled_back", error: "postcondition failed" }),
      },
    });
    expect(rolledBack).toMatchObject({
      status: "failed",
      commit: { outcome: "rolled_back", error: "postcondition failed" },
    });
  });

});
