import fs from "node:fs";
import path from "node:path";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index].slice(2), process.argv[index + 1]);
}
const statusFile = args.get("status-file");
const taskFile = args.get("task-file");
const schemaFile = args.get("schema-file");
const schema = schemaFile ? JSON.parse(fs.readFileSync(schemaFile, "utf8")) : undefined;
const directive = schema?.properties?.action
  ? { action: "message", message: "fake actor advice" }
  : undefined;
const now = Date.now();
const record = {
  id: args.get("id"),
  name: args.get("name"),
  task: fs.readFileSync(taskFile, "utf8"),
  status: "completed",
  transport: args.get("transport"),
  fullCodeMode: args.get("full-code-mode"),
  cwd: args.get("cwd"),
  startedAt: now,
  updatedAt: now,
  finishedAt: now,
  turns: 1,
  toolCalls: 0,
  text: directive ? JSON.stringify(directive) : "fake worker complete",
  ...(directive ? { value: directive } : {}),
  exitCode: 0,
  usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0 },
};
fs.mkdirSync(path.dirname(statusFile), { recursive: true });
fs.writeFileSync(statusFile, JSON.stringify(record));
