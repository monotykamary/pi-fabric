import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CURRENT_FABRIC_CONFIG_VERSION,
  migrateFabricConfigDocument,
} from "../src/config-migrations.js";
import { loadFabricConfig, saveFabricConfig } from "../src/config.js";

const roots: string[] = [];

const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-migration-"));
  roots.push(root);
  const cwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  return {
    cwd,
    agentDir,
    globalPath: path.join(agentDir, "fabric.json"),
    projectPath: path.join(cwd, ".pi", "fabric.json"),
  };
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Fabric configuration migrations", () => {
  it("migrates the legacy agent section without mutating its input", () => {
    const input = { subagents: { runner: "claude", defaultTools: ["read"] }, ui: { enabled: false } };
    const result = migrateFabricConfigDocument(input);

    expect(result).toMatchObject({
      fromVersion: 0,
      toVersion: CURRENT_FABRIC_CONFIG_VERSION,
      appliedVersions: [1],
      changed: true,
    });
    expect(result.document).toEqual({
      configVersion: 1,
      agents: { runner: "claude", defaultTools: ["read"] },
      ui: { enabled: false },
    });
    expect(input).toHaveProperty("subagents");
  });

  it("merges both section names with the canonical section taking precedence", () => {
    const result = migrateFabricConfigDocument({
      subagents: { runner: "pi", claude: { binary: "old", model: "claude/old" }, defaultTools: ["bash"] },
      agents: { runner: "claude", claude: { binary: "new" }, defaultTools: ["read"] },
    });

    expect(result.document.agents).toEqual({
      runner: "claude",
      claude: { binary: "new", model: "claude/old" },
      defaultTools: ["read"],
    });
    expect(result.document).not.toHaveProperty("subagents");
  });

  it("rejects an ambiguous malformed canonical section instead of discarding legacy values", () => {
    expect(() =>
      migrateFabricConfigDocument({ subagents: { maxConcurrent: 6 }, agents: false }),
    ).toThrow(/malformed agents section/);
  });

  it("rejects invalid, future, and legacy keys in current documents", () => {
    expect(() => migrateFabricConfigDocument({ configVersion: -1 })).toThrow(/non-negative integer/);
    expect(() => migrateFabricConfigDocument({ configVersion: 2 })).toThrow(/newer than supported/);
    expect(() =>
      migrateFabricConfigDocument({ configVersion: 1, subagents: {} }),
    ).toThrow(/removed key/);
  });

  it("migrates each config layer before applying project precedence", () => {
    const paths = fixture();
    fs.writeFileSync(paths.globalPath, JSON.stringify({ agents: { runner: "claude", maxConcurrent: 2 } }));
    fs.writeFileSync(paths.projectPath, JSON.stringify({ subagents: { runner: "pi", transport: "tmux" } }));

    const config = loadFabricConfig({ cwd: paths.cwd, agentDir: paths.agentDir, projectTrusted: true });
    expect(config.agents).toMatchObject({ runner: "pi", transport: "tmux", maxConcurrent: 2 });
    expect(JSON.parse(fs.readFileSync(paths.globalPath, "utf8"))).toMatchObject({ configVersion: 1, agents: { runner: "claude" } });
    expect(JSON.parse(fs.readFileSync(paths.projectPath, "utf8"))).toEqual({
      configVersion: 1,
      agents: { runner: "pi", transport: "tmux" },
    });
  });

  it("does not inspect or migrate an untrusted project config", () => {
    const paths = fixture();
    const legacy = JSON.stringify({ subagents: { maxConcurrent: 9 } });
    fs.writeFileSync(paths.projectPath, legacy);

    const config = loadFabricConfig({ cwd: paths.cwd, agentDir: paths.agentDir, projectTrusted: false });
    expect(config.agents.maxConcurrent).not.toBe(9);
    expect(fs.readFileSync(paths.projectPath, "utf8")).toBe(legacy);
  });

  it("does not rewrite an already-current config during load", () => {
    const paths = fixture();
    const current = JSON.stringify({ configVersion: 1, agents: { maxConcurrent: 3 } }, null, 2) + "\n";
    fs.writeFileSync(paths.globalPath, current);
    const before = fs.statSync(paths.globalPath).mtimeMs;

    loadFabricConfig({ cwd: paths.cwd, agentDir: paths.agentDir, projectTrusted: false });

    expect(fs.readFileSync(paths.globalPath, "utf8")).toBe(current);
    expect(fs.statSync(paths.globalPath).mtimeMs).toBe(before);
  });

  it("migrates a legacy target while saving a canonical partial", () => {
    const paths = fixture();
    fs.writeFileSync(paths.projectPath, JSON.stringify({ subagents: { transport: "screen" } }));

    saveFabricConfig(
      { cwd: paths.cwd, agentDir: paths.agentDir, projectTrusted: true },
      { agents: { maxConcurrent: 7 } },
    );

    expect(JSON.parse(fs.readFileSync(paths.projectPath, "utf8"))).toEqual({
      configVersion: 1,
      agents: { transport: "screen", maxConcurrent: 7 },
    });
  });

  it.skipIf(process.platform === "win32")(
    "migrates a symlink target without replacing the configuration symlink",
    () => {
      const paths = fixture();
      const target = path.join(path.dirname(paths.globalPath), "shared.json");
      fs.writeFileSync(target, JSON.stringify({ subagents: { maxConcurrent: 5 } }));
      fs.symlinkSync(target, paths.globalPath);

      const config = loadFabricConfig({
        cwd: paths.cwd,
        agentDir: paths.agentDir,
        projectTrusted: false,
      });

      expect(config.agents.maxConcurrent).toBe(5);
      expect(fs.lstatSync(paths.globalPath).isSymbolicLink()).toBe(true);
      expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual({
        configVersion: 1,
        agents: { maxConcurrent: 5 },
      });
    },
  );

  it("preserves existing file permissions during migration", () => {
    const paths = fixture();
    fs.writeFileSync(paths.globalPath, JSON.stringify({ agents: { maxConcurrent: 5 } }), { mode: 0o640 });

    loadFabricConfig({ cwd: paths.cwd, agentDir: paths.agentDir, projectTrusted: false });

    expect(fs.statSync(paths.globalPath).mode & 0o777).toBe(0o640);
  });

  it("rejects obsolete or caller-controlled migration metadata on save", () => {
    const paths = fixture();
    const options = { cwd: paths.cwd, agentDir: paths.agentDir, projectTrusted: true };
    expect(() => saveFabricConfig(options, { subagents: {} })).toThrow(/current schema/);
    expect(() => saveFabricConfig(options, { configVersion: 1 })).toThrow(/current schema/);
  });
});
