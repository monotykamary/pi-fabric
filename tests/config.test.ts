import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_FABRIC_CONFIG,
  effectiveToolCaptureConfig,
  loadFabricConfig,
  normalizeFabricConfig,
} from "../src/config.js";

const temporaryDirectories: string[] = [];

const temporaryDirectory = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-config-"));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Fabric configuration", () => {
  it("normalizes bounds and approval modes", () => {
    const config = normalizeFabricConfig({
      fullCodeMode: false,
      executor: { timeoutMs: 1, memoryLimitBytes: Number.MAX_SAFE_INTEGER },
      approvals: { write: "allow", agent: "invalid" },
      subagents: { maxConcurrent: 100, maxPerExecution: 5_000, transport: "localterm" },
      capture: {
        keepVisible: ["fabric_exec", "custom", "custom"],
        defaultRisk: "invalid",
        risks: { inspect: "read", mutate: "invalid" },
      },
      ui: {
        widget: "always",
        placement: "aboveEditor",
        maxRows: 100,
        refreshMs: 1,
        lingerMs: 5_000_000,
        eventHistory: 0,
      },
      mesh: { actorQueueLimit: 0, eventContextChars: 5_000_000 },
    });
    expect(config.fullCodeMode).toBe(false);
    expect(config.executor.timeoutMs).toBe(1_000);
    expect(config.executor.memoryLimitBytes).toBe(1024 * 1024 * 1024);
    expect(config.approvals.write).toBe("allow");
    expect(config.approvals.agent).toBe("ask");
    expect(config.subagents.maxConcurrent).toBe(32);
    expect(config.subagents.maxPerExecution).toBe(1_000);
    expect(config.subagents.transport).toBe("localterm");
    expect(config.capture.keepVisible).toEqual(["fabric_exec", "custom"]);
    expect(config.capture.defaultRisk).toBe("execute");
    expect(config.capture.risks).toMatchObject({ inspect: "read", mutate: "execute" });
    expect(config.ui).toMatchObject({
      widget: "always",
      placement: "aboveEditor",
      maxRows: 20,
      refreshMs: 100,
      lingerMs: 300_000,
      eventHistory: 1,
    });
    expect(config.mesh.actorQueueLimit).toBe(1);
    expect(config.mesh.eventContextChars).toBe(1_000_000);
  });

  it("preserves native tool registration in orchestration-only mode", () => {
    const capture = effectiveToolCaptureConfig({
      fullCodeMode: false,
      capture: DEFAULT_FABRIC_CONFIG.capture,
    });
    expect(capture).toMatchObject({ enabled: false, hideFromModel: false });
    expect(DEFAULT_FABRIC_CONFIG.capture).toMatchObject({ enabled: true, hideFromModel: true });
  });

  it("merges global and trusted project configuration", () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "fabric.json"),
      JSON.stringify({ approvals: { network: "allow" }, subagents: { maxConcurrent: 2 } }),
    );
    fs.writeFileSync(
      path.join(cwd, ".pi", "fabric.json"),
      JSON.stringify({ subagents: { transport: "localterm" } }),
    );
    const config = loadFabricConfig({ cwd, agentDir, projectTrusted: true });
    expect(config.approvals.network).toBe("allow");
    expect(config.subagents.maxConcurrent).toBe(2);
    expect(config.subagents.transport).toBe("localterm");
  });

  it("ignores project configuration when the project is untrusted", () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".pi", "fabric.json"),
      JSON.stringify({ approvals: { execute: "allow" } }),
    );
    const config = loadFabricConfig({ cwd, agentDir, projectTrusted: false });
    expect(config.approvals.execute).toBe("ask");
  });
});
