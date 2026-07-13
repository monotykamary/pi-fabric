import fs from "node:fs";
import path from "node:path";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index].slice(2), process.argv[index + 1]);
}

const statusFile = args.get("status-file");
const taskFile = args.get("task-file");
const task = fs.readFileSync(taskFile, "utf8");
const match = task.match(/COST ([\d.]+)/);
const cost = match ? Number(match[1]) : 0;
const now = Date.now();
const record = {
  id: args.get("id"),
  name: args.get("name"),
  task,
  status: "completed",
  transport: args.get("transport"),
  cwd: args.get("cwd"),
  startedAt: now,
  updatedAt: now,
  finishedAt: now,
  turns: 1,
  toolCalls: 0,
  text: "budget worker complete",
  exitCode: 0,
  usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost },
};
fs.mkdirSync(path.dirname(statusFile), { recursive: true });
fs.writeFileSync(statusFile, JSON.stringify(record));
