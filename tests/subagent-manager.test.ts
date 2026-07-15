import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { SubagentManager } from "../src/subagents/manager.js";
import type { SubagentRunRecord, SubagentRunResult } from "../src/subagents/types.js";

const managers: SubagentManager[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("SubagentManager", () => {
  it("runs a worker through the direct process transport", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new SubagentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.subagents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
      fullCodeMode: false,
    });
    managers.push(manager);
    const result = await manager.run({ task: "Inspect this repository", transport: "process" });
    expect(result.status).toBe("completed");
    expect((result as SubagentRunResult & { fullCodeMode?: string }).fullCodeMode).toBe("false");
    expect(result.text).toBe("fake worker complete");
    expect(result.transport).toBe("process");
    expect(manager.list()).toHaveLength(1);
  });

  it("readLog returns the run's event stream and status", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new SubagentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.subagents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
      fullCodeMode: false,
    });
    managers.push(manager);
    const result = await manager.run({ task: "Inspect this repository", transport: "process" });
    expect(manager.runDirectory(result.id)).toBeDefined();
    const log = manager.readLog(result.id);
    expect(log.id).toBe(result.id);
    expect(log.logFile).toContain("events.jsonl");
    expect(log.runDirectory).toContain(path.basename(root));
    expect(log.status?.status).toBe("completed");
    const types = log.events.map((line) => (line.parsed as { type?: string } | undefined)?.type);
    expect(types).toContain("agent_start");
    expect(types).toContain("message_end");
    expect(types).toContain("agent_settled");
  });

  it("keeps direct tools native for ordinary children and full code mode for recursion", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new SubagentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.subagents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
      fullCodeMode: true,
    });
    managers.push(manager);
    type ObservedResult = SubagentRunResult & {
      fullCodeMode?: string;
      tools?: string[];
      extensions?: string;
    };

    const direct = (await manager.run({
      task: "Use native tools",
      transport: "process",
      tools: ["read", "grep"],
    })) as ObservedResult;
    expect(direct.fullCodeMode).toBe("false");
    expect(direct.tools).toEqual(["read", "grep"]);
    expect(direct.extensions).toBe("true");

    const recursive = (await manager.run({
      task: "Delegate recursively",
      transport: "process",
      tools: ["read"],
      recursive: true,
    })) as ObservedResult;
    expect(recursive.fullCodeMode).toBe("true");
    expect(recursive.tools).toEqual(["read", "fabric_exec"]);
  });

  it("validates structured output through the real Fabric worker", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const fakePi = path.resolve("tests/fixtures/fake-pi-rpc.mjs");
    fs.chmodSync(fakePi, 0o755);
    const manager = new SubagentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.subagents, {
      workerPath: path.resolve("src/worker.ts"),
      piBinary: fakePi,
      runRoot: root,
      fullCodeMode: false,
    });
    managers.push(manager);
    const result = await manager.run({
      task: "Return a directive",
      transport: "process",
      systemPrompt: "You are a test actor.",
      sessionFile: path.join(root, "actor-session.jsonl"),
      actorId: "actor-test",
      actorName: "test-actor",
      meshRoot: path.join(root, "mesh"),
      schema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["message"] },
          message: { type: "string" },
        },
        required: ["action", "message"],
        additionalProperties: false,
      },
    });
    expect(result.status).toBe("completed");
    expect(result.value).toEqual({
      action: "message",
      message: "validated actor response:false",
    });
    expect(result.usage).toMatchObject({ input: 3, output: 4 });
  });

  it("keeps the RPC worker alive when Pi announces a retry", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const fakePi = path.resolve("tests/fixtures/fake-pi-rpc.mjs");
    fs.chmodSync(fakePi, 0o755);
    const manager = new SubagentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.subagents, {
      workerPath: path.resolve("src/worker.ts"),
      piBinary: fakePi,
      runRoot: root,
      fullCodeMode: true,
    });
    managers.push(manager);

    const result = await manager.run({
      task: "RETRY_THEN_SUCCEED",
      transport: "process",
      timeoutMs: 5_000,
    });

    expect(result.status).toBe("completed");
    expect(result.text).toBe("retry recovered");
    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(0);
  });

  it("preserves provider diagnostics when the final agent attempt fails", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const fakePi = path.resolve("tests/fixtures/fake-pi-rpc.mjs");
    fs.chmodSync(fakePi, 0o755);
    const manager = new SubagentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.subagents, {
      workerPath: path.resolve("src/worker.ts"),
      piBinary: fakePi,
      runRoot: root,
      fullCodeMode: true,
    });
    managers.push(manager);

    const result = await manager.run({
      task: "FAIL_PROVIDER",
      transport: "process",
      timeoutMs: 5_000,
    });

    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(0);
    expect(result.error).toContain("openai-codex/gpt-test: fetch failed · WebSocket error");
    expect(result.error).not.toContain("exited with code 0");
  });

  it("forwards the configured default model when a call omits one", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const config = { ...DEFAULT_FABRIC_CONFIG.subagents, model: "claude-sonnet-4-5" };
    const manager = new SubagentManager(process.cwd(), config, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
      fullCodeMode: false,
    });
    managers.push(manager);
    const result = await manager.run({ task: "Use the default model", transport: "process" });
    expect(result.status).toBe("completed");
    expect(result.model).toBe("claude-sonnet-4-5");
  });

  it("lets a per-call model override the configured default", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const config = { ...DEFAULT_FABRIC_CONFIG.subagents, model: "claude-sonnet-4-5" };
    const manager = new SubagentManager(process.cwd(), config, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
      fullCodeMode: false,
    });
    managers.push(manager);
    const result = await manager.run({
      task: "Override the model",
      transport: "process",
      model: "gpt-override",
    });
    expect(result.status).toBe("completed");
    expect(result.model).toBe("gpt-override");
  });

  it("forwards the configured default thinking when a call omits one", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const config = { ...DEFAULT_FABRIC_CONFIG.subagents, thinking: "high" as const };
    const manager = new SubagentManager(process.cwd(), config, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
      fullCodeMode: false,
    });
    managers.push(manager);
    const result = await manager.run({ task: "Use the default thinking", transport: "process" });
    expect(result.status).toBe("completed");
    expect(result.thinking).toBe("high");
  });

  it("lets a per-call thinking override the configured default", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const config = { ...DEFAULT_FABRIC_CONFIG.subagents, thinking: "high" as const };
    const manager = new SubagentManager(process.cwd(), config, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
      fullCodeMode: false,
    });
    managers.push(manager);
    const result = await manager.run({
      task: "Override the thinking",
      transport: "process",
      thinking: "max",
    });
    expect(result.status).toBe("completed");
    expect(result.thinking).toBe("max");
  });

  it("forwards the medium default when neither config nor call set a thinking level", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new SubagentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.subagents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
      fullCodeMode: false,
    });
    managers.push(manager);
    const result = await manager.run({ task: "Default medium thinking", transport: "process" });
    expect(result.status).toBe("completed");
    expect(result.thinking).toBe("medium");
  });

  it("inherits the host model when neither config nor call set one", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new SubagentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.subagents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
      fullCodeMode: false,
    });
    managers.push(manager);
    const result = await manager.run({ task: "Inherit the host model", transport: "process" });
    expect(result.status).toBe("completed");
    expect(result.model).toBeUndefined();
  });

  it("notifies when a detached background agent completes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    let resolveCompletion: ((text: string) => void) | undefined;
    const completion = new Promise<string>((resolve) => {
      resolveCompletion = resolve;
    });
    const manager = new SubagentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.subagents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
      onBackgroundComplete: (result) => resolveCompletion?.(result.text),
    });
    managers.push(manager);
    const handle = await manager.spawn({ task: "Background task", transport: "process" });
    manager.detachSignal(handle.id);
    await expect(completion).resolves.toBe("fake worker complete");
  });

  it("surfaces the run-log tail when a worker exits without a terminal result", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new SubagentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.subagents, {
      workerPath: path.resolve("tests/fixtures/fake-worker-crash.mjs"),
      runRoot: root,
    });
    managers.push(manager);
    const result = await manager.run({ task: "crash test", transport: "process" });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("exited without a result");
    expect(result.error).toContain("model rate limit exceeded");
  });

  it("rejects empty tasks", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new SubagentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.subagents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
    });
    managers.push(manager);
    await expect(manager.spawn({ task: "" })).rejects.toThrow("must not be empty");
  });

  it("enforces a cross-process cost budget across spawned agents", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-budget-"));
    roots.push(root);
    const config = { ...DEFAULT_FABRIC_CONFIG.subagents, budgetUsd: 0.1 };
    const manager = new SubagentManager(process.cwd(), config, {
      workerPath: path.resolve("tests/fixtures/fake-worker-budget.mjs"),
      runRoot: root,
    });
    managers.push(manager);

    const first = await manager.run({ task: "COST 0.06", transport: "process" });
    expect(first.status).toBe("completed");
    expect(first.usage.cost).toBeCloseTo(0.06);
    expect(first.budget).toBeDefined();
    expect(first.budget?.limit).toBe(0.1);
    expect(first.budget?.spent).toBeCloseTo(0.06);
    expect(first.budget?.remaining).toBeCloseTo(0.04);

    // The check runs before the child lands its cost, so a tree may slightly
    // overshoot (matching ypi's best-effort RLM_BUDGET semantics).
    const second = await manager.run({ task: "COST 0.06", transport: "process" });
    expect(second.status).toBe("completed");
    expect(second.budget?.spent).toBeCloseTo(0.12);
    expect(second.budget?.remaining).toBe(0);

    // A third call is rejected because the accumulated spend now meets the budget.
    await expect(manager.spawn({ task: "COST 0.06", transport: "process" })).rejects.toThrow(
      /budget exceeded/,
    );
  });

  it("inherits a budget ledger from the environment for recursive children", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-budget-"));
    roots.push(root);
    process.env.PI_FABRIC_BUDGET = "0.05";
    process.env.PI_FABRIC_BUDGET_FILE = path.join(root, "tree-cost.jsonl");
    process.env.PI_FABRIC_BUDGET_ID = "inherited-tree";
    fs.writeFileSync(process.env.PI_FABRIC_BUDGET_FILE, "", { mode: 0o600 });
    try {
      const manager = new SubagentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.subagents, {
        workerPath: path.resolve("tests/fixtures/fake-worker-budget.mjs"),
        runRoot: root,
      });
      managers.push(manager);

      const result = await manager.run({ task: "COST 0.02", transport: "process" });
      expect(result.budget?.limit).toBe(0.05);
      expect(result.budget?.spent).toBeCloseTo(0.02);
      expect(result.budget?.remaining).toBeCloseTo(0.03);

      const ledger = fs.readFileSync(process.env.PI_FABRIC_BUDGET_FILE, "utf8");
      expect(ledger).toContain("\"cost\":0.02");
    } finally {
      delete process.env.PI_FABRIC_BUDGET;
      delete process.env.PI_FABRIC_BUDGET_FILE;
      delete process.env.PI_FABRIC_BUDGET_ID;
    }
  });
});

