import { execFile, spawn } from "node:child_process";

export interface ExecFileResult {
  stdout: string;
  stderr: string;
}

export const executeFile = (
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<ExecFileResult> =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
      },
      (error, stdout, stderr) => {
        if (error) {
          Object.assign(error, { stdout, stderr });
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });

export const commandAvailable = async (command: string): Promise<boolean> => {
  try {
    await executeFile("sh", ["-lc", `command -v ${shellQuote(command)}`], { timeoutMs: 2_000 });
    return true;
  } catch {
    return false;
  }
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

export const processIsAlive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const workerCommand = (workerPath: string, workerArguments: string[]): string =>
  [process.execPath, workerPath, ...workerArguments].map(shellQuote).join(" ");

export const spawnDetached = (
  workerPath: string,
  workerArguments: string[],
  cwd: string,
): { pid: number; stop(): Promise<void>; isAlive(): Promise<boolean> } => {
  const child = spawn(process.execPath, [workerPath, ...workerArguments], {
    cwd,
    detached: process.platform !== "win32",
    stdio: "ignore",
  });
  if (!child.pid) throw new Error("Failed to launch Fabric worker process");
  const pid = child.pid;
  child.unref();
  return {
    pid,
    async stop() {
      try {
        process.kill(process.platform === "win32" ? pid : -pid, "SIGTERM");
      } catch { /* process group already exited */ }
    },
    async isAlive() {
      return processIsAlive(pid);
    },
  };
};
