import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import type { FabricLifecyclePublishRequest } from "../src/lifecycle/types.js";
import { snapshotHandoffSession } from "../src/agents/handoff.js";
import {
  effectiveAgentTimeoutMs,
  AgentManager,
} from "../src/agents/manager.js";
import type { AgentRunRecord, AgentRunResult } from "../src/agents/types.js";

const managers: AgentManager[] = [];
const roots: string[] = [];
const handoffSeed = (fact = "Rare handoff fact 43117") => {
  const source = SessionManager.inMemory();
  source.appendMessage({ role: "user", content: fact, timestamp: 1 });
  source.appendModelChange("anthropic", "frontier");
  source.appendThinkingLevelChange("high");
  source.appendMessage({
    role: "assistant",
    content: [
      { type: "text", text: "Ready to continue from the fork." },
      {
        type: "toolCall",
        id: "outer-manager-handoff",
        name: "fabric_exec",
        arguments: { code: "return agents.handoff(...)" },
      },
    ],
    api: "anthropic",
    provider: "anthropic",
    model: "frontier",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 2,
  });
  return snapshotHandoffSession(
    source,
    { provider: "anthropic", id: "frontier" },
    {
      role: "toolResult",
      toolCallId: "outer-manager-handoff",
      toolName: "fabric_exec",
      content: [{ type: "text", text: "Manager boundary complete" }],
      details: { success: true },
      isError: false,
      timestamp: 3,
    },
    "outer-manager-handoff",
  );
};
const fabricEnvKeys = [
  "PI_FABRIC_DEPTH",
  "PI_FABRIC_BUDGET",
  "PI_FABRIC_BUDGET_FILE",
  "PI_FABRIC_BUDGET_ID",
] as const;
const inheritedFabricEnv = new Map(
  fabricEnvKeys.map((key) => [key, process.env[key]]),
);

beforeAll(() => {
  for (const key of fabricEnvKeys) delete process.env[key];
});

