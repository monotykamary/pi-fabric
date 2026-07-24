import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocaltermTransport } from "../src/agents/transports/localterm-transport.js";

const temporaryDirectories: string[] = [];
const originalPath = process.env.PATH;
const originalLogFile = process.env.FAKE_LOCALTERM_LOG_FILE;

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalLogFile === undefined) delete process.env.FAKE_LOCALTERM_LOG_FILE;
  else process.env.FAKE_LOCALTERM_LOG_FILE = originalLogFile;
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const installFakeLocalterm = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-localterm-"));
  temporaryDirectories.push(directory);
  const logFile = path.join(directory, "calls.log");
  const executable = path.join(directory, "localterm");
  fs.writeFileSync(
    executable,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_LOCALTERM_LOG_FILE"
if [ "$2" = "new" ]; then
  printf '{"id":"session-1","pid":%s}\\n' "$PPID"
elif [ "$2" = "ls" ]; then
  printf '[]\\n'
fi
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${directory}${path.delimiter}${originalPath ?? ""}`;
  process.env.FAKE_LOCALTERM_LOG_FILE = logFile;
  return logFile;
};

describe.skipIf(process.platform === "win32")("LocaltermTransport", () => {
  it("checks a launched session by PID without spawning repeated LocalTerm CLI calls", async () => {
    const logFile = installFakeLocalterm();
    const transport = new LocaltermTransport();
    const handle = await transport.launch({
      id: "agent-id",
      name: "review worker",
      cwd: "/repo",
      workerPath: "/fabric/worker.js",
      workerArguments: ["--task-file", "/tmp/task.txt"],
    });

    expect(handle).toMatchObject({
      kind: "localterm",
      sessionId: "session-1",
      attachCommand: "localterm session attach session-1",
    });
    expect(fs.readFileSync(logFile, "utf8").trim().split("\n")).toHaveLength(1);

    await expect(handle.isAlive()).resolves.toBe(true);
    await expect(handle.isAlive()).resolves.toBe(true);
    expect(fs.readFileSync(logFile, "utf8").trim().split("\n")).toHaveLength(1);

    await handle.stop();
    expect(fs.readFileSync(logFile, "utf8")).toContain("session kill session-1");
  });
});
