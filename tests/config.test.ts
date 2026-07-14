import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_FABRIC_CONFIG,
  effectiveToolCaptureConfig,
  loadFabricConfig,
  normalizeFabricConfig,
  saveFabricConfig,
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
        maxRows: 100,
        refreshMs: 1,
        eventHistory: 0,
      },
      mesh: { actorQueueLimit: 0, eventContextChars: 5_000_000 },
    });
    expect(config.fullCodeMode).toBe(false);
    expect(config.executor.timeoutMs).toBe(1_000);
    expect(config.executor.memoryLimitBytes).toBe(1024 * 1024 * 1024);
    expect(config.approvals.write).toBe("allow");
    expect(config.approvals.agent).toBe("allow");
    expect(config.subagents.maxConcurrent).toBe(32);
    expect(config.subagents.maxPerExecution).toBe(1_000);
    expect(config.subagents.transport).toBe("localterm");
    expect(config.capture.keepVisible).toEqual(["fabric_exec", "custom"]);
    expect(config.capture.defaultRisk).toBe("execute");
    expect(config.capture.risks).toMatchObject({ inspect: "read", mutate: "execute" });
    expect(config.ui).toMatchObject({
      widget: "always",
      maxRows: 20,
      refreshMs: 100,
      eventHistory: 1,
    });
    expect(config.mesh.actorQueueLimit).toBe(1);
    expect(config.mesh.eventContextChars).toBe(1_000_000);
  });

  it("normalizes the subagent cost budget", () => {
    const enabled = normalizeFabricConfig({ subagents: { budgetUsd: 0.42 } });
    expect(enabled.subagents.budgetUsd).toBe(0.42);
    const negative = normalizeFabricConfig({ subagents: { budgetUsd: -5 } });
    expect(negative.subagents.budgetUsd).toBe(0);
    const huge = normalizeFabricConfig({ subagents: { budgetUsd: Number.MAX_VALUE } });
    expect(huge.subagents.budgetUsd).toBe(1_000_000);
    expect(DEFAULT_FABRIC_CONFIG.subagents.budgetUsd).toBe(0);
  });

  it("normalizes the subagent default model and drops empty values", () => {
    expect(DEFAULT_FABRIC_CONFIG.subagents.model).toBeUndefined();
    const set = normalizeFabricConfig({ subagents: { model: "claude-sonnet-4-5" } });
    expect(set.subagents.model).toBe("claude-sonnet-4-5");
    const blank = normalizeFabricConfig({ subagents: { model: "  " } });
    expect(blank.subagents.model).toBeUndefined();
    const nonString = normalizeFabricConfig({ subagents: { model: 42 } });
    expect(nonString.subagents.model).toBeUndefined();
  });

  it("normalizes the ESC halt toggle for actors", () => {
    expect(DEFAULT_FABRIC_CONFIG.ui.haltOnEscape).toBe(true);
    const disabled = normalizeFabricConfig({ ui: { haltOnEscape: false } });
    expect(disabled.ui.haltOnEscape).toBe(false);
    const invalid = normalizeFabricConfig({ ui: { haltOnEscape: "off" } });
    expect(invalid.ui.haltOnEscape).toBe(true);
  });

  it("preserves native tool registration in orchestration-only mode", () => {
    const capture = effectiveToolCaptureConfig({
      fullCodeMode: false,
      capture: DEFAULT_FABRIC_CONFIG.capture,
    });
    expect(capture).toMatchObject({ enabled: false, hideFromModel: false });
    expect(DEFAULT_FABRIC_CONFIG.capture).toMatchObject({ enabled: true, hideFromModel: true });
  });

  it("never leaves Pi core tools model-visible in full code mode", () => {
    expect(DEFAULT_FABRIC_CONFIG.capture.keepVisible).toEqual(["fabric_exec"]);
    const capture = effectiveToolCaptureConfig({
      fullCodeMode: true,
      capture: {
        ...DEFAULT_FABRIC_CONFIG.capture,
        keepVisible: ["fabric_exec", "read", "bash", "custom"],
      },
    });
    expect(capture.keepVisible).toEqual(["fabric_exec", "custom"]);
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
      JSON.stringify({ approvals: { execute: "deny" } }),
    );
    const config = loadFabricConfig({ cwd, agentDir, projectTrusted: false });
    expect(config.approvals.execute).toBe("allow");
  });

  it("saves partial overrides into the project fabric.json when trusted", () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".pi", "fabric.json"),
      JSON.stringify({ subagents: { transport: "localterm" } }),
    );

    const result = saveFabricConfig(
      { cwd, agentDir, projectTrusted: true },
      { subagents: { maxConcurrent: 8 }, fullCodeMode: false },
    );

    expect(result.scope).toBe("project");
    expect(result.path).toBe(path.join(cwd, ".pi", "fabric.json"));
    const saved = JSON.parse(fs.readFileSync(path.join(cwd, ".pi", "fabric.json"), "utf8"));
    expect(saved).toEqual({
      subagents: { transport: "localterm", maxConcurrent: 8 },
      fullCodeMode: false,
    });
    const config = loadFabricConfig({ cwd, agentDir, projectTrusted: true });
    expect(config.subagents.maxConcurrent).toBe(8);
    expect(config.subagents.transport).toBe("localterm");
    expect(config.fullCodeMode).toBe(false);
  });

  it("saves into the global fabric.json when the project is untrusted", () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    fs.mkdirSync(agentDir, { recursive: true });

    const result = saveFabricConfig(
      { cwd, agentDir, projectTrusted: false },
      { executor: { timeoutMs: 30_000 } },
    );

    expect(result.scope).toBe("global");
    expect(result.path).toBe(path.join(agentDir, "fabric.json"));
    expect(fs.existsSync(path.join(cwd, ".pi", "fabric.json"))).toBe(false);
    const saved = JSON.parse(fs.readFileSync(path.join(agentDir, "fabric.json"), "utf8"));
    expect(saved).toEqual({ executor: { timeoutMs: 30_000 } });
  });

  it("saves array overrides by replacing the array while preserving siblings", () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".pi", "fabric.json"),
      JSON.stringify({
        subagents: { transport: "tmux", defaultTools: ["read", "bash"] },
        capture: { defaultRisk: "read", keepVisible: ["fabric_exec"] },
      }),
    );

    saveFabricConfig(
      { cwd, agentDir, projectTrusted: true },
      {
        subagents: { defaultTools: ["read", "edit", "grep"] },
        capture: { keepVisible: ["fabric_exec", "custom-tool"] },
      },
    );

    const saved = JSON.parse(fs.readFileSync(path.join(cwd, ".pi", "fabric.json"), "utf8"));
    // Arrays are replaced, not concatenated; sibling object keys are preserved.
    expect(saved.subagents).toEqual({ transport: "tmux", defaultTools: ["read", "edit", "grep"] });
    expect(saved.capture).toEqual({
      defaultRisk: "read",
      keepVisible: ["fabric_exec", "custom-tool"],
    });
    const config = loadFabricConfig({ cwd, agentDir, projectTrusted: true });
    expect(config.subagents.defaultTools).toEqual(["read", "edit", "grep"]);
    expect(config.capture.keepVisible).toEqual(["fabric_exec", "custom-tool"]);
    expect(config.subagents.transport).toBe("tmux");
  });
});