afterAll(() => {
  for (const [key, value] of inheritedFabricEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("effectiveAgentTimeoutMs", () => {
  it("ignores per-call timeouts below the configured default", () => {
    expect(effectiveAgentTimeoutMs(3_600_000, 240_000)).toBe(3_600_000);
  });

  it("accepts per-call timeouts above the configured default", () => {
    expect(effectiveAgentTimeoutMs(3_600_000, 7_200_000)).toBe(7_200_000);
  });

  it("respects a configured default below 60 minutes", () => {
    expect(effectiveAgentTimeoutMs(1_800_000, 900_000)).toBe(1_800_000);
    expect(effectiveAgentTimeoutMs(1_800_000, 2_400_000)).toBe(2_400_000);
  });
});

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("AgentManager", () => {
  it("notifies and releases UI subscribers", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
    });
    managers.push(manager);
    const listener = vi.fn();
    const unsubscribe = manager.subscribeUi(listener);

    const result = await manager.run({ task: "Observe state", transport: "process" });
    expect(listener).toHaveBeenCalled();

    unsubscribe();
    const beforeCleanup = listener.mock.calls.length;
    await manager.cleanup(result.id);
    expect(listener).toHaveBeenCalledTimes(beforeCleanup);
  });

  it("runs a worker through the direct process transport", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
      fullCodeMode: false,
    });
    managers.push(manager);
    const result = await manager.run({ task: "Inspect this repository", transport: "process" });
    expect(result.status).toBe("completed");
    expect((result as AgentRunResult & { fullCodeMode?: string }).fullCodeMode).toBe("false");
    expect(result.text).toBe("fake worker complete");
    expect(result.transport).toBe("process");
    expect(manager.list()).toHaveLength(1);
    fs.rmSync(path.join(manager.runDirectory(result.id)!, "status.json"));
    expect(manager.status(result.id).status).toBe("completed");
  });

  it("relays child Pi lifecycle records and a normalized terminal event", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const lifecycle: FabricLifecyclePublishRequest[] = [];
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
      mainAgentId: "session:root",
      hostId: "host:root",
      identityId: "session:root",
      onLifecycle: (event) => lifecycle.push(event),
    });
    managers.push(manager);

    const result = await manager.run({ task: "Observe lifecycle", transport: "process" });

    expect(lifecycle.map((event) => event.event)).toEqual([
      "pi.agent_start",
      "pi.turn_end",
      "pi.agent_end",
      "pi.agent_settled",
      "run.completed",
    ]);
    expect(lifecycle.at(-1)).toMatchObject({
      source: {
        id: result.id,
        kind: "agent",
        rootId: "session:root",
        ownerHostId: "host:root",
        ownerIdentityId: "session:root",
      },
      runId: result.id,
      status: "completed",
    });
    expect(lifecycle.find((event) => event.event === "pi.turn_end")?.data).toEqual({
      turnIndex: 0,
    });
  });

  it("materializes a private Pi session for a trajectory handoff seed", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
    });
    managers.push(manager);
    const handle = await manager.spawn({
      task: "HANG while the handoff session is inspected",
      runner: "pi",
      transport: "process",
      model: "anthropic/executor",
      sessionSeed: handoffSeed(),
    });
    const handoffDirectory = path.join(manager.runDirectory(handle.id)!, "handoff-session");
    const [sessionName] = fs.readdirSync(handoffDirectory);
    expect(sessionName).toBeDefined();
    const session = SessionManager.open(path.join(handoffDirectory, sessionName!));
    expect(session.buildSessionContext()).toMatchObject({
      messages: [
        { role: "user", content: "Rare handoff fact 43117" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Ready to continue from the fork." },
            { type: "toolCall", id: "outer-manager-handoff", name: "fabric_exec" },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "outer-manager-handoff",
          toolName: "fabric_exec",
          content: [{ type: "text", text: "Manager boundary complete" }],
        },
      ],
      model: { provider: "anthropic", modelId: "frontier" },
      thinkingLevel: "high",
    });
    await manager.stop(handle.id);
  });

  it("rejects trajectory seeds for the Claude runner and conflicting session files", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
    });
    managers.push(manager);
    const sessionSeed = handoffSeed("Invalid seed");
    await expect(
      manager.spawn({ task: "invalid", runner: "claude", sessionSeed }),
    ).rejects.toThrow(/only supported by the Pi runner/);
    await expect(
      manager.spawn({
        task: "invalid",
        runner: "pi",
        sessionSeed,
        sessionFile: path.join(root, "existing.jsonl"),
      }),
    ).rejects.toThrow(/cannot combine sessionSeed with sessionFile/);
  });

  it("coalesces concurrent Pi model preparation by provider", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const preparePiModel = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
      preparePiModel,
    });
    managers.push(manager);

    const results = await Promise.all([
      manager.run({
        task: "First prepared child",
        model: "openai-codex/gpt-first",
        transport: "process",
      }),
      manager.run({
        task: "Second prepared child",
        model: "openai-codex/gpt-second",
        transport: "process",
      }),
    ]);

    expect(results.every((result) => result.status === "completed")).toBe(true);
    expect(preparePiModel).toHaveBeenCalledTimes(1);
  });

  it("retries a Pi child that fails before its first turn", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker-startup-retry.mjs"),
      runRoot: root,
    });
    managers.push(manager);

    const result = await manager.run({ task: "Recover startup", transport: "process" });

    expect(result.status).toBe("completed");
    expect(result.text).toBe("startup retry recovered");
    expect(
      fs.readFileSync(path.join(manager.runDirectory(result.id)!, "startup-attempts"), "utf8"),
    ).toBe("2");
  });

  it("does not retry deterministic failures before the first turn", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker-startup-retry.mjs"),
      runRoot: root,
    });
    managers.push(manager);

    const result = await manager.run({ task: "Reject startup", transport: "process" });

    expect(result.status).toBe("failed");
    expect(result.error).toBe("provider rejected the prompt");
    expect(
      fs.readFileSync(path.join(manager.runDirectory(result.id)!, "startup-attempts"), "utf8"),
    ).toBe("1");
  });

  it("keeps full results in the API and compact projections for the dashboard", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
      fullCodeMode: false,
    });
    managers.push(manager);
    const result = await manager.run({ task: "LARGE_RESULT", transport: "process" });
    expect(result.text).toHaveLength(100_000);
    expect((result.value as { output: string }).output).toHaveLength(100_000);

    const records = manager.listForUi();
    const compact = records[0] as AgentRunRecord;
    expect(compact.text.length).toBeLessThanOrEqual(16_001);
    expect(compact.value).toMatchObject({ fabricTruncated: true });
    expect(manager.listForUi()).toBe(records);
    expect((manager.status(result.id) as AgentRunRecord).text).toHaveLength(100_000);
    expect((await manager.wait(result.id)).text).toHaveLength(100_000);
  });

  it("readLog returns the run's event stream and status", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
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

  it("derives trusted log paths and recursively discovers bounded nested runs", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
    });
    managers.push(manager);
    const result = await manager.run({ task: "Inspect nesting", transport: "process" });
    const runDirectory = manager.runDirectory(result.id)!;
    const topStatus = JSON.parse(fs.readFileSync(path.join(runDirectory, "status.json"), "utf8"));
    fs.writeFileSync(
      path.join(runDirectory, "status.json"),
      JSON.stringify({ ...topStatus, logFile: "/tmp/untrusted-top.jsonl" }),
    );
    const childDirectory = path.join(runDirectory, "nested", "child");
    const grandchildDirectory = path.join(childDirectory, "nested", "grandchild");
    fs.mkdirSync(grandchildDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(childDirectory, "status.json"),
      JSON.stringify({ ...result, id: "child", name: "child", logFile: "/tmp/untrusted-child.jsonl" }),
    );
    fs.writeFileSync(
      path.join(grandchildDirectory, "status.json"),
      JSON.stringify({ ...result, id: "grandchild", name: "grandchild", logFile: "/tmp/untrusted-grandchild.jsonl" }),
    );

    const status = manager.status(result.id) as AgentRunRecord;
    expect(status.logFile).toBe(path.join(runDirectory, "events.jsonl"));
    expect(status.nestedAgents?.[0]?.logFile).toBe(path.join(childDirectory, "events.jsonl"));
    expect(status.nestedAgents?.[0]?.nestedAgents?.[0]?.logFile).toBe(
      path.join(grandchildDirectory, "events.jsonl"),
    );

    status.nestedAgents![0]!.name = "caller mutation";
    fs.rmSync(path.join(runDirectory, "nested"), { recursive: true, force: true });
    const retained = manager.status(result.id) as AgentRunRecord;
    expect(retained.nestedAgents?.[0]?.name).toBe("child");
    expect(retained.nestedAgents?.[0]?.nestedAgents?.[0]?.name).toBe("grandchild");
  });

  it("captures recursive leaves before the child process removes their directories", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
    });
    managers.push(manager);
    const handle = await manager.spawn({
      task: "HANG while nested agents finish",
      transport: "process",
      recursive: true,
    });
    const runDirectory = manager.runDirectory(handle.id)!;
    const statusFile = path.join(runDirectory, "status.json");
    const deadline = Date.now() + 2_000;
    while (!fs.existsSync(statusFile) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const parentStatus = JSON.parse(fs.readFileSync(statusFile, "utf8"));
    const leafDirectory = path.join(runDirectory, "nested", "finished-leaf");
    fs.mkdirSync(leafDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(leafDirectory, "status.json"),
      JSON.stringify({
        ...parentStatus,
        id: "finished-leaf",
        name: "finished leaf",
        status: "completed",
        finishedAt: Date.now(),
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 250));
    fs.rmSync(path.join(runDirectory, "nested"), { recursive: true, force: true });
    const retained = manager.status(handle.id) as AgentRunRecord;
    expect(retained.nestedAgents?.[0]).toMatchObject({
      id: "finished-leaf",
      name: "finished leaf",
      status: "completed",
    });
    await manager.stop(handle.id);
  });

  it("keeps direct tools native for ordinary children and full code mode for recursion", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
      fullCodeMode: true,
      mainAgentId: "session:root-main",
    });
    managers.push(manager);
    type ObservedResult = AgentRunResult & {
      fullCodeMode?: string;
      tools?: string[];
      extensions?: string;
      mainAgentId?: string;
    };

    const direct = (await manager.run({
      task: "Use native tools",
      transport: "process",
      tools: ["read", "grep"],
    })) as ObservedResult;
    expect(direct.fullCodeMode).toBe("false");
    expect(direct.tools).toEqual(["read", "grep"]);
    expect(direct.extensions).toBe("true");
    expect(direct.mainAgentId).toBe("session:root-main");

    const recursive = (await manager.run({
      task: "Delegate recursively",
      transport: "process",
      tools: ["read"],
      recursive: true,
    })) as ObservedResult;
    expect(recursive.fullCodeMode).toBe("true");
    expect(recursive.tools).toEqual(["read", "fabric_exec"]);
    expect(recursive.mainAgentId).toBe("session:root-main");
  });

  it("validates structured output through the real Fabric worker", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const fakePi = path.resolve("tests/fixtures/fake-pi-rpc.mjs");
    fs.chmodSync(fakePi, 0o755);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
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

  it("propagates the exact root Main identity into recursive child Pi", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const fakePi = path.resolve("tests/fixtures/fake-pi-rpc.mjs");
    fs.chmodSync(fakePi, 0o755);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("src/worker.ts"),
      piBinary: fakePi,
      runRoot: root,
      fullCodeMode: true,
      mainAgentId: "session:root-main",
    });
    managers.push(manager);

    const result = await manager.run({
      task: "REPORT_FABRIC_IDENTITY",
      name: "recursive implementor",
      transport: "process",
      recursive: true,
      timeoutMs: 5_000,
    });

    expect(result.status).toBe("completed");
    expect(JSON.parse(result.text)).toEqual({
      mainAgentId: "session:root-main",
      parentRun: result.id,
      agentName: "recursive implementor",
    });
  });

  it("keeps the RPC worker alive when Pi announces a retry", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const fakePi = path.resolve("tests/fixtures/fake-pi-rpc.mjs");
    fs.chmodSync(fakePi, 0o755);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
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
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
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
    const config = { ...DEFAULT_FABRIC_CONFIG.agents, model: "claude-sonnet-4-5" };
    const manager = new AgentManager(process.cwd(), config, {
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
    const config = { ...DEFAULT_FABRIC_CONFIG.agents, model: "claude-sonnet-4-5" };
    const manager = new AgentManager(process.cwd(), config, {
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
    const config = { ...DEFAULT_FABRIC_CONFIG.agents, thinking: "high" as const };
    const manager = new AgentManager(process.cwd(), config, {
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
    const config = { ...DEFAULT_FABRIC_CONFIG.agents, thinking: "high" as const };
    const manager = new AgentManager(process.cwd(), config, {
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
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
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
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
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
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
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
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker-crash.mjs"),
      runRoot: root,
    });
    managers.push(manager);
    const result = await manager.run({ task: "crash test", transport: "process" });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("exited without a result");
    expect(result.error).toContain("model rate limit exceeded");
    expect(result.error).toContain("worker_stderr: provider authentication failed retry required");
  });

  it("rejects empty tasks", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
    });
    managers.push(manager);
    await expect(manager.spawn({ task: "" })).rejects.toThrow("must not be empty");
  });

  it("enforces a cross-process cost budget across spawned agents", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-budget-"));
    roots.push(root);
    const config = { ...DEFAULT_FABRIC_CONFIG.agents, budgetUsd: 0.1 };
    const manager = new AgentManager(process.cwd(), config, {
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
      const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
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

  it("terminates a child that exceeds the per-child token limit", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-tokens-"));
    roots.push(root);
    const fakePi = path.resolve("tests/fixtures/fake-pi-rpc.mjs");
    fs.chmodSync(fakePi, 0o755);
    // The fake pi emits one assistant turn with 7 tokens (input 3 + output 4);
    // a 5-token ceiling trips the guard after the first message_end.
    const config = { ...DEFAULT_FABRIC_CONFIG.agents, maxTokensPerChild: 5 };
    const manager = new AgentManager(process.cwd(), config, {
      workerPath: path.resolve("src/worker.ts"),
      piBinary: fakePi,
      runRoot: root,
      fullCodeMode: false,
    });
    managers.push(manager);
    const result = await manager.run({
      task: "burn tokens",
      transport: "process",
      timeoutMs: 5_000,
    });
    expect(result.status).toBe("timed_out");
    expect(result.error ?? "").toMatch(/token limit/i);
    expect(result.error ?? "").toMatch(/7 tokens/);
  });
});

describe("AgentManager multimodal prompts", () => {
  it("forwards image blocks to the Pi worker RPC prompt", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-images-"));
    roots.push(root);
    const promptLog = path.join(root, "prompt.json");
    process.env.FAKE_PI_BEHAVIOR = "capture-prompt";
    process.env.FAKE_PI_PROMPT_LOG = promptLog;
    try {
      const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
        workerPath: path.resolve("src/worker.ts"),
        piBinary: path.resolve("tests/fixtures/fake-pi.mjs"),
        runRoot: path.join(root, "runs"),
      });
      managers.push(manager);
      const result = await manager.run({
        task: "Inspect the attached image",
        transport: "process",
        images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
      });

      expect(result.status).toBe("completed");
      const frame = JSON.parse(fs.readFileSync(promptLog, "utf8")) as Record<string, unknown>;
      expect(frame).toEqual({
        type: "prompt",
        message: "Inspect the attached image",
        images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
      });
      expect(fs.existsSync(path.join(manager.runDirectory(result.id)!, "images.json"))).toBe(false);
    } finally {
      delete process.env.FAKE_PI_BEHAVIOR;
      delete process.env.FAKE_PI_PROMPT_LOG;
    }
  });
});

