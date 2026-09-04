import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { AgentManager } from "../src/agents/manager.js";
import { agentParticipantRecords } from "../src/topology/records.js";

const managers: AgentManager[] = [];
const roots: string[] = [];
const worktrees: Array<{ repository: string; path: string; branch: string }> = [];

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// Git normalizes worktree paths its own way (forward slashes, Windows 8.3
// short names resolved), while Node never expands the short form from
// os.tmpdir(), so path text can never match there. Assert the worktree's
// branch registration instead — that is what these checks mean.
const worktreeBranches = (repository: string): string[] =>
  git(repository, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("branch refs/heads/"))
    .map((line) => line.slice("branch refs/heads/".length));

const initRepository = (prefix: string, relativeDirectory?: string): string => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(repository);
  git(repository, "init", "-q");
  git(repository, "config", "user.email", "pi-fabric-tests@example.invalid");
  git(repository, "config", "user.name", "Pi Fabric tests");
  fs.writeFileSync(path.join(repository, "README.md"), "test repository\n");
  if (relativeDirectory) {
    const directory = path.join(repository, relativeDirectory);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "module.ts"), "export const test = true;\n");
  }
  git(repository, "add", ".");
  git(repository, "commit", "-qm", "initial");
  return fs.realpathSync.native(repository);
};

const workerSource = `
import fs from "node:fs";
import path from "node:path";
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index].slice(2), process.argv[index + 1]);
}
const statusFile = args.get("status-file");
const lifecycleFile = args.get("lifecycle-file");
const logFile = args.get("log-file");
const task = fs.readFileSync(args.get("task-file"), "utf8");
await new Promise((resolve) => setTimeout(resolve, 25));
const now = Date.now();
const record = {
  id: args.get("id"),
  name: args.get("name"),
  task,
  status: "completed",
  runner: args.get("runner") || "pi",
  transport: args.get("transport"),
  cwd: process.cwd(),
  projectRoot: args.get("project-root"),
  meshRoot: args.get("mesh-root"),
  startedAt: now,
  updatedAt: now,
  finishedAt: now,
  turns: 1,
  toolCalls: 0,
  text: "cwd worker complete",
  exitCode: 0,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 },
};
fs.mkdirSync(path.dirname(statusFile), { recursive: true });
fs.writeFileSync(statusFile, JSON.stringify(record));
fs.writeFileSync(logFile, JSON.stringify({ type: "agent_start" }) + "\\n");
fs.writeFileSync(lifecycleFile, JSON.stringify({ version: 1, event: "pi.agent_settled", occurredAt: now }) + "\\n");
`;

const createWorker = (root: string): string => {
  const worker = path.join(root, "cwd-worker.mjs");
  fs.writeFileSync(worker, workerSource);
  return worker;
};

