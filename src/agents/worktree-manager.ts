import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeFile } from "./transports/process-utils.js";

export interface WorktreeLease {
  gitRoot: string;
  path: string;
  /** Effective child cwd inside the generated worktree. */
  cwd: string;
  branch: string;
}

const safeLabel = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30) || "agent";

const isInside = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

export class WorktreeManager {
  readonly #leases = new Map<string, WorktreeLease>();

  async create(id: string, cwd: string, name: string): Promise<WorktreeLease> {
    let gitRoot: string;
    try {
      const output = (await executeFile("git", ["rev-parse", "--show-toplevel"], { cwd })).stdout.trim();
      if (!output) throw new Error("Git did not return a worktree root");
      gitRoot = fs.realpathSync(output);
    } catch {
      throw new Error("Worktree isolation requires a Git repository");
    }
    const sourceCwd = fs.realpathSync(cwd);
    const branch = `pi-fabric/${safeLabel(name)}-${id.slice(0, 8)}`;
    const parent = path.join(os.tmpdir(), "pi-fabric-worktrees");
    fs.mkdirSync(parent, { recursive: true });
    const worktreePath = path.join(parent, id);
    await executeFile("git", ["worktree", "add", "-b", branch, worktreePath, "HEAD"], {
      cwd: gitRoot,
      timeoutMs: 60_000,
    });
    const canonicalWorktreePath = fs.realpathSync(worktreePath);
    const relative = path.relative(gitRoot, sourceCwd);
    let effectiveCwd = canonicalWorktreePath;
    if (isInside(gitRoot, sourceCwd) && relative) {
      const candidate = path.join(canonicalWorktreePath, relative);
      try {
        const canonicalCandidate = fs.realpathSync(candidate);
        if (fs.statSync(canonicalCandidate).isDirectory() && isInside(canonicalWorktreePath, canonicalCandidate)) {
          effectiveCwd = canonicalCandidate;
        }
      } catch {
        // The selected subdirectory may be untracked or absent from HEAD;
        // use the valid worktree root in that case.
      }
    }
    const lease = { gitRoot, path: worktreePath, cwd: effectiveCwd, branch };
    this.#leases.set(id, lease);
    return lease;
  }

  get(id: string): WorktreeLease | undefined {
    return this.#leases.get(id);
  }

  async cleanup(id: string, deleteBranch = false): Promise<boolean> {
    const lease = this.#leases.get(id);
    if (!lease) return false;
    await executeFile("git", ["worktree", "remove", "--force", lease.path], {
      cwd: lease.gitRoot,
      timeoutMs: 60_000,
    });
    if (deleteBranch) {
      await executeFile("git", ["branch", "-D", lease.branch], {
        cwd: lease.gitRoot,
        timeoutMs: 30_000,
      });
    }
    this.#leases.delete(id);
    return true;
  }
}