describe("SubagentManager steering", () => {
  const fakeWorker = path.resolve("tests/fixtures/fake-worker.mjs");
  const fakePiSteer = path.resolve("tests/fixtures/fake-pi-rpc-steer.mjs");

  const waitFor = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error("Timed out waiting for steer state");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  const readSteerFile = (runDir: string): Array<Record<string, unknown>> => {
    const file = path.join(runDir, "steer.jsonl");
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  };

  const hangManager = (root: string, workerPath = fakeWorker, piBinary?: string) => {
    const manager = new SubagentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.subagents, {
      workerPath,
      ...(piBinary ? { piBinary } : {}),
      runRoot: root,
      fullCodeMode: false,
    });
    managers.push(manager);
    return manager;
  };

  it("steer appends a queued steer command for a running subagent", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-steer-"));
    roots.push(root);
    const manager = hangManager(root);
    const handle = await manager.spawn({ task: "HANG", transport: "process" });
    const result = manager.steer(handle.id, "drop the token branch");
    expect(result).toEqual({ queued: true, messageId: expect.any(String) });
    const entries = readSteerFile(manager.runDirectory(handle.id)!);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "steer", message: "drop the token branch" });
    await manager.stop(handle.id);
  });

  it("steer throws for a finished subagent", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-steer-"));
    roots.push(root);
    const manager = hangManager(root);
    const result = await manager.run({ task: "done", transport: "process" });
    expect(() => manager.steer(result.id, "too late")).toThrow(/already finished/);
  });

  it("followUp appends a follow_up command", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-steer-"));
    roots.push(root);
    const manager = hangManager(root);
    const handle = await manager.spawn({ task: "HANG", transport: "process" });
    manager.followUp(handle.id, "then summarize");
    const entries = readSteerFile(manager.runDirectory(handle.id)!);
    expect(entries[0]).toMatchObject({ type: "follow_up", message: "then summarize" });
    await manager.stop(handle.id);
  });

  it("setSteeringMode and setFollowUpMode append mode commands", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-steer-"));
    roots.push(root);
    const manager = hangManager(root);
    const handle = await manager.spawn({ task: "HANG", transport: "process" });
    manager.setSteeringMode(handle.id, "all");
    manager.setFollowUpMode(handle.id, "one-at-a-time");
    const entries = readSteerFile(manager.runDirectory(handle.id)!);
    expect(entries[0]).toMatchObject({ type: "set_steering_mode", mode: "all" });
    expect(entries[1]).toMatchObject({ type: "set_follow_up_mode", mode: "one-at-a-time" });
    await manager.stop(handle.id);
  });

  it("forwards a steer to the child pi over RPC and surfaces pendingMessages", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-steer-"));
    roots.push(root);
    fs.chmodSync(fakePiSteer, 0o755);
    const received = path.join(root, "received.jsonl");
    process.env.FAKE_PI_STEER_LOG = received;
    try {
      const manager = new SubagentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.subagents, {
        workerPath: path.resolve("src/worker.ts"),
        piBinary: fakePiSteer,
        runRoot: root,
        fullCodeMode: false,
      });
      managers.push(manager);
      const handle = await manager.spawn({ task: "STEER_ME", transport: "process" });
      await waitFor(() => manager.status(handle.id).status === "running");
      manager.steer(handle.id, "redirect to session expiry");
      await waitFor(
        () =>
          fs.existsSync(received) &&
          fs.readFileSync(received, "utf8").includes("redirect to session expiry"),
        3_000,
      );
      const forwarded = fs
        .readFileSync(received, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(
        forwarded.some((e) => e.type === "steer" && e.message === "redirect to session expiry"),
      ).toBe(true);
      await waitFor(() => {
        const status = manager.status(handle.id) as SubagentRunRecord;
        return Boolean(status.pendingMessages?.steering.includes("redirect to session expiry"));
      }, 3_000);
      await manager.stop(handle.id);
    } finally {
      delete process.env.FAKE_PI_STEER_LOG;
    }
  });

  it("forwards a follow_up and a queue mode to the child pi over RPC", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-steer-"));
    roots.push(root);
    fs.chmodSync(fakePiSteer, 0o755);
    const received = path.join(root, "received.jsonl");
    process.env.FAKE_PI_STEER_LOG = received;
    try {
      const manager = new SubagentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.subagents, {
        workerPath: path.resolve("src/worker.ts"),
        piBinary: fakePiSteer,
        runRoot: root,
        fullCodeMode: false,
      });
      managers.push(manager);
      const handle = await manager.spawn({ task: "STEER_ME", transport: "process" });
      await waitFor(() => manager.status(handle.id).status === "running");
      manager.setSteeringMode(handle.id, "all");
      manager.followUp(handle.id, "then run the tests");
      await waitFor(
        () => {
          if (!fs.existsSync(received)) return false;
          const text = fs.readFileSync(received, "utf8");
          return text.includes('"type":"set_steering_mode"') && text.includes("then run the tests");
        },
        3_000,
      );
      const forwarded = fs
        .readFileSync(received, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(forwarded.some((e) => e.type === "set_steering_mode" && e.mode === "all")).toBe(true);
      expect(
        forwarded.some((e) => e.type === "follow_up" && e.message === "then run the tests"),
      ).toBe(true);
      await manager.stop(handle.id);
    } finally {
      delete process.env.FAKE_PI_STEER_LOG;
    }
  });
});
