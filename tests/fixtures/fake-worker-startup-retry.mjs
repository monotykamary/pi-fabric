import fs from "node:fs";
import path from "node:path";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index].slice(2), process.argv[index + 1]);
}
const statusFile = args.get("status-file");
const taskFile = args.get("task-file");
if (!statusFile || !taskFile) process.exit(2);
const task = fs.readFileSync(taskFile, "utf8");
const marker = path.join(path.dirname(statusFile), "startup-attempts");
const attempts = fs.existsSync(marker) ? Number(fs.readFileSync(marker, "utf8")) + 1 : 1;
fs.writeFileSync(marker, String(attempts));
const now = Date.now();
const failed = attempts === 1;
fs.writeFileSync(
  statusFile,
  JSON.stringify({
    id: args.get("id"),
    name: args.get("name"),
    task,
    status: failed ? "failed" : "completed",
    runner: args.get("runner") ?? "pi",
    transport: args.get("transport"),
    cwd: args.get("cwd"),
    startedAt: now,
    updatedAt: now,
    finishedAt: now,
    turns: failed ? 0 : 1,
    toolCalls: 0,
    text: failed ? "" : "startup retry recovered",
    ...(failed ? { error: "No API key found for openai-codex" } : {}),
    exitCode: 0,
    usage: failed
      ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
      : { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 },
  }),
);
