import fs from "node:fs";
import path from "node:path";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key || !key.startsWith("--") || value === undefined) continue;
  args.set(key.slice(2), value);
}

const statusFile = args.get("status-file");
const logFile = args.get("log-file");

if (statusFile) {
  fs.writeFileSync(
    statusFile,
    JSON.stringify({
      id: args.get("id") ?? "",
      name: args.get("name") ?? "",
      task: "",
      status: "running",
      transport: "process",
      cwd: args.get("cwd") ?? "",
      startedAt: Date.now(),
      updatedAt: Date.now(),
      turns: 0,
      toolCalls: 0,
      text: "",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      logFile: logFile ?? "",
    }),
  );
}

if (logFile) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(
    logFile,
    JSON.stringify({ type: "tool_execution_start", toolName: "read" }) + "\n",
  );
  fs.appendFileSync(
    logFile,
    JSON.stringify({ type: "response", command: "prompt", success: false, error: "model rate limit exceeded" }) +
      "\n",
  );
  fs.appendFileSync(
    logFile,
    JSON.stringify({ type: "worker_stderr", text: "provider authentication failed\nretry required" }) + "\n",
  );
}

// Exit without writing a terminal status, simulating a worker that died mid-run.
process.exit(0);
