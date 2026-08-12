import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_FABRIC_CONFIG,
  MAX_EXECUTOR_MEMORY_LIMIT_BYTES,
  QUICKJS_MAX_MEMORY_LIMIT_BYTES,
  effectiveToolCaptureConfig,
  loadFabricConfig,
  loadFabricConfigForScope,
  normalizeFabricConfig,
  saveFabricConfig,
} from "../src/config.js";

const temporaryDirectories: string[] = [];
const originalCompactionEngineEnv = process.env.PI_FABRIC_COMPACTION_ENGINE;

const temporaryDirectory = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-config-"));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  if (originalCompactionEngineEnv === undefined) {
    delete process.env.PI_FABRIC_COMPACTION_ENGINE;
  } else {
    process.env.PI_FABRIC_COMPACTION_ENGINE = originalCompactionEngineEnv;
  }
});

describe("Fabric configuration", () => {
  it("keeps model-visible execution output at Pi read parity by default", () => {
    expect(DEFAULT_FABRIC_CONFIG.executor.maxOutputChars).toBe(50_000);
  });

  it("normalizes bounds and approval modes", () => {
    const config = normalizeFabricConfig({
      fullCodeMode: false,
      executor: { timeoutMs: 1, memoryLimitBytes: Number.MAX_SAFE_INTEGER },
      approvals: { write: "auto", agent: "invalid", model: "anthropic/classifier" },
      agents: { maxConcurrent: 100, maxPerExecution: 5_000, transport: "herdr" },
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
    expect(config.executor.memoryLimitBytes).toBe(
      Math.min(QUICKJS_MAX_MEMORY_LIMIT_BYTES, MAX_EXECUTOR_MEMORY_LIMIT_BYTES),
    );
    expect(config.approvals.write).toBe("auto");
    expect(config.approvals.agent).toBe("allow");
    expect(config.approvals.model).toBe("anthropic/classifier");
    expect(config.agents.maxConcurrent).toBe(32);
    expect(config.agents.maxPerExecution).toBe(1_000);
    expect(config.agents.transport).toBe("herdr");
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

  it("parses capability advisory settings with defaults and bounds", () => {
    expect(DEFAULT_FABRIC_CONFIG.capture.advisory).toEqual({
      mode: "enabled",
      threshold: 0.9,
      maxPerSession: 3,
      budget: 512,
    });
    const adorned = normalizeFabricConfig({
      capture: { advisory: { mode: "enabled", threshold: 4.2, maxPerSession: 9, budget: 2048 } },
    });
    expect(adorned.capture.advisory).toEqual({ mode: "enabled", threshold: 4.2, maxPerSession: 9, budget: 2048 });
    const bounded = normalizeFabricConfig({
      capture: {
        advisory: { mode: "surprising", threshold: Number.NaN, maxPerSession: 500, budget: 99_999 },
      },
    });
    expect(bounded.capture.advisory.mode).toBe("enabled");
    expect(bounded.capture.advisory.threshold).toBe(0.9);
    expect(bounded.capture.advisory.maxPerSession).toBe(50);
    expect(bounded.capture.advisory.budget).toBe(8192);
  });

  it("normalizes executor runtimes and their memory ceilings", () => {
    const native = normalizeFabricConfig({
      executor: { runtime: "node-process", memoryLimitBytes: Number.MAX_SAFE_INTEGER },
    });
    expect(native.executor.runtime).toBe("node-process");
    expect(native.executor.memoryLimitBytes).toBe(MAX_EXECUTOR_MEMORY_LIMIT_BYTES);

    const invalid = normalizeFabricConfig({ executor: { runtime: "repl" } });
    expect(invalid.executor.runtime).toBe("quickjs");
  });

  it("normalizes a dedicated prewalk executor model", () => {
    expect(
      normalizeFabricConfig({ prewalk: { model: "anthropic/executor" } }).prewalk,
    ).toEqual({
      mode: "in-place",
      model: "anthropic/executor",
      alwaysRearm: false,
      compactOnReturn: true,
    });
    expect(normalizeFabricConfig({ prewalk: { model: "   " } }).prewalk).toEqual({
      mode: "in-place",
      alwaysRearm: false,
      compactOnReturn: true,
    });
    expect(normalizeFabricConfig({ prewalk: { alwaysRearm: true } }).prewalk).toEqual({
      mode: "in-place",
      alwaysRearm: true,
      compactOnReturn: true,
    });
    expect(normalizeFabricConfig({ prewalk: { mode: "trajectory" } }).prewalk.mode).toBe(
      "trajectory",
    );
    expect(normalizeFabricConfig({ prewalk: { mode: "child" } }).prewalk.mode).toBe(
      "in-place",
    );
  });

  it("keeps a valid prewalk thinking level and drops invalid or empty ones", () => {
    expect(normalizeFabricConfig({ prewalk: { thinking: "high" } }).prewalk.thinking).toBe(
      "high",
    );
    expect(normalizeFabricConfig({ prewalk: { thinking: "xhigh" } }).prewalk.thinking).toBe(
      "xhigh",
    );
    expect(
      normalizeFabricConfig({ prewalk: { thinking: "extreme" } }).prewalk.thinking,
    ).toBeUndefined();
    expect(
      normalizeFabricConfig({ prewalk: { thinking: "" } }).prewalk.thinking,
    ).toBeUndefined();
    expect(normalizeFabricConfig({}).prewalk.thinking).toBeUndefined();
  });

  it("forces QuickJS in Schema enforce mode", () => {
    const config = normalizeFabricConfig({
      executor: { runtime: "node-process", memoryLimitBytes: Number.MAX_SAFE_INTEGER },
      schema: { mode: "enforce" },
    });
    expect(config.executor.runtime).toBe("quickjs");
    expect(config.executor.memoryLimitBytes).toBe(
      Math.min(QUICKJS_MAX_MEMORY_LIMIT_BYTES, MAX_EXECUTOR_MEMORY_LIMIT_BYTES),
    );
  });

  it("normalizes the default result format", () => {
    expect(DEFAULT_FABRIC_CONFIG.executor.resultFormat).toBe("auto");
    expect(normalizeFabricConfig({ executor: { resultFormat: "yaml" } }).executor.resultFormat).toBe("yaml");
    expect(normalizeFabricConfig({ executor: { resultFormat: "json" } }).executor.resultFormat).toBe("json");
    expect(normalizeFabricConfig({ executor: { resultFormat: "invalid" } }).executor.resultFormat).toBe("auto");
  });

  it("normalizes the agent cost budget", () => {
    const enabled = normalizeFabricConfig({ agents: { budgetUsd: 0.42 } });
    expect(enabled.agents.budgetUsd).toBe(0.42);
    const negative = normalizeFabricConfig({ agents: { budgetUsd: -5 } });
    expect(negative.agents.budgetUsd).toBe(0);
    const huge = normalizeFabricConfig({ agents: { budgetUsd: Number.MAX_VALUE } });
    expect(huge.agents.budgetUsd).toBe(1_000_000);
    expect(DEFAULT_FABRIC_CONFIG.agents.budgetUsd).toBe(0);
  });

  it("normalizes the agent default model and drops empty values", () => {
    expect(DEFAULT_FABRIC_CONFIG.agents.model).toBeUndefined();
    const set = normalizeFabricConfig({ agents: { model: "claude-sonnet-4-5" } });
    expect(set.agents.model).toBe("claude-sonnet-4-5");
    const blank = normalizeFabricConfig({ agents: { model: "  " } });
    expect(blank.agents.model).toBeUndefined();
    const nonString = normalizeFabricConfig({ agents: { model: 42 } });
    expect(nonString.agents.model).toBeUndefined();
  });

  it("normalizes the default runner and independent Claude settings", () => {
    expect(DEFAULT_FABRIC_CONFIG.agents.runner).toBe("pi");
    expect(DEFAULT_FABRIC_CONFIG.agents.claude).toEqual({ binary: "claude" });
    const configured = normalizeFabricConfig({
      agents: {
        runner: "claude",
        claude: { binary: "/opt/claude", model: "claude/haiku" },
      },
    });
    expect(configured.agents.runner).toBe("claude");
    expect(configured.agents.claude).toEqual({
      binary: "/opt/claude",
      model: "claude/haiku",
    });
    const invalid = normalizeFabricConfig({
      agents: { runner: "other", claude: { binary: " ", model: " " } },
    });
    expect(invalid.agents.runner).toBe("pi");
    expect(invalid.agents.claude).toEqual({ binary: "claude" });
  });

  it("normalizes the Veda runner settings", () => {
    expect(DEFAULT_FABRIC_CONFIG.agents.veda).toEqual({
      binary: "veda",
      backend: "agy",
      persona: "navigator-chat",
    });
    const configured = normalizeFabricConfig({
      agents: {
        runner: "veda",
        veda: { binary: "/opt/veda", backend: "codex", model: "gpt-5.2", persona: "worker" },
      },
    });
    expect(configured.agents.runner).toBe("veda");
    expect(configured.agents.veda).toEqual({
      binary: "/opt/veda",
      backend: "codex",
      model: "gpt-5.2",
      persona: "worker",
    });
    const partial = normalizeFabricConfig({ agents: { veda: { binary: " " } } });
    expect(partial.agents.veda.binary).toBe("veda");
    expect(partial.agents.veda.backend).toBe("agy");
    expect(partial.agents.veda.persona).toBe("navigator-chat");
    const customBackend = normalizeFabricConfig({ agents: { veda: { backend: "my-backend" } } });
    expect(customBackend.agents.veda.backend).toBe("my-backend");
    const backendModel = normalizeFabricConfig({ agents: { veda: { model: "opus" } } });
    expect(backendModel.agents.veda.model).toBe("opus");
    const blankBackend = normalizeFabricConfig({ agents: { veda: { backend: " " } } });
    expect(blankBackend.agents.veda.backend).toBe("agy");
    const invalidRunner = normalizeFabricConfig({ agents: { runner: "other" } });
    expect(invalidRunner.agents.runner).toBe("pi");
  });

  it("defaults the agent thinking level to medium and validates the value", () => {
    expect(DEFAULT_FABRIC_CONFIG.agents.thinking).toBe("medium");
    const set = normalizeFabricConfig({ agents: { thinking: "high" } });
    expect(set.agents.thinking).toBe("high");
    const invalid = normalizeFabricConfig({ agents: { thinking: "turbo" } });
    expect(invalid.agents.thinking).toBe("medium");
    const nonString = normalizeFabricConfig({ agents: { thinking: 42 } });
    expect(nonString.agents.thinking).toBe("medium");
  });

  it("defaults and validates temporal retention windows", () => {
    expect(DEFAULT_FABRIC_CONFIG.retention).toEqual({
      orphanedTempRunMs: 6 * 60 * 60 * 1_000,
      oneShotRunMs: 24 * 60 * 60 * 1_000,
      actorRunArchiveMs: 7 * 24 * 60 * 60 * 1_000,
    });
    expect(
      normalizeFabricConfig({
        retention: {
          orphanedTempRunMs: 2 * 60 * 60 * 1_000,
          oneShotRunMs: 2 * 24 * 60 * 60 * 1_000,
          actorRunArchiveMs: 30 * 24 * 60 * 60 * 1_000,
        },
      }).retention,
    ).toEqual({
      orphanedTempRunMs: 2 * 60 * 60 * 1_000,
      oneShotRunMs: 2 * 24 * 60 * 60 * 1_000,
      actorRunArchiveMs: 30 * 24 * 60 * 60 * 1_000,
    });
    expect(
      normalizeFabricConfig({ retention: { orphanedTempRunMs: 1 } }).retention.orphanedTempRunMs,
    ).toBe(60 * 60 * 1_000);
  });

  it("defaults actor scope to project and validates the value", () => {
    expect(DEFAULT_FABRIC_CONFIG.mesh.actorScope).toBe("project");
    const session = normalizeFabricConfig({ mesh: { actorScope: "session" } });
    expect(session.mesh.actorScope).toBe("session");
    const invalid = normalizeFabricConfig({ mesh: { actorScope: "untrusted" } });
    expect(invalid.mesh.actorScope).toBe("project");
    const nonString = normalizeFabricConfig({ mesh: { actorScope: 42 } });
    expect(nonString.mesh.actorScope).toBe("project");
  });

  it("normalizes the ESC halt toggle for actors", () => {
    expect(DEFAULT_FABRIC_CONFIG.ui.haltOnEscape).toBe(true);
    const disabled = normalizeFabricConfig({ ui: { haltOnEscape: false } });
    expect(disabled.ui.haltOnEscape).toBe(false);
    const invalid = normalizeFabricConfig({ ui: { haltOnEscape: "off" } });
    expect(invalid.ui.haltOnEscape).toBe(true);
  });

  it("normalizes agent-preview visibility and the global debounce", () => {
    expect(DEFAULT_FABRIC_CONFIG.ui.showAgentToolPreview).toBe(true);
    expect(DEFAULT_FABRIC_CONFIG.ui.updateDebounceMs).toBe(100);
    expect(
      normalizeFabricConfig({
        ui: { showAgentToolPreview: false, updateDebounceMs: 0 },
      }).ui,
    ).toMatchObject({ showAgentToolPreview: false, updateDebounceMs: 0 });
    expect(
      normalizeFabricConfig({ ui: { updateDebounceMs: -10 } }).ui.updateDebounceMs,
    ).toBe(0);
    expect(
      normalizeFabricConfig({ ui: { updateDebounceMs: 99_999 } }).ui.updateDebounceMs,
    ).toBe(2_000);
    expect(
      normalizeFabricConfig({
        ui: { showAgentToolPreview: "off", updateDebounceMs: "fast" },
      }).ui,
    ).toMatchObject({ showAgentToolPreview: true, updateDebounceMs: 100 });
  });

  it("accepts legacy ui keys as fallback for renamed settings", () => {
    expect(
      normalizeFabricConfig({ ui: { showNestedToolCalls: false } }).ui.showAgentToolPreview,
    ).toBe(false);
    expect(
      normalizeFabricConfig({
        ui: { showNestedToolCalls: false, showAgentToolPreview: true },
      }).ui.showAgentToolPreview,
    ).toBe(true);
    expect(
      normalizeFabricConfig({ ui: { nestedToolDebounceMs: 42 } }).ui.updateDebounceMs,
    ).toBe(42);
    expect(
      normalizeFabricConfig({ ui: { nestedToolDebounceMs: 42, updateDebounceMs: 7 } }).ui
        .updateDebounceMs,
    ).toBe(7);
  });

  it("normalizes strict Schema mode, transaction bounds, and trusted command definitions", () => {
    const config = normalizeFabricConfig({
      schema: {
        mode: "enforce",
        certificateTtlMs: 1,
        maxFiles: 10_000,
        maxBytes: Number.MAX_SAFE_INTEGER,
        trustedCommands: {
          tests: {
            command: "pnpm",
            args: ["test", 42, "--run"] as unknown[],
            shell: true,
            timeoutMs: 999_999,
          },
          "bad name": { command: "ignored" },
          empty: { command: " " },
        },
      },
    });
    expect(config.schema).toEqual({
      mode: "enforce",
      certificateTtlMs: 1_000,
      maxFiles: 1_000,
      maxBytes: 100 * 1024 * 1024,
      trustedCommands: {
        tests: {
          command: "pnpm",
          args: [],
          shell: true,
          timeoutMs: 300_000,
        },
      },
    });
    expect(normalizeFabricConfig({ schema: { mode: "strict" } }).schema.mode).toBe("off");
    expect(DEFAULT_FABRIC_CONFIG.schema.mode).toBe("off");
  });

  it("forces fabric_exec to be the only capture visibility exception in enforce mode", () => {
    const capture = effectiveToolCaptureConfig({
      fullCodeMode: false,
      schema: { ...DEFAULT_FABRIC_CONFIG.schema, mode: "enforce" },
      capture: {
        ...DEFAULT_FABRIC_CONFIG.capture,
        enabled: false,
        hideFromModel: false,
        keepVisible: ["fabric_exec", "bash", "custom"],
      },
    });
    expect(capture).toMatchObject({
      enabled: true,
      hideFromModel: true,
      keepVisible: ["fabric_exec"],
    });
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
      JSON.stringify({ approvals: { network: "allow" }, agents: { maxConcurrent: 2 } }),
    );
    fs.writeFileSync(
      path.join(cwd, ".pi", "fabric.json"),
      JSON.stringify({ agents: { transport: "localterm" } }),
    );
    const location = { cwd, agentDir, projectTrusted: true };
    const config = loadFabricConfig(location);
    expect(config.approvals.network).toBe("allow");
    expect(config.agents.maxConcurrent).toBe(2);
    expect(config.agents.transport).toBe("localterm");

    const globalConfig = loadFabricConfigForScope(location, "global");
    expect(globalConfig.agents.maxConcurrent).toBe(2);
    expect(globalConfig.agents.transport).toBe("process");
    expect(loadFabricConfigForScope(location, "project").agents.transport).toBe("localterm");
  });

  it("updates the compaction engine environment across config re-initialization", () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    const projectConfig = path.join(cwd, ".pi", "fabric.json");
    fs.mkdirSync(path.dirname(projectConfig), { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(projectConfig, JSON.stringify({ compaction: { engine: "fabric" } }));

    loadFabricConfig({ cwd, agentDir, projectTrusted: true });
    expect(process.env.PI_FABRIC_COMPACTION_ENGINE).toBe("fabric");

    fs.writeFileSync(projectConfig, JSON.stringify({ compaction: { engine: "pi" } }));
    loadFabricConfig({ cwd, agentDir, projectTrusted: true });
    expect(process.env.PI_FABRIC_COMPACTION_ENGINE).toBeUndefined();
  });

  it("loads trusted commands only from trusted Fabric configuration", () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "fabric.json"),
      JSON.stringify({ schema: { trustedCommands: { global: { command: "node", args: ["--version"] } } } }),
    );
    fs.writeFileSync(
      path.join(cwd, ".pi", "fabric.json"),
      JSON.stringify({ schema: { trustedCommands: { project: { command: "git", args: ["status"] } } } }),
    );
    const untrusted = loadFabricConfig({ cwd, agentDir, projectTrusted: false });
    expect(Object.keys(untrusted.schema.trustedCommands)).toEqual(["global"]);
    const trusted = loadFabricConfig({ cwd, agentDir, projectTrusted: true });
    expect(Object.keys(trusted.schema.trustedCommands).sort()).toEqual(["global", "project"]);
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
      JSON.stringify({ agents: { transport: "localterm" } }),
    );

    const result = saveFabricConfig(
      { cwd, agentDir, projectTrusted: true },
      { agents: { maxConcurrent: 8 }, fullCodeMode: false },
    );

    expect(result.scope).toBe("project");
    expect(result.path).toBe(path.join(cwd, ".pi", "fabric.json"));
    const saved = JSON.parse(fs.readFileSync(path.join(cwd, ".pi", "fabric.json"), "utf8"));
    expect(saved).toEqual({
      configVersion: 3,
      agents: { transport: "localterm", maxConcurrent: 8 },
      fullCodeMode: false,
    });
    const config = loadFabricConfig({ cwd, agentDir, projectTrusted: true });
    expect(config.agents.maxConcurrent).toBe(8);
    expect(config.agents.transport).toBe("localterm");
    expect(config.fullCodeMode).toBe(false);
  });

  it("saves explicit global overrides from a trusted project", () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    const projectPath = path.join(cwd, ".pi", "fabric.json");
    fs.writeFileSync(projectPath, JSON.stringify({ fullCodeMode: false }));

    const result = saveFabricConfig(
      { cwd, agentDir, projectTrusted: true, scope: "global" },
      { executor: { timeoutMs: 45_000 } },
    );

    expect(result).toEqual({ scope: "global", path: path.join(agentDir, "fabric.json") });
    expect(JSON.parse(fs.readFileSync(path.join(agentDir, "fabric.json"), "utf8"))).toEqual({
      configVersion: 3,
      executor: { timeoutMs: 45_000 },
    });
    expect(JSON.parse(fs.readFileSync(projectPath, "utf8"))).toEqual({ fullCodeMode: false });
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
    expect(saved).toEqual({ configVersion: 3, executor: { timeoutMs: 30_000 } });
  });

  it("rejects explicit project saves for untrusted projects", () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");

    expect(() =>
      saveFabricConfig(
        { cwd, agentDir, projectTrusted: false, scope: "project" },
        { fullCodeMode: false },
      )
    ).toThrow("Cannot save project Fabric configuration for an untrusted project");
    expect(fs.existsSync(path.join(cwd, ".pi", "fabric.json"))).toBe(false);
  });

  it("persists and clears the dedicated prewalk model", () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    const location = { cwd, agentDir, projectTrusted: true };

    saveFabricConfig(location, {
      prewalk: { model: "anthropic/claude-sonnet-4-5" },
    });
    expect(loadFabricConfig(location).prewalk.model).toBe(
      "anthropic/claude-sonnet-4-5",
    );

    saveFabricConfig(location, { prewalk: { model: "" } });
    expect(loadFabricConfig(location).prewalk).toEqual({
      mode: "in-place",
      alwaysRearm: false,
      compactOnReturn: true,
    });
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
        agents: { transport: "tmux", defaultTools: ["read", "bash"] },
        capture: { defaultRisk: "read", keepVisible: ["fabric_exec"] },
      }),
    );

    saveFabricConfig(
      { cwd, agentDir, projectTrusted: true },
      {
        agents: { defaultTools: ["read", "edit", "grep"] },
        capture: { keepVisible: ["fabric_exec", "custom-tool"] },
      },
    );

    const saved = JSON.parse(fs.readFileSync(path.join(cwd, ".pi", "fabric.json"), "utf8"));
    // Arrays are replaced, not concatenated; sibling object keys are preserved.
    expect(saved.agents).toEqual({ transport: "tmux", defaultTools: ["read", "edit", "grep"] });
    expect(saved.capture).toEqual({
      defaultRisk: "read",
      keepVisible: ["fabric_exec", "custom-tool"],
    });
    const config = loadFabricConfig({ cwd, agentDir, projectTrusted: true });
    expect(config.agents.defaultTools).toEqual(["read", "edit", "grep"]);
    expect(config.capture.keepVisible).toEqual(["fabric_exec", "custom-tool"]);
    expect(config.agents.transport).toBe("tmux");
  });

  it("defaults the agent timeout to 60 minutes and clamps to the 24-hour bound", () => {
    expect(DEFAULT_FABRIC_CONFIG.agents.timeoutMs).toBe(3_600_000);
    expect(normalizeFabricConfig({}).agents.timeoutMs).toBe(3_600_000);
    expect(
      normalizeFabricConfig({ agents: { timeoutMs: 99_999_999 } }).agents.timeoutMs,
    ).toBe(86_400_000);
    expect(
      normalizeFabricConfig({ agents: { timeoutMs: 1_200_000 } }).agents.timeoutMs,
    ).toBe(1_200_000);
  });

  it("accepts arbitrary non-negative safe agent depths", () => {
    expect(DEFAULT_FABRIC_CONFIG.agents.maxDepth).toBe(2);
    expect(normalizeFabricConfig({ agents: { maxDepth: 64 } }).agents.maxDepth).toBe(64);
    expect(normalizeFabricConfig({ agents: { maxDepth: -1 } }).agents.maxDepth).toBe(0);
    expect(
      normalizeFabricConfig({ agents: { maxDepth: Number.MAX_VALUE } }).agents.maxDepth,
    ).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("normalizes the per-child token limit and treats zero as disabled", () => {
    expect(DEFAULT_FABRIC_CONFIG.agents.maxTokensPerChild).toBe(0);
    const set = normalizeFabricConfig({ agents: { maxTokensPerChild: 50_000 } });
    expect(set.agents.maxTokensPerChild).toBe(50_000);
    const negative = normalizeFabricConfig({ agents: { maxTokensPerChild: -5 } });
    expect(negative.agents.maxTokensPerChild).toBe(0);
    const huge = normalizeFabricConfig({ agents: { maxTokensPerChild: Number.MAX_VALUE } });
    expect(huge.agents.maxTokensPerChild).toBe(100_000_000);
  });
});