const createManager = (
  cwd: string,
  runRoot: string,
  workerPath: string,
  options: ConstructorParameters<typeof AgentManager>[2] = {},
): AgentManager => {
  const manager = new AgentManager(cwd, { ...DEFAULT_FABRIC_CONFIG.agents, timeoutMs: 10_000 }, {
    workerPath,
    runRoot,
    fullCodeMode: false,
    ...options,
  });
  managers.push(manager);
  return manager;
};

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  for (const worktree of worktrees.splice(0)) {
    try {
      git(worktree.repository, "worktree", "remove", "--force", worktree.path);
    } catch {
      // The test may already have cleaned this worktree.
    }
    try {
      git(worktree.repository, "branch", "-D", worktree.branch);
    } catch {
      // The test may already have deleted this branch.
    }
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("one-shot agent cwd", () => {
  it("canonicalizes absolute, relative, and symlink paths through launch and reporting", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-cwd-"));
    roots.push(root);
    const target = path.join(root, "target");
    fs.mkdirSync(target);
    const link = path.join(root, "target-link");
    fs.symlinkSync(target, link, "dir");
    const parent = fs.realpathSync(root);
    const worker = createWorker(root);
    const completions: Array<{ cwd: string }> = [];
    const manager = createManager(parent, path.join(root, "runs"), worker, {
      projectRoot: parent,
      meshRoot: path.join(root, "mesh"),
      onBackgroundComplete: (result) => completions.push({ cwd: result.cwd }),
    });

    const handle = await manager.spawn({ task: "inspect cwd", cwd: "target-link", transport: "process" });
    const canonical = fs.realpathSync(target);
    expect(handle.cwd).toBe(canonical);
    manager.detachSignal(handle.id);
    await new Promise<void>((resolve) => {
      const check = () => (completions.length > 0 ? resolve() : setTimeout(check, 10));
      check();
    });
    const result = await manager.wait(handle.id);

    expect(result.cwd).toBe(canonical);
    expect((manager.status(handle.id) as { cwd: string }).cwd).toBe(canonical);
    expect(manager.readLog(handle.id).status?.cwd).toBe(canonical);
    expect(completions).toEqual([{ cwd: canonical }]);
    expect((result as unknown as { projectRoot: string }).projectRoot).toBe(parent);
    expect((result as unknown as { meshRoot: string }).meshRoot).toBe(path.join(root, "mesh"));
    expect(
      agentParticipantRecords(
        [manager.status(handle.id)],
        "root:test",
        "host:test",
        "identity:test",
        "root:test",
        new Map(),
      )[0]?.cwd,
    ).toBe(canonical);
  });

  it("keeps a symlinked parent cwd when the request omits cwd", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-cwd-"));
    roots.push(root);
    const target = path.join(root, "target");
    fs.mkdirSync(target);
    const parent = path.join(root, "parent-link");
    fs.symlinkSync(target, parent, "dir");
    const manager = createManager(parent, path.join(root, "runs"), createWorker(root));

    const handle = await manager.spawn({ task: "use parent cwd", transport: "process" });
    expect(handle.cwd).toBe(parent);
    const result = await manager.wait(handle.id);

    expect(result.cwd).toBe(parent);
    expect((manager.status(handle.id) as { cwd: string }).cwd).toBe(parent);
  });

  it("rejects cwd on recursive requests before creating a run directory", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-cwd-recursive-"));
    roots.push(root);
    const runRoot = path.join(root, "runs");
    const manager = createManager(root, runRoot, createWorker(root));

    await expect(
      manager.spawn({ task: "must remain recursive", cwd: root, recursive: true, transport: "process" }),
    ).rejects.toThrow(/only for non-recursive agents/);
    expect(fs.existsSync(runRoot)).toBe(false);
  });

  it("rejects invalid cwd values before creating a run directory", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-cwd-"));
    roots.push(root);
    const runRoot = path.join(root, "runs");
    const worker = createWorker(root);
    let prepared = false;
    const manager = createManager(root, runRoot, worker, {
      preparePiModel: async () => {
        prepared = true;
      },
    });
    const missing = path.join(root, "missing-target");
    const file = path.join(root, "not-a-directory");
    fs.writeFileSync(file, "file");

    await expect(
      manager.spawn({ task: "missing", cwd: missing, model: "test/model", transport: "process" }),
    ).rejects.toThrow(JSON.stringify(missing));
    await expect(manager.spawn({ task: "empty", cwd: "   ", transport: "process" })).rejects.toThrow(/path must not be empty/);
    await expect(manager.spawn({ task: "file", cwd: file, transport: "process" })).rejects.toThrow(JSON.stringify(file));
    expect(prepared).toBe(false);
    expect(fs.existsSync(runRoot)).toBe(false);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "rejects an inaccessible cwd before creating a run directory",
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-cwd-inaccessible-"));
      roots.push(root);
      const inaccessible = path.join(root, "inaccessible");
      fs.mkdirSync(inaccessible);
      fs.chmodSync(inaccessible, 0o000);
      const runRoot = path.join(root, "runs");
      const manager = createManager(root, runRoot, createWorker(root));
      try {
        await expect(
          manager.spawn({ task: "must fail", cwd: inaccessible, transport: "process" }),
        ).rejects.toThrow(inaccessible);
        expect(fs.existsSync(runRoot)).toBe(false);
      } finally {
        fs.chmodSync(inaccessible, 0o700);
      }
    },
  );

  it("reuses the selected repository and subdirectory for worktree launches", async () => {
    const parent = initRepository("pi-fabric-parent-repo-");
    const target = initRepository("pi-fabric-target-repo-", path.join("packages", "app"));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-cwd-worktree-"));
    roots.push(root);
    const manager = createManager(parent, path.join(root, "runs"), createWorker(root), {
      projectRoot: parent,
      meshRoot: path.join(root, "mesh"),
    });
    const selected = path.join(target, "packages", "app");
    const parentWorktreesBefore = git(parent, "worktree", "list", "--porcelain");
    let result: Awaited<ReturnType<AgentManager["run"]>> | undefined;

    try {
      result = await manager.run({
        task: "work in target repository",
        cwd: selected,
        worktree: true,
        transport: "process",
      });
      const worktree = result.worktree;
      expect(worktree).toBeDefined();
      worktrees.push({
        repository: target,
        path: worktree!,
        branch: result.branch!,
      });
      expect(fs.realpathSync(worktree!)).toBe(
        fs.realpathSync(path.join(target, ".pi", "fabric", "worktrees", result.id)),
      );
      expect(result.cwd).toBe(fs.realpathSync(path.join(worktree!, "packages", "app")));
      expect(fs.existsSync(result.cwd)).toBe(true);
      expect((result as unknown as { projectRoot: string }).projectRoot).toBe(parent);
      expect((result as unknown as { meshRoot: string }).meshRoot).toBe(path.join(root, "mesh"));
      expect(git(parent, "worktree", "list", "--porcelain")).toBe(parentWorktreesBefore);
      expect(worktreeBranches(target)).toContain(result.branch!);
    } finally {
      if (result) await manager.cleanup(result.id, true);
    }
  });

  it("keeps the generated worktree root when cwd is omitted from a subdirectory manager", async () => {
    const repository = initRepository("pi-fabric-default-worktree-repo-", path.join("packages", "app"));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-default-worktree-"));
    roots.push(root);
    const manager = createManager(
      path.join(repository, "packages", "app"),
      path.join(root, "runs"),
      createWorker(root),
    );
    let result: Awaited<ReturnType<AgentManager["run"]>> | undefined;

    try {
      result = await manager.run({ task: "use the default worktree root", worktree: true, transport: "process" });
      expect(result.worktree).toBeDefined();
      expect(result.cwd).toBe(fs.realpathSync(result.worktree!));
    } finally {
      if (result) await manager.cleanup(result.id, true);
    }
  });

  it("does not create a worktree from the parent repository for a non-Git cwd", async () => {
    const parent = initRepository("pi-fabric-parent-repo-");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-cwd-nongit-"));
    roots.push(root);
    const selected = path.join(root, "not-a-repository");
    fs.mkdirSync(selected);
    const manager = createManager(parent, path.join(root, "runs"), createWorker(root));
    const before = git(parent, "worktree", "list", "--porcelain");

    await expect(
      manager.spawn({ task: "must fail", cwd: selected, worktree: true, transport: "process" }),
    ).rejects.toThrow(/requires a Git repository/);
    expect(git(parent, "worktree", "list", "--porcelain")).toBe(before);
  });

  it("retains the selected cwd across startup retries", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-cwd-retry-"));
    roots.push(root);
    const target = path.join(root, "target");
    fs.mkdirSync(target);
    const manager = createManager(
      root,
      path.join(root, "runs"),
      path.resolve("tests/fixtures/fake-worker-startup-retry.mjs"),
    );

    const result = await manager.run({ task: "Recover startup", cwd: "target", transport: "process" });

    expect(result.status).toBe("completed");
    expect(result.cwd).toBe(fs.realpathSync(target));
    expect(fs.readFileSync(path.join(manager.runDirectory(result.id)!, "startup-attempts"), "utf8")).toBe("2");
  });
});
