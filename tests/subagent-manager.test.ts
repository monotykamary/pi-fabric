import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { SubagentManager } from "../src/subagents/manager.js";
import type { SubagentRunResult } from "../src/subagents/types.js";

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
});
