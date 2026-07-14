import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SubagentRunResult } from "../src/subagents/types.js";
import { SubagentManager } from "../src/subagents/manager.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";

// End-to-end coverage for the REAL worker (dist/worker.js) driven through
// SubagentManager + #monitor, with a stub `pi` binary (tests/fixtures/fake-pi.mjs)
// whose behavior is selected by FAKE_PI_BEHAVIOR. This is the only place the
// real worker.ts spawn/exit path is exercised; the other suites use a fake
// worker that writes status directly. Skips when the package is not built.
const workerPath = path.resolve("dist/worker.js");
const piBinary = path.resolve("tests/fixtures/fake-pi.mjs");
const hasWorker = fs.existsSync(workerPath);

describe.skipIf(!hasWorker)("SubagentManager real worker e2e", () => {
  const roots: string[] = [];
  const managers: SubagentManager[] = [];

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((m) => m.close()));
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  const run = async (task = "do it"): Promise<SubagentRunResult> => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-e2e-"));
    roots.push(root);
    const config = { ...DEFAULT_FABRIC_CONFIG.subagents, timeoutMs: 2000, maxConcurrent: 1 };
    const manager = new SubagentManager(process.cwd(), config, {
      workerPath,
      piBinary,
      runRoot: root,
    });
    managers.push(manager);
    return manager.run({ task, transport: "process" });
  };

  const cases: Array<{ behavior: string; check: (r: SubagentRunResult) => void }> = [
    {
      behavior: "success",
      check: (r) => {
        expect(r.status).toBe("completed");
        expect(r.text).toContain("hi");
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

  it("aborts a hanging run as stopped, not exited-without-a-result", async () => {
    process.env.FAKE_PI_BEHAVIOR = "hang";
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-e2e-"));
    roots.push(root);
    const config = { ...DEFAULT_FABRIC_CONFIG.subagents, timeoutMs: 30_000, maxConcurrent: 1 };
    const manager = new SubagentManager(process.cwd(), config, {
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