describe("AgentManager Claude runner", () => {
  const fakeClaude = path.resolve("tests/fixtures/fake-claude.mjs");

  it("uses the independent configured Claude runner and model defaults", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-claude-"));
    roots.push(root);
    const config = {
      ...DEFAULT_FABRIC_CONFIG.agents,
      runner: "claude" as const,
      model: "openai/pi-only",
      claude: { ...DEFAULT_FABRIC_CONFIG.agents.claude, model: "claude/haiku" },
    };
    const manager = new AgentManager(process.cwd(), config, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
    });
    managers.push(manager);

    const result = await manager.run({ task: "Use Claude defaults", transport: "process" });
    expect(result).toMatchObject({
      status: "completed",
      runner: "claude",
      model: "claude/haiku",
    });
  });

  it("runs Claude stream-json with mapped tools, native schema output, and usage", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-claude-"));
    roots.push(root);
    const invocationLog = path.join(root, "claude-args.jsonl");
    process.env.FAKE_CLAUDE_LOG = invocationLog;
    try {
      const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
        workerPath: path.resolve("src/worker.ts"),
        claudeBinary: fakeClaude,
        runRoot: root,
      });
      managers.push(manager);
      const result = await manager.run({
        task: "Return structured output",
        runner: "claude",
        transport: "process",
        model: "claude/haiku",
        thinking: "minimal",
        tools: ["read", "grep", "find", "ls"],
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        },
      });

      expect(result).toMatchObject({
        status: "completed",
        runner: "claude",
        model: "claude/haiku",
        thinking: "minimal",
        turns: 2,
        toolCalls: 1,
        value: { ok: true },
        runnerSessionId: "11111111-1111-4111-8111-111111111111",
        usage: { input: 10, output: 7, cacheRead: 2, cacheWrite: 3, cost: 0.001 },
      });
      const invocation = JSON.parse(fs.readFileSync(invocationLog, "utf8").trim()) as {
        argv: string[];
      };
      expect(invocation.argv).toEqual(
        expect.arrayContaining([
          "--model",
          "haiku",
          "--effort",
          "low",
          "--tools",
          "Read,Grep,Glob",
          "--allowedTools",
          "Read,Grep,Glob",
          "--no-session-persistence",
        ]),
      );
      expect(invocation.argv).not.toContain("fabric_exec");
    } finally {
      delete process.env.FAKE_CLAUDE_LOG;
    }
  });

  it("preserves Claude result diagnostics on a failed run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-claude-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("src/worker.ts"),
      claudeBinary: fakeClaude,
      runRoot: root,
    });
    managers.push(manager);

    const result = await manager.run({
      task: "CLAUDE_FAIL",
      runner: "claude",
      transport: "process",
      tools: ["read"],
    });
    expect(result).toMatchObject({
      status: "failed",
      runner: "claude",
      error: "fake Claude failure",
      exitCode: 0,
    });
  });

  it("delivers Claude steering and follow-up messages on later turns", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-claude-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("src/worker.ts"),
      claudeBinary: fakeClaude,
      runRoot: root,
    });
    managers.push(manager);

    const handle = await manager.spawn({
      task: "Initial Claude task",
      runner: "claude",
      transport: "process",
      tools: ["read"],
    });
    manager.steer(handle.id, "Redirect the active analysis");
    manager.followUp(handle.id, "Check one final detail");
    const result = await manager.wait(handle.id);

    expect(result).toMatchObject({
      status: "completed",
      runner: "claude",
      turns: 6,
      toolCalls: 3,
      usage: { input: 30, output: 21, cacheRead: 6, cacheWrite: 9, cost: 0.003 },
      pendingMessages: { steering: [], followUp: [] },
    });
  });

  it("enumerates models from the Claude runtime control handshake", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-claude-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      claudeBinary: fakeClaude,
      runRoot: root,
    });
    managers.push(manager);

    const models = await manager.claudeModels();
    expect(models.map((model) => model.value)).toEqual(["default", "haiku"]);
    expect(models[1]).toMatchObject({
      value: "haiku",
      resolvedModel: "claude-haiku-test",
      displayName: "Haiku (test)",
    });
  });

  it("rejects recursive Fabric and unsupported tools before launching Claude", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-claude-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      claudeBinary: fakeClaude,
      runRoot: root,
    });
    managers.push(manager);

    await expect(
      manager.run({ task: "recurse", runner: "claude", recursive: true }),
    ).rejects.toThrow(/does not support recursive Fabric/);
    await expect(
      manager.run({ task: "unknown tool", runner: "claude", tools: ["custom"] }),
    ).rejects.toThrow(/does not support Fabric tool/);
    await expect(
      manager.run({ task: "prototype tool", runner: "claude", tools: ["__proto__"] }),
    ).rejects.toThrow(/does not support Fabric tool/);
    await expect(
      manager.run({ task: "blank model", runner: "claude", model: "claude/" }),
    ).rejects.toThrow(/must include a runtime model value/);
  });
});

