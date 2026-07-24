import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRunResult } from "../src/agents/types.js";
import { AgentManager } from "../src/agents/manager.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";

// End-to-end coverage for the REAL worker (dist/worker.js) driven through
// AgentManager + #monitor, with a stub `pi` binary (tests/fixtures/fake-pi.mjs)
// whose behavior is selected by FAKE_PI_BEHAVIOR. This is the only place the
// real worker.ts spawn/exit path is exercised; the other suites use a fake
// worker that writes status directly. Skips when the package is not built.
const workerPath = path.resolve("dist/worker.js");
const piBinary = path.resolve("tests/fixtures/fake-pi.mjs");
const hasWorker = fs.existsSync(workerPath);

describe.skipIf(!hasWorker)("AgentManager real worker e2e", () => {
  const roots: string[] = [];
  const managers: AgentManager[] = [];

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((m) => m.close()));
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  const run = async (task = "do it"): Promise<AgentRunResult> => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-e2e-"));
    roots.push(root);
    const config = { ...DEFAULT_FABRIC_CONFIG.agents, timeoutMs: 2000, maxConcurrent: 1 };
    const manager = new AgentManager(process.cwd(), config, {
      workerPath,
      piBinary,
      runRoot: root,
    });
    managers.push(manager);
    return manager.run({ task, transport: "process" });
  };

  const cases: Array<{ behavior: string; check: (r: AgentRunResult) => void }> = [
    {
      behavior: "success",
      check: (r) => {
        expect(r.status).toBe("completed");
        expect(r.text).toContain("hi");
      },
    },
    {
      behavior: "split-utf8",
      check: (r) => {
        expect(r.status).toBe("completed");
        expect(r.text).toBe("界面 🚀");
        expect(r.text).not.toContain("�");
      },
    },
    {
      behavior: "stderr-framing",
      check: (r) => {
        expect(r.status).toBe("completed");
        expect(r.text).toBe("trusted");
        const events = fs
          .readFileSync(r.logFile!, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(events.some((event) => event.type === "worker_stderr")).toBe(true);
        expect(
          events.some(
            (event) =>
              event.type === "message_end" &&
              (event.message as { content?: string } | undefined)?.content === "spoofed",
          ),
        ).toBe(false);
      },
    },
    {
      behavior: "exit-clean",
      check: (r) => {
        expect(r.status).toBe("completed");
      },
    },
    {
      behavior: "exit-error",
      check: (r) => {
        expect(r.status).toBe("failed");
        expect(r.error ?? "").toMatch(/Pi exited with code 1/);
      },
    },
    {
      behavior: "reject",
      check: (r) => {
        expect(r.status).toBe("failed");
        expect(r.error ?? "").toMatch(/provider rejected the prompt/);
      },
    },
    {
      behavior: "hang",
      check: (r) => {
        expect(r.status).toBe("timed_out");
        expect(r.error ?? "").toMatch(/timed out/);
      },
    },
    {
      behavior: "kill-worker",
      check: (r) => {
        // The worker was hard-killed mid-run: it died before writing a terminal
        // status, so #monitor records the generic failure (with the run-log tail
        // appended when the child logged anything before dying).
        expect(r.status).toBe("failed");
        expect(r.error ?? "").toMatch(/exited without a result/);
      },
    },
  ];

  it.each(cases)("maps child behavior $behavior to the correct run outcome", async ({ behavior, check }) => {
    process.env.FAKE_PI_BEHAVIOR = behavior;
    const result = await run();
    try {
      check(result);
    } catch (error) {
      throw new Error(
        `${behavior}: ${(error as Error).message} (status=${result.status} error=${result.error ?? ""})`,
      );
    }
  });

  it.each([
    { behavior: "compact-success", outcome: "completed", error: undefined },
    { behavior: "compact-failure", outcome: "failed", error: "child summary failed" },
  ])("queues mid-turn compaction and records $behavior after child settlement", async ({ behavior, outcome, error }) => {
    process.env.FAKE_PI_BEHAVIOR = behavior;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-e2e-"));
    roots.push(root);
    const config = { ...DEFAULT_FABRIC_CONFIG.agents, timeoutMs: 4_000, maxConcurrent: 1 };
    const manager = new AgentManager(process.cwd(), config, {
      workerPath,
      piBinary,
      runRoot: root,
    });
    managers.push(manager);
    const handle = await manager.spawn({ task: "compact it", transport: "process" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    manager.compact(handle.id, "first instructions");
    manager.compact(handle.id, "latest instructions");
    const result = await manager.wait(handle.id);

    expect(result.status).toBe("completed");
    expect(result.compaction).toMatchObject({
      status: outcome,
      coalescedRequests: 1,
      attempts: 1,
      ...(error ? { error } : {}),
    });
    const events = fs
      .readFileSync(result.logFile!, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const settledIndex = events.findIndex((event) => event.type === "agent_settled");
    const compactIndex = events.findIndex((event) => event.type === "fake_compact_received");
    expect(settledIndex).toBeGreaterThanOrEqual(0);
    expect(compactIndex).toBeGreaterThan(settledIndex);
    expect(events[compactIndex]).toMatchObject({
      afterSettled: true,
      customInstructions: "latest instructions",
    });
    expect(events.some((event) => event.type === "abort")).toBe(false);
  });

  it("aborts a hanging run as stopped, not exited-without-a-result", async () => {
    process.env.FAKE_PI_BEHAVIOR = "hang";
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-e2e-"));
    roots.push(root);
    const config = { ...DEFAULT_FABRIC_CONFIG.agents, timeoutMs: 30_000, maxConcurrent: 1 };
    const manager = new AgentManager(process.cwd(), config, {
      workerPath,
      piBinary,
      runRoot: root,
    });
    managers.push(manager);
    const ac = new AbortController();
    const handle = await manager.spawn({ task: "hang", transport: "process" }, ac.signal);
    await new Promise((resolve) => setTimeout(resolve, 200));
    ac.abort();
    const result = await manager.wait(handle.id);
    expect(result.status).toBe("stopped");
  });

  it("reports a terminal failure (not exited-without-a-result) when the worker crashes mid-stream", async () => {
    process.env.FAKE_PI_BEHAVIOR = "success";
    process.env.PI_FABRIC_INJECT_CRASH = "stream";
    try {
      const result = await run();
      expect(result.status).toBe("failed");
      expect(result.error ?? "").toMatch(/simulated stream crash/);
    } finally {
      delete process.env.PI_FABRIC_INJECT_CRASH;
    }
  });

  it("reports a terminal failure when the worker crashes while finalizing", async () => {
    process.env.FAKE_PI_BEHAVIOR = "success";
    process.env.PI_FABRIC_INJECT_CRASH = "close";
    try {
      const result = await run();
      expect(result.status).toBe("failed");
      expect(result.error ?? "").toMatch(/simulated close crash/);
    } finally {
      delete process.env.PI_FABRIC_INJECT_CRASH;
    }
  });
});