describe("AgentManager steering", () => {
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
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath,
      ...(piBinary ? { piBinary } : {}),
      runRoot: root,
      fullCodeMode: false,
    });
    managers.push(manager);
    return manager;
  };

  it("steer appends a queued steer command for a running agent", async () => {
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

  it("steer throws for a finished agent", async () => {
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
      const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
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
        const status = manager.status(handle.id) as AgentRunRecord;
        return Boolean(status.pendingMessages?.steering.includes("redirect to session expiry"));
      }, 3_000);
      await manager.stop(handle.id);
    } finally {
      delete process.env.FAKE_PI_STEER_LOG;
    }
  });

  it("preserves a partial UTF-8 steering record across worker polls", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-steer-"));
    roots.push(root);
    fs.chmodSync(fakePiSteer, 0o755);
    const received = path.join(root, "received.jsonl");
    process.env.FAKE_PI_STEER_LOG = received;
    try {
      const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
        workerPath: path.resolve("src/worker.ts"),
        piBinary: fakePiSteer,
        runRoot: root,
      });
      managers.push(manager);
      const handle = await manager.spawn({ task: "STEER_ME", transport: "process" });
      await waitFor(() => manager.status(handle.id).status === "running");
      const steerFile = path.join(manager.runDirectory(handle.id)!, "steer.jsonl");
      const line = Buffer.from(`${JSON.stringify({ type: "steer", message: "转向界面 🚀" })}\n`);
      const split = line.indexOf(Buffer.from("界")) + 1;
      fs.appendFileSync(steerFile, line.subarray(0, split));
      await new Promise((resolve) => setTimeout(resolve, 300));
      fs.appendFileSync(steerFile, line.subarray(split));
      await waitFor(
        () => fs.existsSync(received) && fs.readFileSync(received, "utf8").includes("转向界面 🚀"),
        3_000,
      );
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
      const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
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

  it("compact appends a compact entry to the steer channel for a running pi child", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-compact-"));
    roots.push(root);
    const manager = hangManager(root);
    const handle = await manager.spawn({ task: "HANG", transport: "process" });
    const result = manager.compact(handle.id, "Keep the file map");
    expect(result).toEqual({ queued: true, messageId: expect.any(String) });
    const entries = readSteerFile(manager.runDirectory(handle.id)!);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "compact", instructions: "Keep the file map" });
    await manager.stop(handle.id);
  });

  it("compact appends a compact entry without instructions when omitted", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-compact-"));
    roots.push(root);
    const manager = hangManager(root);
    const handle = await manager.spawn({ task: "HANG", transport: "process" });
    manager.compact(handle.id);
    const entries = readSteerFile(manager.runDirectory(handle.id)!);
    expect(entries[0]).toMatchObject({ type: "compact" });
    expect(entries[0]).not.toHaveProperty("instructions");
    await manager.stop(handle.id);
  });

  it("compact throws for a finished agent", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-compact-"));
    roots.push(root);
    const manager = hangManager(root);
    const result = await manager.run({ task: "done", transport: "process" });
    expect(() => manager.compact(result.id)).toThrow(/already finished/);
  });

  it("compact rejects claude-runner children with a clear error", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-compact-"));
    roots.push(root);
    const fakeClaude = path.resolve("tests/fixtures/fake-claude.mjs");
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("src/worker.ts"),
      claudeBinary: fakeClaude,
      runRoot: root,
    });
    managers.push(manager);
    const handle = await manager.spawn({
      task: "Initial Claude task",
      runner: "claude",
      transport: "process",
      tools: ["read"],
    });
    expect(() => manager.compact(handle.id)).toThrow(/only supported for Pi-runner children/);
    await manager.stop(handle.id);
  });

  it("forwards a correlated compact frame only after child agent_settled", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-compact-"));
    roots.push(root);
    fs.chmodSync(fakePiSteer, 0o755);
    const received = path.join(root, "received.jsonl");
    process.env.FAKE_PI_STEER_LOG = received;
    try {
      const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
        workerPath: path.resolve("src/worker.ts"),
        piBinary: fakePiSteer,
        runRoot: root,
        fullCodeMode: false,
      });
      managers.push(manager);
      const handle = await manager.spawn({ task: "STEER_ME", transport: "process" });
      await waitFor(() => manager.status(handle.id).status === "running");
      manager.compact(handle.id, "Preserve the test plan");
      await waitFor(
        () => fs.existsSync(received) && fs.readFileSync(received, "utf8").includes("compact"),
        3_000,
      );
      const forwarded = fs
        .readFileSync(received, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(
        forwarded.some(
          (e) =>
            e.type === "compact" &&
            typeof e.id === "string" &&
            e.customInstructions === "Preserve the test plan",
        ),
      ).toBe(true);
      const result = await manager.wait(handle.id);
      expect(result.status).toBe("completed");
      expect(result.compaction?.status).toBe("completed");
    } finally {
      delete process.env.FAKE_PI_STEER_LOG;
    }
  });
});
